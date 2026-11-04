import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorIndentation } from './editor-indent';

/**
 * The Tab / Shift-Tab binding (roadmap bug-9): a real `EditorView` with
 * only `editorIndentation` mounted, driven by synthetic keydown events on
 * `.cm-content`. jsdom fires no browser-default focus navigation, so the
 * assertions are about the doc/selection effect of each key.
 */
function makeView(doc: string, anchor: number, head = anchor): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [editorIndentation],
    }),
  });
}

function pressTab(view: EditorView, key: 'Tab' | 'Shift-Tab'): void {
  const content = view.dom.querySelector('.cm-content') as HTMLElement;
  content.dispatchEvent(
    new KeyboardEvent('keydown', { key: key === 'Tab' ? 'Tab' : 'Tab', bubbles: true, shiftKey: key === 'Shift-Tab' }),
  );
}

describe('editor indentation (Tab key)', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('inserts a literal tab at an empty caret', () => {
    view = makeView('hello', 2);
    pressTab(view, 'Tab');
    expect(view.state.doc.toString()).toBe('he\tllo');
    expect(view.state.selection.main.head).toBe(3);
  });

  it('indents the selected lines instead of replacing the text', () => {
    view = makeView('aaa\nbbb\nccc', 0, 7); // 'aaa\nbbb' selected
    pressTab(view, 'Tab');
    expect(view.state.doc.toString()).toBe('\taaa\n\tbbb\nccc');
  });

  it('outdents a tab with Shift-Tab', () => {
    view = makeView('\taaa\n\tbbb', 1);
    pressTab(view, 'Shift-Tab');
    expect(view.state.doc.toString()).toBe('aaa\n\tbbb');
  });

  it('does not outdent a line without leading whitespace', () => {
    const doc = 'aaa';
    view = makeView(doc, 1);
    pressTab(view, 'Shift-Tab');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('is inert on a read-only surface (Tab falls through)', () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'hello',
        selection: { anchor: 2 },
        extensions: [editorIndentation, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      }),
    });
    pressTab(view, 'Tab');
    expect(view.state.doc.toString()).toBe('hello');
  });
});
