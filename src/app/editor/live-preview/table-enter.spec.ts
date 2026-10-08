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

function pressKey(view: EditorView, key: string): void {
  const content = view.dom.querySelector('.cm-content') as HTMLElement;
  content.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function pressEnter(view: EditorView): void {
  pressKey(view, 'Enter');
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

describe('table exit arrows', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('ArrowDown on the last row of a document-ending table opens a line below, caret on it', () => {
    view = makeView(TABLE, TABLE.length);
    pressKey(view, 'ArrowDown');
    expect(view.state.doc.toString()).toBe(`${TABLE}\n`);
    expect(view.state.selection.main.anchor).toBe(TABLE.length + 1);
  });

  it('ArrowDown mid-table falls through to the default motion (no line appended)', () => {
    const doc = `${TABLE}\n| 3 | 4 |`;
    // caret on the second body row, one row above the extent's last line
    view = makeView(doc, 22);
    pressKey(view, 'ArrowDown');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('ArrowDown with a real line below the table falls through (that line is the exit)', () => {
    view = makeView(`${TABLE}\n`, TABLE.length - 1);
    pressKey(view, 'ArrowDown');
    // no second blank line appended -- the trailing line already is the exit
    expect(view.state.doc.toString()).toBe(`${TABLE}\n`);
  });

  it('ArrowDown on a glued line below the extent falls through', () => {
    const doc = `${TABLE}\nplain`;
    view = makeView(doc, doc.length);
    pressKey(view, 'ArrowDown');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('ArrowDown in a read-only state falls through', () => {
    view = makeView(TABLE, TABLE.length, TABLE.length, [EditorState.readOnly.of(true)]);
    pressKey(view, 'ArrowDown');
    expect(view.state.doc.toString()).toBe(TABLE);
  });

  it('ArrowDown with a non-empty selection falls through', () => {
    view = makeView(TABLE, 0, 4);
    pressKey(view, 'ArrowDown');
    expect(view.state.doc.toString()).toBe(TABLE);
  });

  it('ArrowUp from the header of a table at line 1 opens a line above, caret on it', () => {
    view = makeView(TABLE, 2);
    pressKey(view, 'ArrowUp');
    expect(view.state.doc.toString()).toBe(`\n${TABLE}`);
    expect(view.state.selection.main.anchor).toBe(0);
  });

  it('ArrowUp with a line above the table falls through', () => {
    const doc = `intro\n${TABLE}`;
    view = makeView(doc, 8); // on the header row, line 2
    pressKey(view, 'ArrowUp');
    expect(view.state.doc.toString()).toBe(doc);
  });
});
