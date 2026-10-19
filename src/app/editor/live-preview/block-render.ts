import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Range, StateField, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import MarkdownIt from 'markdown-it';
import { imageExtension, pdfExtension } from '../../../../shared/asset-name';
import { clampEmbedWidth, parseImageEmbed, setEmbedWidth } from '../../../../shared/image-embed';
import { applyExtendedMarkdown } from '../../../../shared/markdown/markdown-it-extended';
import { frontmatterEnd } from '../markdown-frontmatter';
import { highlightFence } from '../preview-highlight';
import { extractWikilinks } from '../wikilinks/wikilink';
import { fenceLang } from './fenced-code';
import { MathWidget } from './math-widget';
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
 * The syntax tree of the whole document. A new state parses only its
 * beginning up front and the rest in the background, so `syntaxTree`
 * alone may end before the position asked about; this finishes the
 * parse (within the budget) first. Whatever draws from the tree and
 * whatever later looks a drawn thing up must both use it.
 */
export function completeSyntaxTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
}

/**
 * Table blocks are rendered through markdown-it (`html: false`, core GFM
 * tables + inline formatting inside cells) -- reusing the exact renderer the
 * old preview mode used for full fidelity, scoped to one block. The
 * extended-Markdown rules ride along (`==mark==`, `~sub~`, `^sup^`,
 * `:emoji:`, bare-URL linkify); math renders as a styled SOURCE span —
 * the editor's KaTeX copy is widget-side, and cells stay sync-rendered.
 */
const tableMd = new MarkdownIt({ html: false });
applyExtendedMarkdown(tableMd, { fenceHighlight: highlightFence });

/**
 * HTML regions render with `html: true`: the region may interleave raw HTML
 * blocks with Markdown (a `<details>` body), and markdown-it stitches
 * exactly that back together. Its output never reaches the DOM without
 * `sanitizeHtml`.
 */
const htmlMd = new MarkdownIt({ html: true });
applyExtendedMarkdown(htmlMd, { fenceHighlight: highlightFence });

type EmbedKind = 'table' | 'mermaid' | 'image' | 'pdf' | 'html' | 'math';

/** The LaTeX body of a `MathBlock`'s source (opener/closer `$$` stripped). */
function mathBlockSource(text: string): string {
  if (!text.includes('\n')) {
    return /^\$\$(.+)\$\$$/.exec(text.trim())?.[1] ?? '';
  }
  const lines = text.split('\n');
  const body = lines[lines.length - 1].trim() === '$$' ? lines.slice(1, -1) : lines.slice(1);
  return body.join('\n');
}

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
 * The table's REAL extent inside its `Table` node: the delimiter row plus
 * every body row that actually carries a pipe. lezer-markdown keeps
 * absorbing: every following paragraph line becomes a `TableRow` (a
 * pipe-less line arrives as a single-cell row with no delimiter) and the
 * node ends at the PARAGRAPH -- so a paragraph glued to the table (no blank
 * line, e.g. a Backspace ate it) would be swallowed by the widget: its
 * lines render as table rows and the reveal/atomic ranges stretch over
 * them. This walk is the shared clamp for the widget range, the reveal
 * container and the table-Enter handler. `null` for a degenerate node
 * without a delimiter row.
 */
export function realTableExtent(table: SyntaxNode): SyntaxNode | null {
  let extent: SyntaxNode | null = table.getChild('TableDelimiter');
  for (const row of table.getChildren('TableRow')) {
    if (row.getChild('TableDelimiter') === null) {
      break;
    }
    extent = row;
  }
  return extent;
}

/**
 * A run of delimiter-carrying rows the parser absorbed into `table` AFTER
 * its real extent (`extentTo` = `realTableExtent(table).to`) -- a second
 * table glued in after a plain text line parses as rows of the SAME
 * `Table` node. Returns the run's header row, delimiter row and last row
 * when `pos` sits on one of the run's lines, else `null` (a pipe-less
 * absorbed line or no run). Shared by the widget split (`scanEmbeds`), the
 * table-Enter handler and the deletion grace.
 */
export function absorbedTableRunAt(
  table: SyntaxNode,
  extentTo: number,
  pos: number,
): { from: SyntaxNode; delim: SyntaxNode; to: SyntaxNode } | null {
  let run: SyntaxNode[] = [];
  const flush = (): { from: SyntaxNode; delim: SyntaxNode; to: SyntaxNode } | null => {
    const hit =
      run.length >= 2 && run[0].from <= pos && pos <= run[run.length - 1].to
        ? { from: run[0], delim: run[1], to: run[run.length - 1] }
        : null;
    run = [];
    return hit;
  };
  for (const row of table.getChildren('TableRow')) {
    if (row.to <= extentTo) {
      continue;
    }
    if (row.getChild('TableDelimiter') !== null) {
      run.push(row);
    } else {
      const hit = flush();
      if (hit) {
        return hit;
      }
    }
  }
  return flush();
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

  const tree = completeSyntaxTree(state);

  // Obsidian-style media embeds `![[name.png]]` / `![[name.pdf]]`
  // (milestone 31, ADR-0046 addendum) are collected FIRST: the markdown
  // parser ALSO reads their `![` prefix as a (URL-less) Image node — for
  // media embeds a duplicate widget, for `![[Note]]` a stray image
  // placeholder — so every Image node opening on `![[` is left to the
  // wikilink pass below.
  const wikiEmbeds = collectWikilinkEmbeds(state, config, tree, fmEnd);

  tree.iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        if (node.from >= fmEnd) {
          // Widget, reveal container, atomic range and touch test all span
          // only the REAL rows (`realTableExtent`): lezer-markdown absorbs
          // following paragraph lines into the Table node, and a caret on
          // such a glued line must keep the table rendered, not flip it
          // into the raw source. Row growth is the table-Enter handler's
          // job (`table-enter.ts`), so the caret never has to sit on a
          // glued line to extend the table.
            const extent = realTableExtent(node.node);
            if (extent) {
              // Block decorations must cover whole lines.
              const from = doc.lineAt(node.from).from;
              const rowTo = doc.lineAt(extent.to).to;
              const source = state.sliceDoc(from, rowTo);
              // Trimmed: markdown-it ends its output with a newline, which
              // would render as a phantom empty line inside the widget (the
              // editor content is `pre-wrap`) and pad every table.
              const html = tableMd.render(source).trim();
              embeds.push({
                kind: 'table',
                from: node.from,
                to: rowTo,
                lineFrom: from,
                lineTo: rowTo,
                atom: () =>
                  Decoration.replace({
                    widget: new TableWidget(html, source),
                    block: true,
                  }).range(from, rowTo),
                preview: null,
              });
              // The parser absorbs EVERY following line into the `Table`
              // node until a blank line -- a second table glued in after a
              // plain text line arrives as further delimiter-carrying rows
              // of the same node, beyond the clamp, and would never render.
              // Each such run becomes its own table embed; runs without a
              // delimiter row (arbitrary absorbed pipe lines) stay raw.
              let run: SyntaxNode[] = [];
              const flush = (): void => {
                if (run.length >= 2) {
                  const runFrom = doc.lineAt(run[0].from).from;
                  const runTo = doc.lineAt(run[run.length - 1].to).to;
                  const runSource = state.sliceDoc(runFrom, runTo);
                  const runHtml = tableMd.render(runSource).trim();
                  if (runHtml.includes('<table')) {
                    embeds.push({
                      kind: 'table',
                      from: run[0].from,
                      to: runTo,
                      lineFrom: runFrom,
                      lineTo: runTo,
                      atom: () =>
                        Decoration.replace({
                          widget: new TableWidget(runHtml, runSource),
                          block: true,
                        }).range(runFrom, runTo),
                      preview: null,
                    });
                  }
                }
                run = [];
              };
              for (const row of node.node.getChildren('TableRow')) {
                if (row.to <= extent.to) {
                  continue;
                }
                if (row.getChild('TableDelimiter') !== null) {
                  run.push(row);
                } else {
                  flush();
                }
              }
              flush();
            }
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
      if (node.name === 'MathBlock') {
        if (node.from >= fmEnd) {
          // `node` is the iterate cursor — capture before it moves on.
          const nodeFrom = node.from;
          const nodeTo = node.to;
          const latex = mathBlockSource(state.sliceDoc(nodeFrom, nodeTo));
          const from = doc.lineAt(nodeFrom).from;
          const to = doc.lineAt(nodeTo).to;
          embeds.push({
            kind: 'math',
            from: nodeFrom,
            to: nodeTo,
            lineFrom: from,
            lineTo: to,
            atom: () =>
              Decoration.replace({
                widget: new MathWidget(latex, true),
                block: true,
              }).range(from, to),
            preview: null,
          });
        }
        return false;
      }
      if (node.name === 'InlineMath') {
        if (node.from >= fmEnd) {
          const nodeFrom = node.from;
          const nodeTo = node.to;
          const raw = state.sliceDoc(nodeFrom, nodeTo);
          const display = raw.startsWith('$$');
          const latex = display ? raw.slice(2, -2) : raw.slice(1, -1);
          embeds.push({
            kind: 'math',
            from: nodeFrom,
            to: nodeTo,
            lineFrom: doc.lineAt(nodeFrom).from,
            lineTo: doc.lineAt(nodeTo).to,
            atom: () =>
              Decoration.replace({
                widget: new MathWidget(latex, false),
              }).range(nodeFrom, nodeTo),
            preview: null,
          });
        }
        return false;
      }
      if (node.name === 'Image') {
        // `![[...]]` belongs to the wikilink pass (below), whatever the
        // target turns out to be.
        if (state.sliceDoc(node.from, node.from + 3) === '![[') {
          return false;
        }
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
    // the candidate walk is the Markdown image widget's concern. Trimmed
    // like the table render: no phantom trailing-newline line in the widget.
    const html = sanitizeHtml(htmlMd.render(source), {
      resolveImage: (url) => config.resolveImage(url)[0] ?? null,
    }).trim();
    if (!html) {
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

  // Obsidian-style media embeds render exactly like a Markdown image —
  // widget swap, reveal mirror, the shared candidate chain (so bare names
  // search the `attachments/` folders too). `[[note]]` stays a link (no
  // note transclusion).
  for (const embed of wikiEmbeds) {
    embeds.push(embed);
  }

  return embeds;
}

interface WikilinkEmbed {
  kind: EmbedKind;
  from: number;
  to: number;
  target: string;
  srcs: readonly string[];
  alt: string;
  width: number | null;
  height: number | null;
  previewPos: number;
}

/**
 * The `![[...]]` media pass: `extractWikilinks` over the whole document,
 * keeping only `!`-prefixed, post-frontmatter, image/PDF targets outside
 * code. Heading anchors are note links, never media.
 */
function collectWikilinkEmbeds(
  state: EditorState,
  config: LivePreviewConfig,
  tree: ReturnType<typeof syntaxTree>,
  fmEnd: number,
): Embed[] {
  const doc = state.doc;
  const full = state.sliceDoc();
  const found: WikilinkEmbed[] = [];
  for (const wl of extractWikilinks(full)) {
    const from = wl.index - 1;
    if (from < 0 || full[from] !== '!' || from < fmEnd) {
      continue;
    }
    if (wl.target.includes('#') || wl.anchor !== null) {
      continue;
    }
    const isPdf = pdfExtension(wl.target) !== null;
    const isImage = imageExtension(wl.target) !== null;
    if (!isPdf && !isImage) {
      continue;
    }
    if (isInsideCode(tree, from)) {
      continue;
    }
    const to = wl.index + wl.length;
    // `![[img.png|300]]` — a size-only alias is the width, not alt text.
    const alias = wl.alias ?? '';
    const sizeOnly = /^\d+(x\d+)?$/.test(alias.trim());
    const { alt, width, height } = sizeOnly
      ? parseImageEmbed(`|${alias.trim()}`)
      : parseImageEmbed(alias);
    found.push({
      kind: isPdf ? 'pdf' : 'image',
      from,
      to,
      target: wl.target,
      srcs: config.resolveImage(wl.target),
      alt,
      width,
      height,
      previewPos: doc.lineAt(to).to,
    });
  }
  return found.map((embed) => ({
    kind: embed.kind,
    from: embed.from,
    to: embed.to,
    lineFrom: doc.lineAt(embed.from).from,
    lineTo: embed.previewPos,
    atom: () =>
      Decoration.replace({
        widget: embed.kind === 'pdf'
          ? new PdfWidget([...embed.srcs], embed.alt, embed.target, config.onOpenPdf)
          : new ImageWidget(
              [...embed.srcs],
              embed.alt,
              embed.width,
              embed.height,
              config.onOpenImage,
              embed.target,
            ),
      }).range(embed.from, embed.to),
    // While the `![[...]]` line is revealed, mirror the embed below it,
    // exactly like a Markdown image's preview.
    preview:
      embed.srcs.length === 0
        ? null
        : () =>
            Decoration.widget({
              widget: embed.kind === 'pdf'
                ? new PdfPreviewWidget([...embed.srcs], embed.alt)
                : new ImagePreviewWidget([...embed.srcs], embed.alt, embed.width, embed.height),
              block: true,
              side: 1,
            }).range(embed.previewPos),
  }));
}

/** True when `pos` sits inside a code span / fenced or inline code node. */
function isInsideCode(tree: ReturnType<typeof syntaxTree>, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node !== null) {
    if (node.name === 'CodeSpan' || node.name === 'InlineCode' || node.name === 'FencedCode') {
      return true;
    }
    node = node.parent;
  }
  return false;
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
 * The one-step deletion grace: a Backspace can drop the caret out of the
 * table's clamped extent -- eating a row's content empties the line, the
 * paragraph splits there and the extent retracts past the caret -- which
 * would snap the widget shut mid-delete. So a deletion transaction keeps
 * the table near the caret revealed. The grace is recomputed per
 * transaction and vanishes with the first non-deletion change (typing,
 * motion, click), handing the decision back to the normal touch test.
 */
export function deletionSticky(state: EditorState): { from: number; to: number } | null {
  const head = state.selection.main.head;
  const tree = completeSyntaxTree(state);
  // The caret itself, then one back: an emptied row line is no longer part
  // of the paragraph, so the table only reaches the position before it.
  for (const pos of [head, Math.max(0, head - 1)]) {
    let node: SyntaxNode | null = tree.resolveInner(pos, -1);
    while (node !== null && node.name !== 'Table') {
      node = node.parent;
    }
    if (node === null) {
      continue;
    }
    const extent = realTableExtent(node);
    if (extent === null) {
      continue;
    }
    if (pos <= extent.to) {
      return { from: node.from, to: extent.to };
    }
    // A glued-in second table (absorbed rows) holds itself open.
    const run = absorbedTableRunAt(node, extent.to, pos);
    if (run !== null) {
      return { from: run.from.from, to: run.to.to };
    }
  }
  return null;
}

/**
 * One tree walk (`scanEmbeds`), partitioned by whether each embed's node is
 * currently touched by the selection: not touched -> the `atoms` layer
 * (rendered widget, also fed to `EditorView.atomicRanges`); touched -> the
 * `reveal` layer (the `.lp-reveal*` line container, plus an
 * `ImagePreviewWidget` below an image's markup), which must stay
 * non-atomic so the caret can sit in the raw source. `sticky` extends the
 * touch test across a deletion (`deletionSticky`).
 */
function buildBlockState(
  state: EditorState,
  config: LivePreviewConfig,
  opts: { revealSelection?: boolean } = {},
  sticky: { from: number; to: number } | null = null,
): BlockState {
  const doc = state.doc;
  // Read-only rendering (view mode): embeds stay widgets forever, no
  // reveal layer regardless of where the selection sits.
  const selectionReveal = opts.revealSelection !== false;
  const touches = (from: number, to: number): boolean =>
    selectionReveal &&
    (state.selection.ranges.some((r) => r.from <= to && r.to >= from) ||
      (sticky !== null && sticky.from <= to && sticky.to >= from));

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
export function blockDecorations(
  state: EditorState,
  config: LivePreviewConfig,
  opts?: { revealSelection?: boolean },
): DecorationSet {
  return buildBlockState(state, config, opts).atoms;
}

/**
 * The reveal layer (ADR-0009 "Later change"): while a text embed's source is
 * revealed, its raw lines get a rounded container (`.lp-reveal*` line
 * decorations) and an image additionally keeps a read-only render
 * (`ImagePreviewWidget`) below the markup. Separate from `blockDecorations`
 * because these decorations must NOT feed `EditorView.atomicRanges`.
 */
export function revealDecorations(
  state: EditorState,
  config: LivePreviewConfig,
  opts?: { revealSelection?: boolean },
): DecorationSet {
  return buildBlockState(state, config, opts).reveal;
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

export function livePreviewBlocks(
  config: LivePreviewConfig,
  opts: { revealSelection?: boolean } = {},
): Extension {
  const field = StateField.define<BlockState>({
    create: (state) => buildBlockState(state, config, opts),
    update: (value, tr) => {
      if (!(tr.docChanged || tr.selection)) {
        return value;
      }
      const event = tr.annotation(Transaction.userEvent);
      const sticky =
        event !== undefined && event.startsWith('delete') ? deletionSticky(tr.state) : null;
      return buildBlockState(tr.state, config, opts, sticky);
    },
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
  // into the fence. Dormant in view mode (`revealSelection: false`): the
  // click would reveal nothing anyway.
  const clickToReveal = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (opts.revealSelection === false) {
        return false;
      }
      const target = event.target as HTMLElement | null;
      if (
        !target?.closest('.lp-edit') &&
        !target?.closest('.lp-mermaid-error') &&
        !target?.closest('.lp-pdf-error') &&
        !target?.closest('.lp-math-error')
      ) {
        return false;
      }
      const widget = target.closest('.lp-table, .lp-html, .lp-mermaid, .lp-image, .lp-pdf, .lp-math-block, .lp-math-inline');
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
      if (opts.revealSelection === false) {
        return false; // view mode is read-only -- the grip must not edit
      }
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

  // The tree the widget was drawn from, not the possibly unfinished one.
  let node: SyntaxNode | null = completeSyntaxTree(view.state).resolveInner(
    view.posAtDOM(span) + 1,
    1,
  );
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
