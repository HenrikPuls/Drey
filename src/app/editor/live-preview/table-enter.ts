import { completionStatus } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { absorbedTableRunAt, realTableExtent } from './block-render';

/**
 * Enter on a revealed table's raw source inserts a formatted row
 * (`|  |  |`, the delimiter row's column count, caret in the first cell)
 * instead of a plain newline. A plain newline after the last row would end
 * the paragraph and with it the `Table` node -- the widget would snap shut
 * and a following paragraph would glue to the table (lezer-markdown
 * absorbs paragraph lines into it, see `realTableExtent`). With the row
 * insertion the table grows row by row while its source stays revealed.
 *
 * The same keymap is the way OUT of a table that pins the document edge
 * (a table-only note used to be a trap: every caret position sat inside
 * the extent, so the raw view never closed and Enter only ever added
 * rows). ArrowDown on the last real row of a document-ending table
 * appends one blank line below and moves there; ArrowUp mirrors it when
 * the table starts at line 1. Everywhere else the arrows fall through to
 * the normal cursor motion, and Enter keeps growing the table row by row.
 *
 * The arrows are also the way IN: moving off a line onto one of a
 * RENDERED table span's lines puts the caret into the span's first
 * (ArrowDown) / last (ArrowUp) row, which flips the widget into its raw
 * source -- the same reveal a click or `</>` button produces. Left/Right
 * and PageUp/PageDown keep the one-move atomic skip.
 *
 * `Prec.high` so it beats `basicSetup`'s Enter; an active completion popup
 * still wins (its keymap is higher and the commands bail), and the compact
 * `submitOnEnter` composers keep their `Prec.highest` submit.
 */
export function tableEnter(): Extension {
  return Prec.high(
    keymap.of([
      { key: 'Enter', run: insertTableRow },
      { key: 'ArrowDown', run: exitTableBelow },
      { key: 'ArrowDown', run: enterTableBelow },
      { key: 'ArrowUp', run: exitTableAbove },
      { key: 'ArrowUp', run: enterTableAbove },
    ]),
  );
}

/**
 * The guards shared by the table commands: one empty caret on an editable,
 * non-read-only surface with no completion popup open.
 */
function plainCaret(view: EditorView): boolean {
  const state = view.state;
  if (
    completionStatus(state) === 'active' ||
    state.readOnly ||
    !state.facet(EditorView.editable)
  ) {
    return false;
  }
  const { main } = state.selection;
  return state.selection.ranges.length === 1 && main.empty;
}

/**
 * The `Table` node containing `pos` plus its real extent
 * (`realTableExtent`), or `null` when `pos` sits outside any table.
 */
function tableExtentAt(
  state: EditorState,
  pos: number,
): { node: SyntaxNode; extent: SyntaxNode } | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node !== null && node.name !== 'Table') {
    node = node.parent;
  }
  const extent = node === null ? null : realTableExtent(node);
  return node !== null && extent !== null ? { node, extent } : null;
}

/**
 * The Enter command. Only fires for a single, empty caret inside a
 * `Table` node's real extent (`realTableExtent`), outside block structures
 * (the `> `/list prefixes would not be reproduced on the new row) -- the
 * shared guards live in `plainCaret`. Everything else falls through to the
 * default newline.
 */
export function insertTableRow(view: EditorView): boolean {
  if (!plainCaret(view)) {
    return false;
  }
  const { main } = view.state.selection;
  const found = tableExtentAt(view.state, main.head);
  if (!found) {
    return false;
  }
  const { node, extent } = found;
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (
      parent.name === 'Blockquote' ||
      parent.name === 'BulletList' ||
      parent.name === 'OrderedList'
    ) {
      return false;
    }
  }
  const doc = view.state.doc;
  const delim = node.getChild('TableDelimiter');
  if (!delim || main.head < node.from) {
    return false;
  }
  // The parser absorbs every following line into the `Table` node until a
  // blank line -- a second table glued in after a plain text line is rows
  // of the SAME node (`absorbedTableRunAt`); Enter grows THAT table.
  let delimNode: SyntaxNode = delim;
  if (main.head > doc.lineAt(extent.to).to) {
    const run = absorbedTableRunAt(node, extent.to, main.head);
    if (run === null) {
      return false;
    }
    delimNode = run.delim;
  }
  const delimLine = doc.lineAt(delimNode.from);
  const caretLine = doc.lineAt(main.head);
  // A caret on the header or the delimiter row starts the first body row;
  // otherwise the new row goes directly below the caret's row.
  const insertLine = caretLine.number <= delimLine.number ? delimLine : caretLine;
  const cols = columnCount(delimLine.text);
  if (cols < 1) {
    return false;
  }
  const at = insertLine.to;
  const row = `|${'  |'.repeat(cols)}`;
  view.dispatch({
    changes: { from: at, insert: `\n${row}` },
    // just past the first cell's leading `| ` -- typing lands between the
    // cell's two spaces
    selection: { anchor: at + 3 },
    scrollIntoView: true,
  });
  return true;
}

/**
 * ArrowDown, trapped-table case: the caret sits on the last REAL row of a
 * table that also ends the document -- the one shape with no reachable
 * position outside the extent (the extent end IS the document end, and the
 * inclusive touch test counts it as inside), where the raw view could
 * never be left. Appends one blank line below the table and moves the
 * caret onto it; the blank line ends the `Table` node cleanly, so the
 * widget stays shut and a paragraph can be typed. Returns `false` (normal
 * cursor motion) for every other caret -- including one on a row with real
 * lines below, where ArrowDown has always been the exit.
 */
export function exitTableBelow(view: EditorView): boolean {
  if (!plainCaret(view)) {
    return false;
  }
  const state = view.state;
  const doc = state.doc;
  const found = tableExtentAt(state, state.selection.main.head);
  if (!found) {
    return false;
  }
  // A glued-in second table (absorbed rows beyond the extent) traps against
  // the document edge with its OWN last row.
  let lastLine = doc.lineAt(found.extent.to);
  if (doc.lineAt(state.selection.main.head).number > lastLine.number) {
    const run = absorbedTableRunAt(
      found.node,
      found.extent.to,
      state.selection.main.head,
    );
    if (run === null) {
      return false;
    }
    lastLine = doc.lineAt(run.to.to);
  }
  if (
    doc.lineAt(state.selection.main.head).number !== lastLine.number ||
    lastLine.number !== doc.lines
  ) {
    return false;
  }
  view.dispatch({
    changes: { from: doc.length, insert: '\n' },
    selection: { anchor: doc.length + 1 },
    scrollIntoView: true,
  });
  return true;
}

/**
 * ArrowUp, the mirrored trap: the caret on the header row of a table that
 * starts the document at line 1 (nothing above it, no position outside the
 * extent). Inserts one blank line above the table and moves the caret onto
 * it. Returns `false` everywhere else -- with frontmatter or any line
 * above, ArrowUp already reaches it untouched.
 */
export function exitTableAbove(view: EditorView): boolean {
  if (!plainCaret(view)) {
    return false;
  }
  const state = view.state;
  const doc = state.doc;
  const found = tableExtentAt(state, state.selection.main.head);
  if (!found) {
    return false;
  }
  // `node.from`, not `extent.from`: the extent starts at the delimiter
  // row, the trap begins at the table's first (header) line.
  const firstLine = doc.lineAt(found.node.from);
  if (
    doc.lineAt(state.selection.main.head).number !== firstLine.number ||
    firstLine.number !== 1
  ) {
    return false;
  }
  view.dispatch({
    changes: { from: 0, insert: '\n' },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
  return true;
}

/**
 * The rendered table span whose line range contains `pos`'s line: the main
 * extent, or a glued-in absorbed run (`absorbedTableRunAt`). `null` on a
 * pipe-less absorbed line or outside any table.
 */
function tableSpanLineAt(
  state: EditorState,
  pos: number,
): { lineFrom: number; lineTo: number } | null {
  // `side: 1` -- the positions probed here are line STARTS (the target
  // line's `from`), which sit exactly on a node boundary; `-1` would count
  // the boundary as the END of the previous node (the blank line above the
  // table resolves to the Document) and miss the table.
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node !== null && node.name !== 'Table') {
    node = node.parent;
  }
  if (node === null) {
    return null;
  }
  const extent = realTableExtent(node);
  if (extent === null) {
    return null;
  }
  if (pos <= extent.to) {
    return {
      lineFrom: state.doc.lineAt(node.from).from,
      lineTo: state.doc.lineAt(extent.to).to,
    };
  }
  const run = absorbedTableRunAt(node, extent.to, pos);
  return run === null
    ? null
    : {
        lineFrom: state.doc.lineAt(run.from.from).from,
        lineTo: state.doc.lineAt(run.to.to).to,
      };
}

/**
 * Whether `head` sits on its line's last (`dir: 1`) or first (`dir: -1`)
 * VISUAL row: ArrowDown/ArrowUp only enter a rendered table when the normal
 * motion would actually leave the line -- inside a wrapped paragraph the
 * arrows keep moving visual-row by visual-row. `coordsAtPos` can be null
 * (unmeasured content, e.g. in tests); the fallback then only intercepts
 * at the exact logical boundary.
 */
function atVisualLineEdge(view: EditorView, head: number, dir: 1 | -1): boolean {
  const line = view.state.doc.lineAt(head);
  if (line.from === line.to) {
    return true;
  }
  const boundaryPos = dir === 1 ? line.to : line.from;
  let caret: Partial<DOMRect> | null = null;
  let boundary: Partial<DOMRect> | null = null;
  try {
    caret = view.coordsAtPos(head);
    boundary = view.coordsAtPos(boundaryPos);
  } catch {
    caret = null;
  }
  // A zero rect (no layout, e.g. under jsdom) is no measurement either.
  const usable = (r: Partial<DOMRect> | null): r is Partial<DOMRect> =>
    !!r && (r.bottom !== 0 || r.top !== 0);
  if (!usable(caret) || !usable(boundary)) {
    return head === boundaryPos;
  }
  return Math.abs(caret.bottom! - boundary.bottom!) < 2;
}

/**
 * The arrow-entry command shared by `enterTableBelow` / `enterTableAbove`.
 */
function enterTable(view: EditorView, dir: 1 | -1): boolean {
  if (!plainCaret(view)) {
    return false;
  }
  const state = view.state;
  const head = state.selection.main.head;
  if (!atVisualLineEdge(view, head, dir)) {
    return false;
  }
  const line = state.doc.lineAt(head);
  const target = line.number + dir;
  if (target < 1 || target > state.doc.lines) {
    return false;
  }
  const span = tableSpanLineAt(state, state.doc.line(target).from);
  if (span === null) {
    return false;
  }
  const { main } = state.selection;
  if (main.from <= span.lineTo && main.to >= span.lineFrom) {
    return false; // already revealed (e.g. a second selection range inside)
  }
  const row = dir === 1 ? state.doc.lineAt(span.lineFrom) : state.doc.lineAt(span.lineTo);
  view.dispatch({ selection: { anchor: Math.min(row.from + 2, row.to) }, scrollIntoView: true });
  return true;
}

/** ArrowDown onto a rendered table: caret into its first row, source revealed. */
export function enterTableBelow(view: EditorView): boolean {
  return enterTable(view, 1);
}

/** ArrowUp onto a rendered table: caret into its last row, source revealed. */
export function enterTableAbove(view: EditorView): boolean {
  return enterTable(view, -1);
}

/** Cells in a delimiter row: `| - | - |` -> 2, `- | -` -> 2, `| - |` -> 1. */
function columnCount(line: string): number {
  let text = line.trim();
  if (text.startsWith('|')) {
    text = text.slice(1);
  }
  if (text.endsWith('|')) {
    text = text.slice(0, -1);
  }
  if (text.trim() === '') {
    return 0;
  }
  return text.split('|').length;
}
