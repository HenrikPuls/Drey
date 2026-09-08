import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import MarkdownIt from 'markdown-it';
import { clampEmbedWidth, parseImageEmbed, setEmbedWidth } from '../../../../shared/image-embed';
import { frontmatterEnd } from '../markdown-frontmatter';
import { fenceLang } from './fenced-code';
import { htmlTagBalance, sanitizeHtml } from './sanitize-html';
import { HtmlBlockWidget, ImageWidget, MermaidWidget, TableWidget } from './widgets';

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
   * Maps a raw `![](url)` target to a servable `src`, or `null` when it
   * can't be trusted/resolved -- the component wires this to
   * `resolveVaultImageUrl` with the active document's path.
   */
  resolveImage: (url: string) => string | null;
  /**
   * Opens a resolved image `src` in the full-app viewer (ADR-0026) --
   * the hover lens button on a rendered image. Optional: a surface that
   * doesn't want the lens (none today) omits it.
   */
  onOpenImage?: (src: string) => void;
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

export function blockDecorations(state: EditorState, config: LivePreviewConfig): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const doc = state.doc;
  const fmEnd = frontmatterEnd(state.sliceDoc());
  const touches = (from: number, to: number): boolean =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);

  const htmlBlocks: { from: number; to: number }[] = [];
  const tree = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        if (node.from >= fmEnd && !touches(node.from, node.to)) {
          // Block decorations must cover whole lines.
          const from = doc.lineAt(node.from).from;
          const to = doc.lineAt(node.to).to;
          const source = state.sliceDoc(node.from, node.to);
          deco.push(
            Decoration.replace({
              widget: new TableWidget(tableMd.render(source), source),
              block: true,
            }).range(from, to),
          );
        }
        return false;
      }
      if (node.name === 'FencedCode') {
        const infoNode = node.node.getChild('CodeInfo');
        const lang = fenceLang(infoNode ? state.sliceDoc(infoNode.from, infoNode.to) : '');
        if (lang === 'mermaid' && node.from >= fmEnd && !touches(node.from, node.to)) {
          const textNode = node.node.getChild('CodeText');
          const body = textNode ? state.sliceDoc(textNode.from, textNode.to) : '';
          const from = doc.lineAt(node.from).from;
          const to = doc.lineAt(node.to).to;
          deco.push(
            Decoration.replace({ widget: new MermaidWidget(body), block: true }).range(from, to),
          );
        }
        return false; // never descend into a fence
      }
      if (node.name === 'Image') {
        if (node.from >= fmEnd && !touches(node.from, node.to)) {
          const { alt, url, width, height } = parseImage(state, node.node);
          deco.push(
            Decoration.replace({
              widget: new ImageWidget(
                url === null ? null : config.resolveImage(url),
                alt,
                width,
                height,
                config.onOpenImage,
              ),
            }).range(node.from, node.to),
          );
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

    if (touches(regionFrom, regionTo)) {
      continue;
    }
    const source = state.sliceDoc(regionFrom, regionTo);
    const html = sanitizeHtml(htmlMd.render(source), config);
    if (!html.trim()) {
      continue; // e.g. a stray closing tag -- leave it raw rather than invisible
    }
    deco.push(
      Decoration.replace({
        widget: new HtmlBlockWidget(html, source),
        block: true,
      }).range(doc.lineAt(regionFrom).from, doc.lineAt(regionTo).to),
    );
  }

  return Decoration.set(deco, true);
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
  return { alt, url: url ? state.sliceDoc(url.from, url.to) : null, width, height, altFrom, altTo };
}

export function livePreviewBlocks(config: LivePreviewConfig): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => blockDecorations(state, config),
    update: (value, tr) =>
      tr.docChanged || tr.selection ? blockDecorations(tr.state, config) : value,
    provide: (f) => EditorView.decorations.from(f),
  });
  // The `✎` button on a rendered table/HTML block moves the cursor into
  // it, which reveals the raw source (the selection then touches the
  // node). Only the button: other clicks belong to the widget content
  // (toggling a <details>, selecting table text) -- its `ignoreEvent`
  // keeps CodeMirror out of those.
  const clickToReveal = EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.lp-edit')) {
        return false;
      }
      const widget = target.closest('.lp-table, .lp-html, .lp-mermaid');
      if (!widget) {
        return false;
      }
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(widget) }, scrollIntoView: true });
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

  let liveWidth = clampEmbedWidth(startWidth);
  const move = (ev: PointerEvent): void => {
    liveWidth = clampEmbedWidth(startWidth + (ev.clientX - startX));
    img.style.width = `${liveWidth}px`;
    img.style.height = ''; // width-only: aspect ratio comes from the image
  };
  const end = (): void => {
    grip.releasePointerCapture?.(event.pointerId);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;

    if (parseImageEmbed(startAlt).width !== liveWidth) {
      view.dispatch({
        changes: { from: altFrom, to: altTo, insert: setEmbedWidth(startAlt, liveWidth) },
      });
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}
