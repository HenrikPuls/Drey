import { TestBed } from '@angular/core/testing';
import { EditorService, stripFrontmatter } from './editor.service';
import { DreyApi } from '../../../shared/ipc-api';

describe('EditorService', () => {
  let service: EditorService;
  let writes: Array<{ path: string; content: string }>;

  beforeEach(() => {
    writes = [];
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (relativePath: string) =>
        Promise.resolve({ content: `content of ${relativePath}`, modifiedMs: 100 }),
      writeVaultFile: (relativePath: string, content: string) => {
        writes.push({ path: relativePath, content });
        return Promise.resolve(200);
      },
    };
    window.dreyApi = fakeApi as DreyApi;
    service = TestBed.inject(EditorService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('loads a file into buffer and saved content, not dirty', async () => {
    await service.openFile('sailing/_index.md');

    expect(service.openPath()).toBe('sailing/_index.md');
    expect(service.bufferContent()).toBe('content of sailing/_index.md');
    expect(service.savedContent()).toBe('content of sailing/_index.md');
    expect(service.isDirty()).toBe(false);
    expect(service.viewMode()).toBe('rendered');
  });

  it('becomes dirty when the buffer diverges and clean again after save', async () => {
    await service.openFile('note.md');
    service.updateBuffer('content of note.md + edit');
    expect(service.isDirty()).toBe(true);

    await service.save();

    expect(writes).toEqual([{ path: 'note.md', content: 'content of note.md + edit' }]);
    expect(service.savedContent()).toBe('content of note.md + edit');
    expect(service.isDirty()).toBe(false);
  });

  it('save is a no-op when nothing changed', async () => {
    await service.openFile('note.md');
    await service.save();
    expect(writes).toEqual([]);
  });

  it('stays clean opening a CRLF file and writes CRLF back on save', async () => {
    TestBed.resetTestingModule();
    const crlfWrites: string[] = [];
    const crlfApi: Partial<DreyApi> = {
      readVaultFile: () => Promise.resolve({ content: 'line one\r\nline two\r\n', modifiedMs: 1 }),
      writeVaultFile: (_path: string, content: string) => {
        crlfWrites.push(content);
        return Promise.resolve(2);
      },
    };
    window.dreyApi = crlfApi as DreyApi;
    const crlfService = TestBed.inject(EditorService);

    await crlfService.openFile('crlf.md');
    // Buffer is normalized to \n -- what CodeMirror would hold -- and that
    // must not count as an edit.
    expect(crlfService.bufferContent()).toBe('line one\nline two\n');
    expect(crlfService.isDirty()).toBe(false);

    crlfService.updateBuffer('line one\nline two\nline three\n');
    await crlfService.save();

    expect(crlfWrites).toEqual(['line one\r\nline two\r\nline three\r\n']);
    expect(crlfService.isDirty()).toBe(false);
  });

  it('does nothing without the Electron bridge', async () => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    const bare = TestBed.inject(EditorService);
    await bare.openFile('note.md');
    expect(bare.openPath()).toBeNull();
  });

  describe('tabs', () => {
    it('keeps every opened file as its own tab and re-activates an already-open one', async () => {
      await service.openFile('a.md');
      await service.openFile('b.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md']);
      expect(service.openPath()).toBe('b.md');

      await service.openFile('a.md');
      expect(service.openDocs().length).toBe(2);
      expect(service.openPath()).toBe('a.md');
    });

    it("preserves each tab's unsaved buffer across a switch (no prompt)", async () => {
      await service.openFile('a.md');
      service.updateBuffer('content of a.md + edit');
      await service.openFile('b.md');
      expect(service.isDirty()).toBe(false);

      service.activate('a.md');
      expect(service.bufferContent()).toBe('content of a.md + edit');
      expect(service.isDirty()).toBe(true);
    });

    it('closes a clean tab and activates its neighbour', async () => {
      await service.openFile('a.md');
      await service.openFile('b.md');
      await service.openFile('c.md');

      service.activate('b.md');
      service.closeTab('b.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'c.md']);
      expect(service.openPath()).toBe('c.md');

      service.closeTab('c.md');
      service.closeTab('a.md');
      expect(service.openDocs()).toEqual([]);
      expect(service.openPath()).toBeNull();
    });
  });

  describe('openDailyNote', () => {
    it('opens an existing daily note like any file', async () => {
      await service.openDailyNote('2026-09-05');
      expect(service.openPath()).toBe('daily/2026-09-05.md');
      expect(service.bufferContent()).toBe('content of daily/2026-09-05.md');
      expect(service.activeIsDraft()).toBe(false);
    });

    it('opens an unsaved draft from the template when the file is missing, and only writes on first real edit', async () => {
      TestBed.resetTestingModule();
      const draftWrites: Array<{ path: string; content: string }> = [];
      const draftApi: Partial<DreyApi> = {
        readVaultFile: () => Promise.reject(new Error('ENOENT')),
        buildDailyNoteContent: () => Promise.resolve('# 2026-09-06\n\n## 08:00\n'),
        writeVaultFile: (path: string, content: string) => {
          draftWrites.push({ path, content });
          return Promise.resolve(9);
        },
      };
      window.dreyApi = draftApi as DreyApi;
      const draftService = TestBed.inject(EditorService);

      await draftService.openDailyNote('2026-09-06');
      expect(draftService.openPath()).toBe('daily/2026-09-06.md');
      expect(draftService.activeIsDraft()).toBe(true);
      expect(draftService.isDirty()).toBe(false);

      // An untouched draft is not saved -- no empty file created.
      await draftService.save();
      expect(draftWrites).toEqual([]);

      draftService.updateBuffer('# 2026-09-06\n\n## 08:00\nEndlich getippt\n');
      expect(draftService.isDirty()).toBe(true);
      await draftService.save();

      expect(draftWrites).toEqual([
        { path: 'daily/2026-09-06.md', content: '# 2026-09-06\n\n## 08:00\nEndlich getippt\n' },
      ]);
      expect(draftService.activeIsDraft()).toBe(false);
      expect(draftService.isDirty()).toBe(false);
    });
  });

  describe('newDailyEntryEdit', () => {
    const at = (s: string) => s.length;

    it('appends a heading after one blank line when the doc ends with text', () => {
      const doc = '# 2026-09-05\n\n## 09:00\nSchon was getippt';
      const edit = service.newDailyEntryEdit(doc, new Date(2026, 8, 5, 14, 32));
      expect(edit).toEqual({ insert: '\n\n## 14:32\n', at: at(doc) });
    });

    it('does not add a second blank line when the doc already ends with one', () => {
      const doc = '# 2026-09-05\n\n';
      const edit = service.newDailyEntryEdit(doc, new Date(2026, 8, 5, 8, 5));
      expect(edit).toEqual({ insert: '## 08:05\n', at: at(doc) });
    });

    it('returns null when the doc already ends with an empty entry heading', () => {
      expect(
        service.newDailyEntryEdit('# 2026-09-05\n\n## 14:32\n', new Date(2026, 8, 5, 15, 0)),
      ).toBeNull();
    });

    it('handles an empty document', () => {
      const edit = service.newDailyEntryEdit('', new Date(2026, 8, 5, 7, 0));
      expect(edit).toEqual({ insert: '## 07:00\n', at: 0 });
    });
  });

  describe('auto-switch preference', () => {
    it('defaults off, and persists across a fresh service instance when enabled', () => {
      expect(service.autoSwitch()).toBe(false);

      service.setAutoSwitch(true);
      expect(service.autoSwitch()).toBe(true);
      expect(JSON.parse(localStorage.getItem('drey.editor')!)).toEqual({ autoSwitch: true });

      TestBed.resetTestingModule();
      expect(TestBed.inject(EditorService).autoSwitch()).toBe(true);
    });

    it('forces the active tab into the rendered view when enabled', async () => {
      await service.openFile('a.md');
      service.setViewMode('source');

      service.setAutoSwitch(true);
      expect(service.viewMode()).toBe('rendered');
    });
  });

  describe('caretOffset', () => {
    it('is per-tab and never negative', async () => {
      await service.openFile('a.md');
      service.setCaretOffset(5);
      await service.openFile('b.md');
      expect(service.caretOffset()).toBe(0);

      service.activate('a.md');
      expect(service.caretOffset()).toBe(5);

      service.setCaretOffset(-3);
      expect(service.caretOffset()).toBe(0);
    });

    it('does not make the tab dirty', async () => {
      await service.openFile('a.md');
      service.setCaretOffset(4);
      expect(service.isDirty()).toBe(false);
    });
  });

  it('requestNewDailyEntry bumps the request counter', () => {
    const before = service.newEntryRequest();
    service.requestNewDailyEntry();
    expect(service.newEntryRequest()).toBe(before + 1);
  });

  describe('stripFrontmatter', () => {
    it('drops a leading YAML block and the blank line after it', () => {
      const text = '---\ntype: notiz\ntitle: "x"\n---\n\n# Heading\n\nBody';
      expect(stripFrontmatter(text)).toBe('# Heading\n\nBody');
    });

    it('handles a file that is only frontmatter', () => {
      expect(stripFrontmatter('---\ntags: []\n---')).toBe('');
    });

    it('leaves a horizontal rule further down untouched', () => {
      const text = '# Heading\n\ntext\n\n---\n\nmore';
      expect(stripFrontmatter(text)).toBe(text);
    });

    it('is a no-op when there is no frontmatter', () => {
      expect(stripFrontmatter('# Just a note\n')).toBe('# Just a note\n');
    });
  });
});
