import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import MarkdownIt from 'markdown-it';
import { frontmatterEnd } from '../markdown-frontmatter';
import { htmlTagBalance, sanitizeHtml } from './sanitize-html';
import { HtmlBlockWidget, ImageWidget, TableWidget } from './widgets';

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
      if (node.name === 'Image') {
        if (node.from >= fmEnd && !touches(node.from, node.to)) {
          const { alt, url } = parseImage(state, node.node);
          deco.push(
            Decoration.replace({
              widget: new ImageWidget(url === null ? null : config.resolveImage(url), alt),
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

/** Alt text sits between the first two link marks (`![` and `]`). */
function parseImage(state: EditorState, node: SyntaxNode): { alt: string; url: string | null } {
  const url = node.getChild('URL');
  const marks = node.getChildren('LinkMark');
  const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : '';
  return { alt, url: url ? state.sliceDoc(url.from, url.to) : null };
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
      const widget = target.closest('.lp-table, .lp-html');
      if (!widget) {
        return false;
      }
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(widget) }, scrollIntoView: true });
      view.focus();
      return true;
    },
  });
  return [field, clickToReveal];
}
