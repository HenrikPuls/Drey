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

function fireDrop(view: EditorView, data: DataTransfer, altKey = false): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'altKey', { value: altKey });
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

  describe('pdf drop / paste (ADR-0052)', () => {
    /** A stand-in PDF; the OS often leaves the MIME blank on Explorer drags. */
    function pdfFile(type = 'application/pdf', name = 'Report.pdf'): File {
      return fakeFile(type, name);
    }

    it('stages a dropped pdf name-preserving and inserts ![name](path)', async () => {
      const calls: Array<{ fileName: string; bytes: number }> = [];
      view = mount('# note\n', {
        save: async () => 'x',
        saveNamed: async (bytes, fileName) => {
          calls.push({ fileName, bytes: bytes.length });
          return 'attachments/Report.pdf';
        },
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      fireDrop(view, transfer([pdfFile()]));
      await settle();

      expect(calls).toEqual([{ fileName: 'Report.pdf', bytes: 4 }]);
      const text = view.state.doc.toString();
      expect(text).toContain('![Report.pdf](attachments/Report.pdf)');
      expect(text).not.toContain('uploading:');
    });

    it('accepts a blank-MIME .pdf by extension, like images', async () => {
      let saved = '';
      view = mount('# note\n', {
        save: async () => 'x',
        saveNamed: async (_bytes, fileName) => {
          saved = fileName;
          return `attachments/${fileName}`;
        },
      });
      fireDrop(view, transfer([pdfFile('', 'quarterly.PDF')]));
      await settle();
      expect(saved).toBe('quarterly.PDF');
      expect(view.state.doc.toString()).toContain('![quarterly.PDF](attachments/quarterly.PDF)');
    });

    it('an image wins a mixed drop; the pdf is not staged', async () => {
      let savedNamed = false;
      view = mount('# note\n', {
        save: async () => 'attachments/x.png',
        saveNamed: async () => {
          savedNamed = true;
          return 'attachments/x.pdf';
        },
      });
      fireDrop(view, transfer([fakeImage(), pdfFile()]));
      await settle();
      expect(savedNamed).toBe(false);
      expect(view.state.doc.toString()).toContain('![](attachments/x.png)');
    });

    it('links a dragged vault pdf in place (alt = file name, no copy)', async () => {
      let savedNamed = false;
      view = mount('# note\n', {
        save: async () => 'x',
        saveNamed: async () => {
          savedNamed = true;
          return 'x';
        },
        notePath: () => 'projects/foo.md',
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      fireDrop(view, transfer([], { 'application/x-drey-vault-path': 'docs/spec v2.pdf' }));
      await settle();

      expect(savedNamed).toBe(false);
      expect(view.state.doc.toString()).toContain('![spec v2.pdf](<../docs/spec v2.pdf>)');
      expect(view.state.doc.toString()).not.toContain('uploading:');
    });

    it('pastes a pdf from the clipboard', async () => {
      let saved = '';
      view = mount('# note\n', {
        save: async () => 'x',
        saveNamed: async (_bytes, fileName) => {
          saved = fileName;
          return `attachments/${fileName}`;
        },
      });
      firePaste(view, transfer([pdfFile()]));
      await settle();
      expect(saved).toBe('Report.pdf');
      expect(view.state.doc.toString()).toContain('![Report.pdf](attachments/Report.pdf)');
    });

    it('inserts nothing when saveNamed is not configured', async () => {
      view = mount('# note\n', { save: async () => 'x' });
      const event = fireDrop(view, transfer([pdfFile()]));
      await settle();
      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe('# note\n');
    });

    it('reports a staging failure and rolls the placeholder back', async () => {
      const errors: string[] = [];
      view = mount('# note\n', {
        save: async () => 'x',
        saveNamed: () => Promise.reject(new Error('No vault is active.')),
        onError: (m) => errors.push(m),
      });
      fireDrop(view, transfer([pdfFile()]));
      await settle();
      expect(errors).toEqual(['No vault is active.']);
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

  describe('meeting drop (.ics / .msg)', () => {
    function calendarFile(name = 'invite.ics'): File {
      return {
        type: name.endsWith('.msg') ? 'application/vnd.ms-outlook' : 'text/calendar',
        name,
        size: 5,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
        text: async () => 'BEGIN:VCALENDAR',
      } as unknown as File;
    }

    it('decodes a dropped .ics and inserts the section on its own line at the drop point', async () => {
      const seen: Array<{ bytes: number; name: string }> = [];
      view = mount('# note\ntail\n', {
        save: async () => 'x',
        decodeMeeting: async (bytes, filename) => {
          seen.push({ bytes: bytes.length, name: filename });
          return '## 📅 Sync\n\n#mtg/sync';
        },
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      const event = fireDrop(view, transfer([calendarFile()]));
      await settle();

      expect(event.defaultPrevented).toBe(true);
      expect(seen).toEqual([{ bytes: 5, name: 'invite.ics' }]);
      const text = view.state.doc.toString();
      expect(text).toContain('## 📅 Sync\n\n#mtg/sync');
      expect(text).toContain('# note\ntail');
      // The block sits on its own lines, not fused to surrounding text.
      expect(text).not.toMatch(/\S## 📅|#mtg\/sync\S/);
    });

    it('recognises a .msg the same way', async () => {
      const names: string[] = [];
      view = mount('# note\n', {
        save: async () => 'x',
        decodeMeeting: async (_bytes, filename) => {
          names.push(filename);
          return '## meeting';
        },
      });

      fireDrop(view, transfer([calendarFile('Meeting.MSG')]));
      await settle();

      expect(names).toEqual(['Meeting.MSG']);
      expect(view.state.doc.toString()).toContain('## meeting');
    });

    it('routes a decode failure to onError and inserts nothing', async () => {
      const errors: string[] = [];
      view = mount('# note\n', {
        save: async () => 'x',
        decodeMeeting: async () => {
          throw new Error('The invite has no event in it.');
        },
        onError: (m) => errors.push(m),
      });

      fireDrop(view, transfer([calendarFile()]));
      await settle();

      expect(errors).toEqual(['The invite has no event in it.']);
      expect(view.state.doc.toString()).toBe('# note\n');
    });

  describe('Office documents (ADR-0066)', () => {
    it('Alt-drop links the document where it lives and copies nothing', async () => {
      let saved = false;
      view = mount('see ', {
        save: async () => 'x',
        saveNamed: async () => {
          saved = true;
          return 'attachments/report.docx';
        },
        notePath: () => 'foo.md',
        pathForFile: () => 'C:\\Docs\\My report (v2).docx',
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      const event = fireDrop(view, transfer([fakeFile('', 'My report (v2).docx')]), true);
      await settle();
      expect(event.defaultPrevented).toBe(true);
      expect(saved).toBe(false);
      expect(view.state.doc.toString()).toContain(
        '[My report (v2).docx](file:///C:/Docs/My%20report%20%28v2%29.docx)',
      );
    });

    it('Alt-drop of a non-document file falls back to the normal staging', async () => {
      let savedName = '';
      view = mount('# note\n', {
        save: async () => 'x',
        saveNamed: async (_bytes, fileName) => {
          savedName = fileName;
          return 'attachments/tool.zip';
        },
        notePath: () => 'foo.md',
        pathForFile: () => 'C:\\Docs\\tool.zip',
      });
      fireDrop(view, transfer([fakeFile('', 'tool.zip')]), true);
      await settle();
      expect(savedName).toBe('tool.zip');
      expect(view.state.doc.toString()).toContain('[tool.zip](attachments/tool.zip)');
    });

    it('Alt-drop without a local path stages the document as usual', async () => {
      view = mount('# note\n', {
        save: async () => 'x',
        saveNamed: async () => 'attachments/report.docx',
        notePath: () => 'foo.md',
        pathForFile: () => '',
      });
      fireDrop(view, transfer([fakeFile('', 'report.docx')]), true);
      await settle();
      expect(view.state.doc.toString()).toContain('[report.docx](attachments/report.docx)');
    });

    it('links a vault document dragged from the Files panel in place', async () => {
      let saved = false;
      view = mount('see ', {
        save: async () => {
          saved = true;
          return 'x';
        },
        notePath: () => 'projects/foo.md',
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      fireDrop(view, transfer([], { 'application/x-drey-vault-path': 'v1::docs/Plan 2026.xlsx' }));
      await settle();
      expect(saved).toBe(false);
      expect(view.state.doc.toString()).toContain('[Plan 2026.xlsx](<../docs/Plan 2026.xlsx>)');
    });
  });

  describe('generic OS file staging (milestone 31)', () => {
    it('stages a leftover file name-preserving and inserts a Markdown link', async () => {
      let savedName = '';
      view = mount('# note\n', {
        save: async () => 'attachments/x.png',
        saveNamed: async (_bytes, fileName) => {
          savedName = fileName;
          return 'attachments/report.docx';
        },
        notePath: () => 'foo.md',
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      fireDrop(view, transfer([fakeFile('', 'report.docx')]));
      await settle();
      expect(savedName).toBe('report.docx');
      const text = view.state.doc.toString();
      expect(text).toContain('[report.docx](attachments/report.docx)');
      expect(text).not.toContain('uploading:');
    });

    it('refuses a leftover file over the size cap with a notice', async () => {
      const errors: string[] = [];
      view = mount('# note\n', {
        save: async () => 'attachments/x.png',
        saveNamed: async () => 'attachments/big.bin',
        onError: (message) => errors.push(message),
      });
      const big = { ...fakeFile('', 'big.bin'), size: 101 * 1024 * 1024 } as unknown as File;
      fireDrop(view, transfer([big]));
      await settle();
      expect(errors[0]).toContain('too large to attach');
      expect(view.state.doc.toString()).toBe('# note\n');
    });

    it('skips an extension-less leftover with a notice, saving nothing', async () => {
      const errors: string[] = [];
      let saved = false;
      view = mount('# note\n', {
        save: async () => 'attachments/x.png',
        saveNamed: async () => {
          saved = true;
          return 'attachments/x';
        },
        onError: (message) => errors.push(message),
      });
      fireDrop(view, transfer([fakeFile('', 'artifact')]));
      await settle();
      expect(saved).toBe(false);
      expect(errors[0]).toContain('artifact');
      expect(view.state.doc.toString()).toBe('# note\n');
    });
  });

    it('inserts nothing when decodeMeeting is not configured', async () => {
      view = mount('# note\n', { save: async () => 'x' });

      const event = fireDrop(view, transfer([calendarFile()]));
      await settle();

      // No meeting branch and `.ics` is not a text extension: the drop is
      // swallowed, same as any other unrecognised binary file.
      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe('# note\n');
    });
  });
});
