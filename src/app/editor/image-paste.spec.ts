import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { imagePaste, ImagePasteConfig } from './image-paste';

/** A minimal stand-in for a pasted/dropped `File`. */
function fakeFile(type = 'image/png', name = 'shot.png'): File {
  return {
    type,
    name,
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    text: async () => 'file contents',
  } as unknown as File;
}
const fakeImage = fakeFile;

/**
 * A fake clipboard/drag payload. `files` populate `items`/`files`; `data`
 * is the `getData(type)` map (`text/uri-list`, `application/x-drey-vault-path`, …).
 */
function transfer(files: File[], data: Record<string, string> = {}): DataTransfer {
  return {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files,
    types: [...(files.length ? ['Files'] : []), ...Object.keys(data)],
    getData: (type: string) => data[type] ?? '',
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

function fireDrop(view: EditorView, data: DataTransfer): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  Object.defineProperty(event, 'clientX', { value: 0 });
  Object.defineProperty(event, 'clientY', { value: 0 });
  view.contentDOM.dispatchEvent(event);
  return event;
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

  it('accepts a dropped image file whose OS type is blank, by extension', async () => {
    view = mount('# note\n', { save: async () => 'attachments/x.png' });
    fireDrop(view, transfer([fakeFile('', 'logo.png')]));
    await settle();
    expect(view.state.doc.toString()).toContain('![](attachments/x.png)');
  });

  it('still ignores a dropped non-image file with a blank type', async () => {
    let saved = false;
    view = mount('# note\n', {
      save: async () => {
        saved = true;
        return 'x';
      },
    });
    fireDrop(view, transfer([fakeFile('', 'archive.zip')]));
    await settle();
    expect(saved).toBe(false);
    expect(view.state.doc.toString()).toBe('# note\n');
  });

  describe('Files-panel drag (application/x-drey-vault-path)', () => {
    it('links a vault image in place, relative to the open note, without saving', async () => {
      let saved = false;
      view = mount('# note\n', {
        save: async () => {
          saved = true;
          return 'x';
        },
        notePath: () => 'projects/foo.md',
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      fireDrop(view, transfer([], { 'application/x-drey-vault-path': 'assets/logo.png' }));
      await settle();

      expect(saved).toBe(false);
      expect(view.state.doc.toString()).toContain('![](../assets/logo.png)');
      expect(view.state.doc.toString()).not.toContain('uploading:');
    });

    it('uses the angle-bracket form for a path with a space', async () => {
      view = mount('# note\n', { save: async () => 'x', notePath: () => 'foo.md' });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      fireDrop(view, transfer([], { 'application/x-drey-vault-path': 'assets/my pic.png' }));
      await settle();
      expect(view.state.doc.toString()).toContain('![](<assets/my pic.png>)');
    });

    it('inlines a vault text file raw (no ![]() link, no placeholder)', async () => {
      view = mount('a\nb\n', {
        save: async () => 'x',
        readTextFile: async (p) => `contents of ${p}\n`,
      });

      fireDrop(view, transfer([], { 'application/x-drey-vault-path': 'notes/todo.md' }));
      await settle();

      const text = view.state.doc.toString();
      expect(text).toContain('contents of notes/todo.md');
      expect(text).toContain('a\nb\n');
      expect(text).not.toContain('![](');
      expect(text).not.toContain('uploading:');
    });

    it('refuses a vault text file over 2 MB', async () => {
      const errors: string[] = [];
      view = mount('# note\n', {
        save: async () => 'x',
        readTextFile: async () => 'x'.repeat(2 * 1024 * 1024 + 1),
        onError: (m) => errors.push(m),
      });
      fireDrop(view, transfer([], { 'application/x-drey-vault-path': 'big.log' }));
      await settle();

      expect(errors[0]).toContain('2 MB');
      expect(view.state.doc.toString()).toBe('# note\n');
    });

    it('does nothing for a non-image, non-text vault file', async () => {
      view = mount('# note\n', { save: async () => 'x', readTextFile: async () => 'nope' });
      const event = fireDrop(view, transfer([], { 'application/x-drey-vault-path': 'data/x.bin' }));
      await settle();
      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe('# note\n');
    });
  });
});
