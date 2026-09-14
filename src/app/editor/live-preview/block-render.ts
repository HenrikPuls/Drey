import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import MarkdownIt from 'markdown-it';
import { pdfExtension } from '../../../../shared/asset-name';
import { clampEmbedWidth, parseImageEmbed, setEmbedWidth } from '../../../../shared/image-embed';
import { frontmatterEnd } from '../markdown-frontmatter';
import { fenceLang } from './fenced-code';
import { htmlTagBalance, sanitizeHtml } from './sanitize-html';
import {
  HtmlBlockWidget,
  ImagePreviewWidget,
  ImageWidget,
  MermaidWidget,
  PdfPreviewWidget,
  PdfWidget,
  TableWidget,
} from './widgets';

/**
 * The widget half of Live Preview (ADR-0009): constructs that cannot be
 * concealed in place -- GFM tables (rendered as a real `<table>`) and images
 * (rendered as an `<img>`) -- are replaced by widgets while the selection is
 * outside them; the selection touching the node swaps the widget back for
 * the raw Markdown.
 *
 * This lives in a `StateField`, not the conceal `ViewPlugin`, because block
 * decorations (the table) and tall inline widgets (images) must be known
 * before the view computes its vertical layout -- exactly the constraint
 * that sank the milestone-M3 prototype. The price is a whole-document tree
 * walk per doc/selection change instead of a viewport-only one; fine at
 * note sizes, and the walk only inspects node names.
 */

export interface LivePreviewConfig {
  /**
   * Maps a raw `![](url)` target to its ordered servable candidates
   * (note-relative first, then the vault-root reading), or an empty list
   * when it can't be trusted/resolved -- the component wires this to
   * `resolveVaultImageCandidates` with the active document's path. The
   * image widget walks the candidates on load errors.
   */
  resolveImage: (url: string) => readonly string[];
  /**
   * Opens a resolved image `src` in the full-app viewer (ADR-0026) --
   * the hover lens button on a rendered image. Optional: a surface that
   * doesn't want the lens (none today) omits it.
   */
  onOpenImage?: (src: string) => void;
  /**
   * Opens a rendered mermaid diagram (handed over as a `data:` SVG URL) in
   * the same viewer -- the hover lens on a diagram. Optional, like
   * `onOpenImage`.
   */
  onZoomDiagram?: (dataUrl: string) => void;
  /**
   * Opens a resolved PDF embed URL as a full PDF tab (ADR-0052) -- the
   * hover lens on a rendered PDF, handed the candidate that mounted.
   * Optional, like `onOpenImage`.
   */
  onOpenPdf?: (src: string) => void;
}

const PARSE_BUDGET_MS = 50;

/**
 * Table blocks are rendered through markdown-it (`html: false`, core GFM
 * tables + inline formatting inside cells) -- reusing the exact renderer the
 * old preview mode used for full fidelity, scoped to one block.
 */
const tableMd = new MarkdownIt({ html: false });

/**
 * HTML regions render with `html: true`: the region may interleave raw HTML
 * blocks with Markdown (a `<details>` body), and markdown-it stitches
 * exactly that back together. Its output never reaches the DOM without
 * `sanitizeHtml`.
 */
const htmlMd = new MarkdownIt({ html: true });

type EmbedKind = 'table' | 'mermaid' | 'image' | 'pdf' | 'html';

/**
 * One rendered embed found in the tree. `from`/`to` are the node range for
 * the touch test; `lineFrom`/`lineTo` are the whole-line span of the raw
 * source (what the reveal container wraps). `atom` builds the
 * `Decoration.replace` shown while the embed is NOT touched -- a thunk so a
 * touched table / diagram never pays for its markdown-it render. `preview`
 * (images only) builds the read-only render kept below the markup while the
 * source is revealed.
 */
interface Embed {
  kind: EmbedKind;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  atom: () => Range<Decoration>;
  preview: (() => Range<Decoration>) | null;
}

/**
 * Walks the tree once and collects every rendered embed (tables, `mermaid`
 * fences, images, merged HTML regions), past the frontmatter. Whether an
 * embed is currently revealed is decided later, in `buildBlockState`.
 */
function scanEmbeds(state: EditorState, config: LivePreviewConfig): Embed[] {
  const doc = state.doc;
  const fmEnd = frontmatterEnd(state.sliceDoc());
  const embeds: Embed[] = [];
  const htmlBlocks: { from: number; to: number }[] = [];

  const tree = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        if (node.from >= fmEnd) {
          // Block decorations must cover whole lines.
          const from = doc.lineAt(node.from).from;
          const to = doc.lineAt(node.to).to;
          const source = state.sliceDoc(node.from, node.to);
          embeds.push({
            kind: 'table',
            from: node.from,
            to: node.to,
            lineFrom: from,
            lineTo: to,
            atom: () =>
              Decoration.replace({
                widget: new TableWidget(tableMd.render(source), source),
                block: true,
              }).range(from, to),
            preview: null,
          });
        }
        return false;
      }
      if (node.name === 'FencedCode') {
        const infoNode = node.node.getChild('CodeInfo');
        const lang = fenceLang(infoNode ? state.sliceDoc(infoNode.from, infoNode.to) : '');
        if (lang === 'mermaid' && node.from >= fmEnd) {
          const textNode = node.node.getChild('CodeText');
          const body = textNode ? state.sliceDoc(textNode.from, textNode.to) : '';
          const from = doc.lineAt(node.from).from;
          const to = doc.lineAt(node.to).to;
          embeds.push({
            kind: 'mermaid',
            from: node.from,
            to: node.to,
            lineFrom: from,
            lineTo: to,
            atom: () =>
              Decoration.replace({
                widget: new MermaidWidget(body, config.onZoomDiagram),
                block: true,
              }).range(from, to),
            preview: null,
          });
        }
        return false; // never descend into a fence
      }
      if (node.name === 'Image') {
        if (node.from >= fmEnd) {
          // `node` is the iterate cursor -- its `from`/`to` are only valid
          // in this callback. Capture them before they move on.
          const nodeFrom = node.from;
          const nodeTo = node.to;
          const { alt, url, width, height } = parseImage(state, node.node);
          const srcs = url === null ? [] : config.resolveImage(url);
          const previewPos = doc.lineAt(nodeTo).to;
          // A `.pdf` reference embeds the built-in (PDFium) viewer instead
          // of an `<img>` (ADR-0052). The size suffix is parsed but
          // deliberately ignored -- a page viewer's width is the column.
          const isPdf = url !== null && pdfExtension(url) !== null;
          embeds.push({
            kind: isPdf ? 'pdf' : 'image',
            from: nodeFrom,
            to: nodeTo,
            lineFrom: doc.lineAt(nodeFrom).from,
            lineTo: previewPos,
            atom: () =>
              Decoration.replace({
                widget: isPdf
                  ? new PdfWidget(srcs, alt, url ?? '', config.onOpenPdf)
                  : new ImageWidget(
                      srcs,
                      alt,
                      width,
                      height,
                      config.onOpenImage,
                      url ?? '',
                    ),
              }).range(nodeFrom, nodeTo),
            // While the `![alt](path)` line is revealed, keep a read-only
            // render of the embed directly below it (owner's call). A
            // reference that doesn't resolve has nothing to mirror.
            preview:
              srcs.length === 0
                ? null
                : () =>
                    Decoration.widget({
                      widget: isPdf
                        ? new PdfPreviewWidget(srcs, alt)
                        : new ImagePreviewWidget(srcs, alt, width, height),
                      block: true,
                      side: 1,
                    }).range(previewPos),
          });
        }
        return false;
      }
      if (node.name === 'HTMLBlock') {
        // Collected, not decorated in place: regions are grouped below so a
        // `<details>` split across blank lines renders as ONE widget.
        if (node.from >= fmEnd) {
          htmlBlocks.push({ from: node.from, to: node.to });
        }
        return false;
      }
      return;
    },
  });

  // Embedded HTML renders sanitized (scripts/handlers stripped, img src
  // through the vault resolver); the raw markup comes back while the
  // selection is inside. CommonMark ends an HTML block at the first blank
  // line, so `<details>` + Markdown body + `</details>` arrive as separate
  // HTMLBlock nodes: a block that leaves tags open (`htmlTagBalance > 0`)
  // absorbs the following blocks -- Markdown between included, rendered by
  // markdown-it (`html: true`) -- until the tags balance out. Inline HTML
  // *within* a paragraph stays raw for now.
  for (let i = 0; i < htmlBlocks.length; i++) {
    let end = i;
    let balance = htmlTagBalance(state.sliceDoc(htmlBlocks[i].from, htmlBlocks[i].to));
    while (balance > 0 && end + 1 < htmlBlocks.length) {
      end++;
      balance += htmlTagBalance(state.sliceDoc(htmlBlocks[end].from, htmlBlocks[end].to));
    }
    const regionFrom = htmlBlocks[i].from;
    const regionTo = htmlBlocks[end].to;
    i = end;

    const source = state.sliceDoc(regionFrom, regionTo);
    // HTML-embedded `<img>` keeps the primary (note-relative) candidate —
    // the candidate walk is the Markdown image widget's concern.
    const html = sanitizeHtml(htmlMd.render(source), {
      resolveImage: (url) => config.resolveImage(url)[0] ?? null,
    });
    if (!html.trim()) {
      continue; // e.g. a stray closing tag -- not an embed, leave it raw
    }
    const from = doc.lineAt(regionFrom).from;
    const to = doc.lineAt(regionTo).to;
    embeds.push({
      kind: 'html',
      from: regionFrom,
      to: regionTo,
      lineFrom: from,
      lineTo: to,
      atom: () =>
        Decoration.replace({
          widget: new HtmlBlockWidget(html, source),
          block: true,
        }).range(from, to),
      preview: null,
    });
  }

  return embeds;
}

// The rounded container drawn around a revealed embed's raw source lines,
// so the active-line highlight reads as "in scope" rather than full-bleed.
// Cached: decorations compare by identity across rebuilds (cf. `conceal.ts`).
const revealLine = Decoration.line({ class: 'lp-reveal' });
const revealLineFirst = Decoration.line({ class: 'lp-reveal lp-reveal-first' });
const revealLineLast = Decoration.line({ class: 'lp-reveal lp-reveal-last' });
const revealLineSole = Decoration.line({ class: 'lp-reveal lp-reveal-first lp-reveal-last' });

interface BlockState {
  /** replace/widget decorations for un-revealed embeds; also the atomic set. */
  atoms: DecorationSet;
  /** the reveal container + image mirror; never atomic. */
  reveal: DecorationSet;
}

/**
 * One tree walk (`scanEmbeds`), partitioned by whether each embed's node is
 * currently touched by the selection: not touched -> the `atoms` layer
 * (rendered widget, also fed to `EditorView.atomicRanges`); touched -> the
 * `reveal` layer (the `.lp-reveal*` line container, plus an
 * `ImagePreviewWidget` below an image's markup), which must stay
 * non-atomic so the caret can sit in the raw source.
 */
function buildBlockState(state: EditorState, config: LivePreviewConfig): BlockState {
  const doc = state.doc;
  const touches = (from: number, to: number): boolean =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);

  const atoms: Range<Decoration>[] = [];
  const reveal: Range<Decoration>[] = [];

  for (const embed of scanEmbeds(state, config)) {
    if (!touches(embed.from, embed.to)) {
      atoms.push(embed.atom());
      continue;
    }
    const first = doc.lineAt(embed.lineFrom);
    const last = doc.lineAt(embed.lineTo);
    if (first.number === last.number) {
      reveal.push(revealLineSole.range(first.from));
    } else {
      reveal.push(revealLineFirst.range(first.from));
      for (let n = first.number + 1; n < last.number; n++) {
        reveal.push(revealLine.range(doc.line(n).from));
      }
      reveal.push(revealLineLast.range(last.from));
    }
    if (embed.preview) {
      reveal.push(embed.preview());
    }
  }

  return {
    atoms: Decoration.set(atoms, true),
    reveal: Decoration.set(reveal, true),
  };
}

/**
 * The widget layer: a `Decoration.replace` per un-revealed table / diagram /
 * image / HTML region. Also the source of `EditorView.atomicRanges`.
 */
export function blockDecorations(state: EditorState, config: LivePreviewConfig): DecorationSet {
  return buildBlockState(state, config).atoms;
}

/**
 * The reveal layer (ADR-0009 "Later change"): while a text embed's source is
 * revealed, its raw lines get a rounded container (`.lp-reveal*` line
 * decorations) and an image additionally keeps a read-only render
 * (`ImagePreviewWidget`) below the markup. Separate from `blockDecorations`
 * because these decorations must NOT feed `EditorView.atomicRanges`.
 */
export function revealDecorations(state: EditorState, config: LivePreviewConfig): DecorationSet {
  return buildBlockState(state, config).reveal;
}

/**
 * Alt text sits between the first two link marks (`![` and `]`); an
 * Obsidian-style `|W` / `|WxH` suffix on it sets the display size and is
 * stripped from `alt` (`shared/image-embed.ts`). `altFrom`/`altTo` are the
 * exact doc offsets of that span -- the resize handle rewrites it in place.
 */
function parseImage(
  state: EditorState,
  node: SyntaxNode,
): {
  alt: string;
  url: string | null;
  width: number | null;
  height: number | null;
  altFrom: number;
  altTo: number;
} {
  const url = node.getChild('URL');
  const marks = node.getChildren('LinkMark');
  const altFrom = marks.length >= 2 ? marks[0].to : node.from;
  const altTo = marks.length >= 2 ? marks[1].from : node.from;
  const { alt, width, height } = parseImageEmbed(state.sliceDoc(altFrom, altTo));
  // CommonMark angle-bracket destination `![](<path with spaces>)` -- the
  // sliced `URL` node keeps the `<>`; drop them so the resolver sees the
  // bare path.
  const rawUrl = url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '') : null;
  return { alt, url: rawUrl, width, height, altFrom, altTo };
}

export function livePreviewBlocks(config: LivePreviewConfig): Extension {
  const field = StateField.define<BlockState>({
    create: (state) => buildBlockState(state, config),
    update: (value, tr) =>
      tr.docChanged || tr.selection ? buildBlockState(tr.state, config) : value,
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.atoms),
      EditorView.decorations.from(f, (v) => v.reveal),
      // Only the widget layer is atomic: arrow keys step over a rendered
      // table / diagram / image in one move instead of the selection
      // snapping to offset 0 on a block widget. The reveal layer (the
      // source container and the image mirror) stays non-atomic so the
      // caret can sit in the raw markup.
      EditorView.atomicRanges.of((view) => view.state.field(f, false)?.atoms ?? Decoration.none),
    ],
  });
  // The `</>` button on a rendered table / HTML block / image moves the
  // cursor into it, which reveals the raw source (the selection then
  // touches the node). Only the button: other clicks belong to the widget
  // content (toggling a <details>, selecting table text) -- its
  // `ignoreEvent` keeps CodeMirror out of those. Exception: a mermaid
  // *error* box is clickable anywhere -- the whole point is to get back
  // into the fence.
  const clickToReveal = EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      if (
        !target?.closest('.lp-edit') &&
        !target?.closest('.lp-mermaid-error') &&
        !target?.closest('.lp-pdf-error')
      ) {
        return false;
      }
      const widget = target.closest('.lp-table, .lp-html, .lp-mermaid, .lp-image, .lp-pdf');
      if (!widget) {
        return false;
      }
      event.preventDefault();
      // `posAtDOM` on a *block* widget resolves to the position just before
      // it (the blank line above the fence), one short of the node range
      // `touches()` tests -- without the nudge the reveal needs an extra
      // ArrowRight. Same `+ 1` workaround as `startImageResize()` below.
      const anchor = Math.min(view.posAtDOM(widget) + 1, view.state.doc.length);
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
      return true;
    },
  });

  // The `.lp-resize` corner grip on a rendered image: dragging it live-
  // sizes the `<img>` and, on release, rewrites the note's `![alt|W](url)`
  // (ADR-0026). Returning `true` from `pointerdown`/`mousedown` suppresses
  // CodeMirror's caret placement, so `touches()` never reveals the raw
  // text mid-drag.
  const imageResize = EditorView.domEventHandlers({
    mousedown(event) {
      const target = event.target as HTMLElement | null;
      return target?.closest('.lp-resize') != null;
    },
    pointerdown(event, view) {
      const target = event.target as HTMLElement | null;
      const grip = target?.closest('.lp-resize') as HTMLElement | null;
      if (!grip || event.button !== 0) {
        return false;
      }
      event.preventDefault();
      startImageResize(view, grip, event);
      return true;
    },
  });

  return [field, clickToReveal, imageResize];
}

/**
 * Runs an image resize gesture: locate the `Image` node from the grip's
 * `.lp-image` span, live-size `img.style.width` during the drag (no
 * transaction), and on `pointerup` dispatch **one** `changes` transaction
 * rewriting the alt span to `alt|<width>` (no `selection`, so the widget
 * swaps in place instead of the raw text revealing). Offsets are cached at
 * `pointerdown` -- the pointer is captured and nothing edits the doc until
 * release, so they stay valid.
 */
function startImageResize(view: EditorView, grip: HTMLElement, event: PointerEvent): void {
  const span = grip.closest('.lp-image');
  const img = span?.querySelector('img') as HTMLImageElement | null;
  if (!span || !img) {
    return;
  }

  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(view.posAtDOM(span) + 1, 1);
  while (node && node.name !== 'Image') {
    node = node.parent;
  }
  const marks = node?.getChildren('LinkMark');
  if (!node || !marks || marks.length < 2) {
    return;
  }
  const altFrom = marks[0].to;
  const altTo = marks[1].from;
  const startAlt = view.state.sliceDoc(altFrom, altTo);
  const startWidth = img.getBoundingClientRect().width || img.naturalWidth || 300;
  const startX = event.clientX;

  grip.setPointerCapture?.(event.pointerId);
  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;
  document.body.style.cursor = 'nwse-resize';
  document.body.style.userSelect = 'none';
  // The input-recovery watchdog reads this marker: `user-select:none` on
  // <body> is only legitimate while a gesture flag is set (ADR-0032).
  document.body.setAttribute('data-drey-gesture', 'image-resize');

  let liveWidth = clampEmbedWidth(startWidth);
  let ended = false;
  const move = (ev: PointerEvent): void => {
    liveWidth = clampEmbedWidth(startWidth + (ev.clientX - startX));
    img.style.width = `${liveWidth}px`;
    img.style.height = ''; // width-only: aspect ratio comes from the image
  };
  const end = (): void => {
    if (ended) {
      return; // pointerup + blur can both land; one teardown only
    }
    ended = true;
    grip.releasePointerCapture?.(event.pointerId);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('blur', end);
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
    document.body.removeAttribute('data-drey-gesture');

    if (parseImageEmbed(startAlt).width !== liveWidth) {
      view.dispatch({
        changes: { from: altFrom, to: altTo, insert: setEmbedWidth(startAlt, liveWidth) },
      });
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // A pointerup lost to an alt-tab must not leave `user-select: none`
  // stuck on <body> (bug-6); the `ended` guard keeps the single rewrite.
  window.addEventListener('blur', end);
}
