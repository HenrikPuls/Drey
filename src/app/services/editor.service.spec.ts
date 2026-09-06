import { TestBed } from '@angular/core/testing';
import { EditorService, stripFrontmatter } from './editor.service';
import { DreyApi, NoteSaveRequest, NoteSaveResult } from '../../../shared/ipc-api';

/** Default fake `saveNote`: echoes the buffer back as the saved content (no rewrite). */
function echoSave(request: NoteSaveRequest): Promise<NoteSaveResult> {
  return Promise.resolve({
    path: request.path,
    content: request.body,
    modifiedMs: 200,
    tags: [],
    unknownTags: [],
    appendedTo: [],
  });
}

describe('EditorService', () => {
  let service: EditorService;
  let saves: NoteSaveRequest[];

  beforeEach(() => {
    saves = [];
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (relativePath: string) =>
        Promise.resolve({ content: `content of ${relativePath}`, modifiedMs: 100 }),
      saveNote: (request: NoteSaveRequest) => {
        saves.push(request);
        return echoSave(request);
      },
      listTags: () => Promise.resolve([]),
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
    expect(service.viewMode()).toBe('live');
  });

  it('becomes dirty when the buffer diverges and clean again after save', async () => {
    await service.openFile('note.md');
    service.updateBuffer('content of note.md + edit');
    expect(service.isDirty()).toBe(true);

    await service.save();

    expect(saves).toEqual([{ path: 'note.md', body: 'content of note.md + edit', eol: '\n' }]);
    expect(service.savedContent()).toBe('content of note.md + edit');
    expect(service.isDirty()).toBe(false);
  });

  it('adopts the frontmatter the save pipeline rewrites and refreshes the tag list', async () => {
    TestBed.resetTestingModule();
    let tagListCalls = 0;
    const rewriteApi: Partial<DreyApi> = {
      readVaultFile: () =>
        Promise.resolve({ content: '---\ntags: []\n---\n\nBody #sailing\n', modifiedMs: 1 }),
      saveNote: (request: NoteSaveRequest) =>
        Promise.resolve({
          path: request.path,
          content: '---\ntags: ["sailing"]\nupdated: "2026-09-06T10:00:00"\n---\n\nBody #sailing\n',
          modifiedMs: 2,
          tags: ['sailing'],
          unknownTags: ['sailing'],
          appendedTo: [],
        }),
      listTags: () => {
        tagListCalls += 1;
        return Promise.resolve([]);
      },
    };
    window.dreyApi = rewriteApi as DreyApi;
    const rewriteService = TestBed.inject(EditorService);

    await rewriteService.openFile('note.md');
    rewriteService.updateBuffer('---\ntags: []\n---\n\nBody #sailing edited\n');
    await rewriteService.save();

    const expected =
      '---\ntags: ["sailing"]\nupdated: "2026-09-06T10:00:00"\n---\n\nBody #sailing\n';
    expect(rewriteService.savedContent()).toBe(expected);
    expect(rewriteService.bufferContent()).toBe(expected);
    expect(rewriteService.isDirty()).toBe(false);
    // once from the service constructor, once after the tag-changing save
    expect(tagListCalls).toBeGreaterThanOrEqual(2);
  });

  it('save is a no-op when nothing changed', async () => {
    await service.openFile('note.md');
    await service.save();
    expect(saves).toEqual([]);
  });

  it('reloads a clean open master tab that a routed History entry was appended to', async () => {
    TestBed.resetTestingModule();
    let masterOnDisk = '---\ntype: master\n---\n\n## History\n';
    const api: Partial<DreyApi> = {
      readVaultFile: (path: string) =>
        Promise.resolve({
          content: path === 'sailing/_index.md' ? masterOnDisk : `content of ${path}`,
          modifiedMs: 1,
        }),
      saveNote: (request: NoteSaveRequest) => {
        masterOnDisk =
          '---\ntype: master\n---\n\n## History\n\n### 2026-09-06 14:32 <!-- m -->\nRouted\n';
        return Promise.resolve({
          path: request.path,
          content: request.body,
          modifiedMs: 2,
          tags: ['sailing'],
          unknownTags: [],
          appendedTo: ['sailing/_index.md'],
        });
      },
      listTags: () => Promise.resolve([]),
    };
    window.dreyApi = api as DreyApi;
    const svc = TestBed.inject(EditorService);

    await svc.openFile('sailing/_index.md');
    await svc.openFile('daily/2026-09-06.md');
    svc.updateBuffer('# 2026-09-06\n\n## 14:32\nRouted #sailing\n');
    await svc.save();

    svc.activate('sailing/_index.md');
    expect(svc.savedContent()).toContain('### 2026-09-06 14:32');
    expect(svc.isDirty()).toBe(false);
  });

  it('sends the LF buffer plus the file EOL to the save pipeline', async () => {
    TestBed.resetTestingModule();
    const crlfSaves: NoteSaveRequest[] = [];
    const crlfApi: Partial<DreyApi> = {
      readVaultFile: () => Promise.resolve({ content: 'line one\r\nline two\r\n', modifiedMs: 1 }),
      saveNote: (request: NoteSaveRequest) => {
        crlfSaves.push(request);
        return echoSave(request);
      },
      listTags: () => Promise.resolve([]),
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

    // The renderer sends LF + the EOL flag; restoring CRLF on disk is the
    // main process's job now (note:save), not the editor service's.
    expect(crlfSaves).toEqual([
      { path: 'crlf.md', body: 'line one\nline two\nline three\n', eol: '\r\n' },
    ]);
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
    it('opens an existing daily note at the nested path', async () => {
      await service.openDailyNote('2026-09-05');
      expect(service.openPath()).toBe('daily/2026/09/2026-09-05.md');
      expect(service.bufferContent()).toBe('content of daily/2026/09/2026-09-05.md');
      expect(service.activeIsDraft()).toBe(false);
    });

    it('falls back to a pre-existing flat daily note', async () => {
      TestBed.resetTestingModule();
      const legacyApi: Partial<DreyApi> = {
        readVaultFile: (relativePath: string) =>
          relativePath === 'daily/2026-09-05.md'
            ? Promise.resolve({ content: 'legacy body', modifiedMs: 1 })
            : Promise.reject(new Error('ENOENT')),
        listTags: () => Promise.resolve([]),
      };
      window.dreyApi = legacyApi as DreyApi;
      const legacyService = TestBed.inject(EditorService);

      await legacyService.openDailyNote('2026-09-05');
      expect(legacyService.openPath()).toBe('daily/2026-09-05.md');
      expect(legacyService.bufferContent()).toBe('legacy body');
    });

    it('opens an unsaved draft from the template when the file is missing, and only writes on first real edit', async () => {
      TestBed.resetTestingModule();
      const draftSaves: NoteSaveRequest[] = [];
      let fileListReads = 0;
      const draftApi: Partial<DreyApi> = {
        readVaultFile: () => Promise.reject(new Error('ENOENT')),
        buildDailyNoteContent: () => Promise.resolve('# 2026-09-06\n\n## 08:00\n'),
        saveNote: (request: NoteSaveRequest) => {
          draftSaves.push(request);
          return echoSave(request);
        },
        listTags: () => Promise.resolve([]),
        getActiveVault: () => Promise.resolve('E:/vault'),
        listVaultFiles: () => {
          fileListReads += 1;
          return Promise.resolve([]);
        },
      };
      window.dreyApi = draftApi as DreyApi;
      const draftService = TestBed.inject(EditorService);

      await draftService.openDailyNote('2026-09-06');
      expect(draftService.openPath()).toBe('daily/2026/09/2026-09-06.md');
      expect(draftService.activeIsDraft()).toBe(true);
      expect(draftService.isDirty()).toBe(false);

      // An untouched draft is not saved -- no empty file created.
      await draftService.save();
      expect(draftSaves).toEqual([]);

      draftService.updateBuffer('# 2026-09-06\n\n## 08:00\nEndlich getippt\n');
      expect(draftService.isDirty()).toBe(true);
      const readsBeforeSave = fileListReads;
      await draftService.save();
      // `save()` fires `vault.refresh()` without awaiting it; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(draftSaves).toEqual([
        {
          path: 'daily/2026/09/2026-09-06.md',
          body: '# 2026-09-06\n\n## 08:00\nEndlich getippt\n',
          eol: '\n',
        },
      ]);
      expect(draftService.activeIsDraft()).toBe(false);
      expect(draftService.isDirty()).toBe(false);
      // The first save of a draft created a file the sidebar tree did not
      // know about -- it is pulled in (no watcher).
      expect(fileListReads).toBeGreaterThan(readsBeforeSave);
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

  describe('default-mode preference', () => {
    it('defaults to live preview and a fresh instance opens files in live preview', async () => {
      await service.openFile('a.md');
      expect(service.viewMode()).toBe('live');
    });

    it("migrates a stored pre-ADR-0009 'preview' default to 'live'", async () => {
      localStorage.setItem('drey.editor', JSON.stringify({ defaultMode: 'preview' }));
      await service.openFile('a.md');
      expect(service.viewMode()).toBe('live');
    });

    it('remembers the last chosen mode as the default for future opens', async () => {
      await service.openFile('a.md');
      service.setViewMode('source');
      expect(JSON.parse(localStorage.getItem('drey.editor')!)).toEqual({ defaultMode: 'source' });

      TestBed.resetTestingModule();
      const fresh = TestBed.inject(EditorService);
      await fresh.openFile('b.md');
      expect(fresh.viewMode()).toBe('source');
    });
  });

  it('requestNewDailyEntry bumps the request counter', () => {
    const before = service.newEntryRequest().id;
    service.requestNewDailyEntry();
    expect(service.newEntryRequest()).toEqual({ id: before + 1, text: undefined });

    service.requestNewDailyEntry('captured line');
    expect(service.newEntryRequest()).toEqual({ id: before + 2, text: 'captured line' });
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
