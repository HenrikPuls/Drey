import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { insertTableRow, tableEnter } from './table-enter';

/**
 * The table row-insertion Enter: a real `EditorView` with the Live
 * Preview-mode keymap mounted (same recipe as `editor-indent.spec`), driven
 * by synthetic keydown events on `.cm-content`.
 */
function makeView(
  doc: string,
  anchor: number,
  head = anchor,
  extra: Extension[] = [],
): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [markdown({ base: markdownLanguage }), tableEnter(), ...extra],
    }),
  });
}

function pressEnter(view: EditorView): void {
  const content = view.dom.querySelector('.cm-content') as HTMLElement;
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';

describe('table row Enter', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('Enter at the end of the last row appends an empty row, caret in its first cell', () => {
    view = makeView(TABLE, TABLE.length);
    pressEnter(view);
    expect(view.state.doc.toString()).toBe(`${TABLE}\n|  |  |`);
    // just past the new row's leading `| ` -- typing lands in the cell
    expect(view.state.selection.main.anchor).toBe(`${TABLE}\n| `.length);
  });

  it('Enter on the header or delimiter row starts the first body row', () => {
    view = makeView(TABLE, 2);
    expect(insertTableRow(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('| a | b |\n| - | - |\n|  |  |\n| 1 | 2 |');
  });

  it('matches the delimiter row\'s column count', () => {
    const doc = '| a | b | c |\n| - | - | - |';
    view = makeView(doc, doc.length);
    expect(insertTableRow(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${doc}\n|  |  |  |`);
  });

  it('caret on a line glued to the table but outside the real rows falls through', () => {
    const doc = `${TABLE}\nplain`;
    view = makeView(doc, doc.length);
    expect(insertTableRow(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('caret in a blank-separated paragraph falls through', () => {
    const doc = `${TABLE}\n\nplain`;
    view = makeView(doc, doc.length);
    expect(insertTableRow(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('a non-empty selection falls through', () => {
    view = makeView(TABLE, 0, 4);
    expect(insertTableRow(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE);
  });

  it('a table inside a blockquote falls through', () => {
    const doc = '> | a | b |\n> | - | - |';
    view = makeView(doc, 5);
    expect(insertTableRow(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('a read-only state falls through', () => {
    view = makeView(TABLE, TABLE.length, TABLE.length, [EditorState.readOnly.of(true)]);
    expect(insertTableRow(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE);
  });
});
