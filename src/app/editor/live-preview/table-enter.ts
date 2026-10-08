import { completionStatus } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { realTableExtent } from './block-render';

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
 * `Prec.high` so it beats `basicSetup`'s Enter; an active completion popup
 * still wins (its keymap is higher and the commands bail), and the compact
 * `submitOnEnter` composers keep their `Prec.highest` submit.
 */
export function tableEnter(): Extension {
  return Prec.high(
    keymap.of([
      { key: 'Enter', run: insertTableRow },
      { key: 'ArrowDown', run: exitTableBelow },
      { key: 'ArrowUp', run: exitTableAbove },
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
  if (!delim || main.head < node.from || main.head > doc.lineAt(extent.to).to) {
    return false;
  }
  const delimLine = doc.lineAt(delim.from);
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
  const lastLine = doc.lineAt(found.extent.to);
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
