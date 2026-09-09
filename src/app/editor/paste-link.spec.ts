import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { pasteUrlAsMarkdownLink } from './paste-link';

/** A fake clipboard payload: `types` plus a `getData` map. */
function clipboard(data: Record<string, string>, extraTypes: string[] = []): DataTransfer {
  return {
    types: [...Object.keys(data), ...extraTypes],
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

function mount(doc: string, selection?: { anchor: number; head?: number }): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection,
      // Full `markdown()` so lang-markdown's own `pasteURLAsLink` (the
      // wrap-a-selection case) is present -- these tests check the two
      // handlers don't collide.
      extensions: [markdown({ base: markdownLanguage }), pasteUrlAsMarkdownLink()],
    }),
    parent: document.body,
  });
}

function firePaste(view: EditorView, data: DataTransfer): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  view.contentDOM.dispatchEvent(event);
}

describe('pasteUrlAsMarkdownLink', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('wraps a bare URL pasted onto an empty caret as [url](url)', () => {
    view = mount('');
    firePaste(view, clipboard({ 'text/plain': 'https://example.com/x' }));

    expect(view.state.doc.toString()).toBe('[https://example.com/x](https://example.com/x)');
    // The label is selected so a friendlier one can be typed over it.
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe('https://example.com/x');
  });

  it('inserts at the caret inside surrounding prose', () => {
    view = mount('see  for more', { anchor: 4 });
    firePaste(view, clipboard({ 'text/plain': 'https://example.com' }));

    expect(view.state.doc.toString()).toBe(
      'see [https://example.com](https://example.com) for more',
    );
  });

  it('promotes a www. URL to https://', () => {
    view = mount('');
    firePaste(view, clipboard({ 'text/plain': 'www.example.com' }));

    expect(view.state.doc.toString()).toBe('[https://www.example.com](https://www.example.com)');
  });

  it('leaves a non-URL paste to the default handler', () => {
    view = mount('');
    firePaste(view, clipboard({ 'text/plain': 'just some text' }));

    expect(view.state.doc.toString()).toBe('just some text');
  });

  it('does not fire when the pasted text is a URL plus trailing prose', () => {
    view = mount('');
    firePaste(view, clipboard({ 'text/plain': 'https://example.com and more' }));

    expect(view.state.doc.toString()).toBe('https://example.com and more');
  });

  it('defers to lang-markdown when there is a selection to wrap', () => {
    view = mount('pick me', { anchor: 0, head: 7 });
    firePaste(view, clipboard({ 'text/plain': 'https://example.com' }));

    // lang-markdown's own pasteURLAsLink wrapped the selection.
    expect(view.state.doc.toString()).toBe('[pick me](https://example.com)');
  });

  it('does nothing inside an inline code span', () => {
    view = mount('`code`', { anchor: 3 });
    firePaste(view, clipboard({ 'text/plain': 'https://example.com' }));

    // No Markdown link syntax was injected around the caret.
    expect(view.state.doc.toString()).not.toMatch(/\]\(/);
  });

  it('does nothing inside an existing link target', () => {
    view = mount('[label](https://a.test)', { anchor: 12 });
    firePaste(view, clipboard({ 'text/plain': 'https://example.com' }));

    // The one `](` is still the original link's -- no second one from us.
    expect(view.state.doc.toString().match(/\]\(/g)?.length).toBe(1);
  });

  it('bails when the clipboard carries files', () => {
    view = mount('');
    firePaste(view, clipboard({ 'text/plain': 'https://example.com' }, ['Files']));

    expect(view.state.doc.toString()).toBe('https://example.com');
  });
});
