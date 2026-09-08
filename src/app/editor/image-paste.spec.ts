import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { imagePaste, ImagePasteConfig } from './image-paste';

/** A minimal stand-in for a pasted image `File`. */
function fakeImage(type = 'image/png'): File {
  return {
    type,
    name: 'shot.png',
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  } as unknown as File;
}

/** A fake clipboard/drag payload carrying `files` (and matching `items`). */
function transfer(files: File[]): DataTransfer {
  return {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files,
    types: files.length ? ['Files'] : [],
    // CodeMirror's own paste handler runs when ours declines a text-only
    // paste; give it a harmless reader so it doesn't throw in jsdom.
    getData: () => '',
  } as unknown as DataTransfer;
}

function mount(doc: string, config: ImagePasteConfig): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [imagePaste(config)] }),
    parent: document.body,
  });
}

function firePaste(view: EditorView, data: DataTransfer): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  view.contentDOM.dispatchEvent(event);
}

/** Two microtask hops: `file.arrayBuffer()` then `config.save()`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('imagePaste', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('inserts a link to the saved path and clears the placeholder', async () => {
    const calls: Array<{ ext: string; bytes: number }> = [];
    view = mount('# note\n', {
      save: async (bytes, ext) => {
        calls.push({ ext, bytes: bytes.length });
        return 'attachments/2026-09-08-120000-abcdef.png';
      },
    });
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    firePaste(view, transfer([fakeImage()]));
    await settle();

    expect(calls).toEqual([{ ext: 'png', bytes: 4 }]);
    const text = view.state.doc.toString();
    expect(text).toContain('![](attachments/2026-09-08-120000-abcdef.png)');
    expect(text).not.toContain('uploading:');
  });

  it('reports a save failure and rolls the placeholder back out', async () => {
    const errors: string[] = [];
    view = mount('# note\n', {
      save: () => Promise.reject(new Error('No vault is active.')),
      onError: (message) => errors.push(message),
    });
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    firePaste(view, transfer([fakeImage()]));
    await settle();

    expect(errors).toEqual(['No vault is active.']);
    const text = view.state.doc.toString();
    expect(text).not.toContain('uploading:');
    expect(text).not.toContain('![](');
    expect(text).toBe('# note\n');
  });

  it('ignores a paste with no image and leaves the document untouched', async () => {
    let saved = false;
    view = mount('# note\n', {
      save: async () => {
        saved = true;
        return 'x';
      },
    });

    firePaste(view, transfer([]));
    await settle();

    expect(saved).toBe(false);
    expect(view.state.doc.toString()).toBe('# note\n');
  });

  it('puts the image on its own line when pasted mid-text', async () => {
    view = mount('before after\n', {
      save: async () => 'attachments/x.png',
    });
    view.dispatch({ selection: { anchor: 6 } }); // between "before" and " after"

    firePaste(view, transfer([fakeImage()]));
    await settle();

    expect(view.state.doc.toString()).toBe('before\n![](attachments/x.png)\n after\n');
  });
});
