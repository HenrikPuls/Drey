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

  describe('Templates-panel drag (application/x-drey-template)', () => {
    it('strips frontmatter, substitutes placeholders, inserts at the drop point', async () => {
      view = mount('a\nb\n', {
        save: async () => 'x',
        notePath: () => 'projects/foo.md',
        readTextFile: async () => '---\ntitle: t\n---\n\n## {{title}} {{date}}\nbody\n',
      });

      fireDrop(view, transfer([], { 'application/x-drey-template': 'templates/meeting.md' }));
      await settle();

      const text = view.state.doc.toString();
      expect(text).not.toContain('---'); // frontmatter gone
      expect(text).not.toContain('{{title}}');
      expect(text).not.toContain('{{date}}');
      expect(text).toContain('## foo ' + new Date().getFullYear()); // {{title}} = note base name
      expect(text).not.toContain('uploading:');
    });

    it('does nothing when readTextFile is not configured', async () => {
      view = mount('# note\n', { save: async () => 'x' });
      const event = fireDrop(
        view,
        transfer([], { 'application/x-drey-template': 'templates/meeting.md' }),
      );
      await settle();
      expect(event.defaultPrevented).toBe(false);
      expect(view.state.doc.toString()).toBe('# note\n');
    });
  });

  describe('web image drag (URL)', () => {
    it('downloads the image and adds a [Source] line under it', async () => {
      const calls: string[] = [];
      view = mount('# note\n', {
        save: async () => 'x',
        saveFromUrl: async (u) => {
          calls.push(u);
          return 'attachments/dl.png';
        },
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      fireDrop(view, transfer([], { 'text/uri-list': 'https://example.com/pic.png' }));
      await settle();

      expect(calls).toEqual(['https://example.com/pic.png']);
      expect(view.state.doc.toString()).toContain(
        '![](attachments/dl.png)\n[Source](<https://example.com/pic.png>)',
      );
    });

    it('extracts the URL from an <img> in text/html even without an extension', async () => {
      const calls: string[] = [];
      view = mount('# note\n', {
        save: async () => 'x',
        saveFromUrl: async (u) => {
          calls.push(u);
          return 'attachments/dl.png';
        },
      });
      fireDrop(view, transfer([], { 'text/html': '<img src="https://cdn.example.com/asset">' }));
      await settle();
      expect(calls).toEqual(['https://cdn.example.com/asset']);
    });

    it('reports a download failure and rolls the placeholder back', async () => {
      const errors: string[] = [];
      view = mount('# note\n', {
        save: async () => 'x',
        saveFromUrl: async () => {
          throw new Error('That link is not an image.');
        },
        onError: (m) => errors.push(m),
      });
      fireDrop(view, transfer([], { 'text/uri-list': 'https://example.com/pic.png' }));
      await settle();

      expect(errors).toEqual(['That link is not an image.']);
      const text = view.state.doc.toString();
      expect(text).toBe('# note\n');
    });

    it('ignores a plain hyperlink drag (no image)', async () => {
      let called = false;
      view = mount('# note\n', {
        save: async () => 'x',
        saveFromUrl: async () => {
          called = true;
          return 'x';
        },
      });
      const event = fireDrop(view, transfer([], { 'text/uri-list': 'https://example.com/article' }));
      await settle();

      expect(called).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(view.state.doc.toString()).toBe('# note\n');
    });

    it('does nothing with a URL drag when saveFromUrl is not configured', async () => {
      view = mount('# note\n', { save: async () => 'x' });
      const event = fireDrop(view, transfer([], { 'text/uri-list': 'https://example.com/pic.png' }));
      await settle();
      expect(event.defaultPrevented).toBe(false);
      expect(view.state.doc.toString()).toBe('# note\n');
    });
  });

  describe('OS text file drop', () => {
    it('inlines a dropped text file raw', async () => {
      const file = {
        type: 'text/plain',
        name: 'notes.txt',
        size: 12,
        text: async () => 'dropped text',
      } as unknown as File;
      view = mount('# note\n', { save: async () => 'x' });

      fireDrop(view, transfer([file]));
      await settle();

      const text = view.state.doc.toString();
      expect(text).toContain('dropped text');
      expect(text).not.toContain('![](');
    });

    it('refuses a dropped text file over 2 MB without reading it', async () => {
      const errors: string[] = [];
      let read = false;
      const file = {
        type: 'text/plain',
        name: 'huge.log',
        size: 2 * 1024 * 1024 + 1,
        text: async () => {
          read = true;
          return '';
        },
      } as unknown as File;
      view = mount('# note\n', { save: async () => 'x', onError: (m) => errors.push(m) });

      fireDrop(view, transfer([file]));
      await settle();

      expect(read).toBe(false);
      expect(errors[0]).toContain('2 MB');
      expect(view.state.doc.toString()).toBe('# note\n');
    });
  });
});
