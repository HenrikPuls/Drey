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
 * `Prec.high` so it beats `basicSetup`'s Enter; an active completion popup
 * still wins (its keymap is higher and the command bails), and the compact
 * `submitOnEnter` composers keep their `Prec.highest` submit.
 */
export function tableEnter(): Extension {
  return Prec.high(keymap.of([{ key: 'Enter', run: insertTableRow }]));
}

/**
 * The Enter command. Only fires for a single, empty caret inside a
 * `Table` node's real extent (`realTableExtent`), outside block structures
 * (the `> `/list prefixes would not be reproduced on the new row), on an
 * editable and non-read-only surface -- everything else falls through to
 * the default newline.
 */
export function insertTableRow(view: EditorView): boolean {
  const state = view.state;
  if (
    completionStatus(state) === 'active' ||
    state.readOnly ||
    !state.facet(EditorView.editable)
  ) {
    return false;
  }
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1 || !main.empty) {
    return false;
  }
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(main.head, -1);
  while (node !== null && node.name !== 'Table') {
    node = node.parent;
  }
  if (!node) {
    return false;
  }
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (
      parent.name === 'Blockquote' ||
      parent.name === 'BulletList' ||
      parent.name === 'OrderedList'
    ) {
      return false;
    }
  }
  const extent = realTableExtent(node);
  const doc = state.doc;
  const delim = node.getChild('TableDelimiter');
  if (!extent || !delim || main.head < node.from || main.head > doc.lineAt(extent.to).to) {
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
