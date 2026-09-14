import { TestBed } from '@angular/core/testing';
import { EditorService, stripFrontmatter } from './editor.service';
import { DreyApi, NoteSaveRequest, NoteSaveResult } from '../../../shared/ipc-api';

/** Default fake `saveNote`: echoes the buffer back as the saved content (no rewrite). */
function echoSave(request: NoteSaveRequest): Promise<NoteSaveResult> {
  return Promise.resolve({
    path: request.path,
    content: request.body,
    modifiedMs: 200,
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
    service.updateBuffer('note.md', 'content of note.md + edit');
    expect(service.isDirty()).toBe(true);

    await service.save();

    expect(saves).toEqual([{ path: 'note.md', body: 'content of note.md + edit', eol: '\n' }]);
    expect(service.savedContent()).toBe('content of note.md + edit');
    expect(service.isDirty()).toBe(false);
  });

  it('adopts the frontmatter the save pipeline rewrites and refreshes the tag list', async () => {
    TestBed.resetTestingModule();
    const rewriteApi: Partial<DreyApi> = {
      readVaultFile: () =>
        Promise.resolve({ content: '---\ntitle: n\n---\n\nBody #sailing\n', modifiedMs: 1 }),
      saveNote: (request: NoteSaveRequest) =>
        Promise.resolve({
          path: request.path,
          content: '---\ntitle: n\nupdated: "2026-09-06T10:00:00"\n---\n\nBody #sailing\n',
          modifiedMs: 2,
        }),
    };
    window.dreyApi = rewriteApi as DreyApi;
    const rewriteService = TestBed.inject(EditorService);

    await rewriteService.openFile('note.md');
    rewriteService.updateBuffer('note.md', '---\ntitle: n\n---\n\nBody #sailing edited\n');
    await rewriteService.save();

    const expected = '---\ntitle: n\nupdated: "2026-09-06T10:00:00"\n---\n\nBody #sailing\n';
    expect(rewriteService.savedContent()).toBe(expected);
    expect(rewriteService.bufferContent()).toBe(expected);
    expect(rewriteService.isDirty()).toBe(false);
  });

  it('save is a no-op when nothing changed', async () => {
    await service.openFile('note.md');
    await service.save();
    expect(saves).toEqual([]);
  });

  it('a save landing while another is in flight is queued, not dropped', async () => {
    TestBed.resetTestingModule();
    let release: (() => void) | undefined;
    const gateApi: Partial<DreyApi> = {
      readVaultFile: () => Promise.resolve({ content: 'v0\n', modifiedMs: 1 }),
      saveNote: (request: NoteSaveRequest) => {
        saves.push(request);
        if (saves.length === 1) {
          return new Promise<NoteSaveResult>((resolve) => {
            release = () => resolve({ path: request.path, content: request.body, modifiedMs: 2 });
          });
        }
        return echoSave(request);
      },
    };
    window.dreyApi = gateApi as DreyApi;
    const gated = TestBed.inject(EditorService);

    await gated.openFile('note.md');
    gated.updateBuffer('note.md', 'v1\n');
    const first = gated.save();
    // Let the first save actually reach the stalled gate before editing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gated.updateBuffer('note.md', 'v2\n');
    const second = gated.save(); // lands while the first is in flight
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    await Promise.all([first, second]);

    // Both reached the pipeline -- the old isSaving() early return
    // silently dropped the second.
    expect(saves.map((req) => req.body)).toEqual(['v1\n', 'v2\n']);
    expect(gated.isDirty()).toBe(false);
    expect(gated.savedContent()).toBe('v2\n');
  });

  it('edits made during an in-flight save are not clobbered by its result', async () => {
    TestBed.resetTestingModule();
    let release: (() => void) | undefined;
    const gateApi: Partial<DreyApi> = {
      readVaultFile: () => Promise.resolve({ content: 'v0\n', modifiedMs: 1 }),
      saveNote: (request: NoteSaveRequest) => {
        saves.push(request);
        if (saves.length === 1) {
          return new Promise<NoteSaveResult>((resolve) => {
            release = () => resolve({ path: request.path, content: request.body, modifiedMs: 2 });
          });
        }
        return echoSave(request);
      },
    };
    window.dreyApi = gateApi as DreyApi;
    const gated = TestBed.inject(EditorService);

    await gated.openFile('note.md');
    gated.updateBuffer('note.md', 'v1\n');
    void gated.save(); // in flight
    gated.updateBuffer('note.md', 'v1\nchecked a task\n');
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gated.bufferContent()).toContain('checked a task'); // not reverted
    expect(gated.isDirty()).toBe(true); // still to be saved
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
    };
    window.dreyApi = crlfApi as DreyApi;
    const crlfService = TestBed.inject(EditorService);

    await crlfService.openFile('crlf.md');
    // Buffer is normalized to \n -- what CodeMirror would hold -- and that
    // must not count as an edit.
    expect(crlfService.bufferContent()).toBe('line one\nline two\n');
    expect(crlfService.isDirty()).toBe(false);

    crlfService.updateBuffer('crlf.md', 'line one\nline two\nline three\n');
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
      service.updateBuffer('a.md', 'content of a.md + edit');
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

    describe('retargetTabs (rename on disk)', () => {
      it('re-points an open tab, keeping its unsaved buffer, and follows the active path', async () => {
        await service.openFile('notes/a.md');
        service.updateBuffer('notes/a.md', 'content of notes/a.md + edit');

        service.retargetTabs('notes/a.md', 'notes/renamed.md');

        expect(service.openDocs().map((d) => d.path)).toEqual(['notes/renamed.md']);
        expect(service.openPath()).toBe('notes/renamed.md');
        expect(service.bufferContent()).toBe('content of notes/a.md + edit');
        expect(service.isDirty()).toBe(true);
      });

      it('moves every tab under a renamed folder', async () => {
        await service.openFile('proj/one.md');
        await service.openFile('proj/sub/two.md');
        await service.openFile('other.md');

        service.retargetTabs('proj', 'work');

        expect(service.openDocs().map((d) => d.path)).toEqual([
          'work/one.md',
          'work/sub/two.md',
          'other.md',
        ]);
      });

      it('does nothing when no tab matches', async () => {
        await service.openFile('a.md');
        service.retargetTabs('b.md', 'c.md');
        expect(service.openDocs().map((d) => d.path)).toEqual(['a.md']);
        expect(service.openPath()).toBe('a.md');
      });
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
        getActiveVault: () => Promise.resolve('E:/vault'),
        getActiveVaultId: () => Promise.resolve('v1'),
        listVaults: () =>
          Promise.resolve([
            { id: 'v1', name: 'vault', path: 'E:/vault', exists: true, active: true },
          ]),
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

      draftService.updateBuffer(
        'daily/2026/09/2026-09-06.md',
        '# 2026-09-06\n\n## 08:00\nEndlich getippt\n',
      );
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

  describe('openScratch', () => {
    it('opens a dirty draft tab and replaces it on a second call', () => {
      service.openScratch('search-results.md', '# Search results\n\nfirst\n');
      expect(service.openPath()).toBe('search-results.md');
      expect(service.activeIsDraft()).toBe(true);
      expect(service.bufferContent()).toBe('# Search results\n\nfirst\n');
      // Dirty from the start so the Save button is live without an edit first.
      expect(service.isDirty()).toBe(true);

      service.openScratch('search-results.md', '# Search results\n\nsecond\n');
      expect(service.openDocs().filter((d) => d.path === 'search-results.md')).toHaveLength(1);
      expect(service.bufferContent()).toBe('# Search results\n\nsecond\n');
      expect(service.isDirty()).toBe(true);
    });
  });

  describe('saveAs / save() on a scratch doc', () => {
    let saved: NoteSaveRequest[];
    let picked: string | null;
    let svc: EditorService;

    beforeEach(() => {
      TestBed.resetTestingModule();
      saved = [];
      picked = 'notes/kept.md';
      const api: Partial<DreyApi> = {
        readVaultFile: (p: string) => Promise.resolve({ content: `on disk: ${p}`, modifiedMs: 3 }),
        saveNote: (req: NoteSaveRequest) => {
          saved.push(req);
          return echoSave(req);
        },
        getActiveVault: () => Promise.resolve('E:/vault'),
        listVaultFiles: () => Promise.resolve([]),
        pickSavePath: () => Promise.resolve(picked),
      };
      window.dreyApi = api as DreyApi;
      svc = TestBed.inject(EditorService);
    });

    it('Ctrl+S on a scratch doc picks a location, writes there, and re-keys the tab', async () => {
      svc.openScratch('search-results.md', '# Results\n\nbody\n');
      await svc.save();

      expect(saved).toEqual([{ path: 'notes/kept.md', body: '# Results\n\nbody\n', eol: '\n' }]);
      expect(svc.openPath()).toBe('notes/kept.md');
      expect(svc.openDocs().some((d) => d.path === 'search-results.md')).toBe(false);
      expect(svc.activeIsDraft()).toBe(false);
    });

    it('does nothing when the save dialog is cancelled', async () => {
      picked = null;
      svc.openScratch('search-results.md', '# Results\n\nbody\n');
      await svc.save();

      expect(saved).toEqual([]);
      expect(svc.openPath()).toBe('search-results.md');
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

  describe('image tabs (kind: image, ADR-0026)', () => {
    it('opens an image file without reading it as text and never dirty', async () => {
      let reads = 0;
      (window.dreyApi as unknown as { readVaultFile: unknown }).readVaultFile = (p: string) => {
        reads++;
        return Promise.resolve({ content: `content of ${p}`, modifiedMs: 1 });
      };

      await service.openFile('assets/photo.png');

      expect(reads).toBe(0);
      expect(service.activeKind()).toBe('image');
      expect(service.openPath()).toBe('assets/photo.png');
      expect(service.bufferContent()).toBe('');
      expect(service.isDirty()).toBe(false);
      expect(service.activeIsDraft()).toBe(false);
    });

    it('save / saveAs / updateBuffer / setViewMode are no-ops on an image tab', async () => {
      await service.openFile('a/pic.jpg');
      service.updateBuffer('a/pic.jpg', 'junk');
      service.setViewMode('source');
      await service.save();
      await service.saveAs();

      expect(saves).toHaveLength(0);
      expect(service.bufferContent()).toBe('');
      expect(service.viewMode()).toBe('live');
    });

    it('dedupes on reopen and closes without a prompt / with closeTabsUnder', async () => {
      await service.openFile('img/a.png');
      await service.openFile('note.md');
      await service.openFile('img/a.png');
      expect(service.openDocs().filter((d) => d.path === 'img/a.png')).toHaveLength(1);

      service.closeTabsUnder(null, 'img');
      expect(service.openDocs().some((d) => d.path === 'img/a.png')).toBe(false);
    });

    it('the assistant insert request is a no-op while an image tab is active', async () => {
      await service.openFile('x.png');
      const before = service.insertRequest().id;
      service.requestInsertText('hello');
      expect(service.insertRequest().id).toBe(before);
    });
  });

  describe('pdf tabs (kind: pdf, ADR-0052)', () => {
    it('opens a pdf without reading it as text and never dirty', async () => {
      let reads = 0;
      (window.dreyApi as unknown as { readVaultFile: unknown }).readVaultFile = (p: string) => {
        reads++;
        return Promise.resolve({ content: `%PDF-1.7 ${p}`, modifiedMs: 1 });
      };

      await service.openFile('docs/spec.pdf');

      expect(reads).toBe(0);
      expect(service.activeKind()).toBe('pdf');
      expect(service.openPath()).toBe('docs/spec.pdf');
      expect(service.bufferContent()).toBe('');
      expect(service.isDirty()).toBe(false);
    });

    it('save / saveAs / updateBuffer / setViewMode are no-ops on a pdf tab', async () => {
      await service.openFile('docs/spec.pdf');
      service.updateBuffer('docs/spec.pdf', 'junk');
      service.setViewMode('source');
      await service.save();
      await service.saveAs();

      expect(saves).toHaveLength(0);
      expect(service.bufferContent()).toBe('');
      expect(service.viewMode()).toBe('live');
    });

    it('dedupes on reopen', async () => {
      await service.openFile('docs/spec.pdf');
      await service.openFile('note.md');
      await service.openFile('docs/spec.pdf');
      expect(service.openDocs().filter((d) => d.path === 'docs/spec.pdf')).toHaveLength(1);
    });

    it('closes cleanly (never dirty, no prompt)', async () => {
      await service.openFile('docs/spec.pdf');
      service.closeTab('docs/spec.pdf');
      expect(service.openDocs().some((d) => d.path === 'docs/spec.pdf')).toBe(false);
    });
  });

  describe('plugin doc tabs (kind: browser)', () => {
    it('addPluginDoc yields a non-dirty, non-text doc', () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      const doc = service.docFor('browser://1')!;
      expect(doc.kind).toBe('browser');
      expect(service.isDirty()).toBe(false);
      expect(service.activeKind()).toBe('browser');
    });

    it('save() and saveAll() skip a browser tab', async () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      await service.save();
      await service.saveAll();
      expect(saves).toEqual([]);
    });

    it('closeTab on a browser tab closes cleanly (never dirty, no prompt)', () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      // A browser doc has savedContent === bufferContent === '' so the
      // dirty check that would `confirm()` is never reached.
      service.closeTab('browser://1');
      expect(service.openDocs().some((d) => d.path === 'browser://1')).toBe(false);
    });

    it('renameDoc follows the page title but never touches a text doc', async () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      service.renameDoc('browser://1', 'Example');
      expect(service.docFor('browser://1')?.name).toBe('Example');
      await service.openFile('notes/a.md');
      service.renameDoc('notes/a.md', 'clobbered');
      expect(service.docFor('notes/a.md')?.name).toBe('a.md');
    });

    it('updateBuffer / setViewMode are no-ops on a browser tab', () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      service.updateBuffer('browser://1', 'nope');
      service.setViewMode('source', 'browser://1');
      const doc = service.docFor('browser://1')!;
      expect(doc.bufferContent).toBe('');
      expect(doc.viewMode).toBe('live');
    });
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

  describe('reloadFromVaultChange (ADR-0045 external-change auto-reload)', () => {
    function serviceWithDisk(
      files: Record<string, { content: string; modifiedMs: number } | null>,
    ): EditorService {
      TestBed.resetTestingModule();
      const diskApi: Partial<DreyApi> = {
        readVaultFile: (relativePath: string) => {
          const file = files[relativePath];
          if (file === undefined || file === null) {
            return Promise.reject(new Error(`not found: ${relativePath}`));
          }
          return Promise.resolve(file);
        },
        saveNote: (request: NoteSaveRequest) => echoSave(request),
      };
      window.dreyApi = diskApi as DreyApi;
      return TestBed.inject(EditorService);
    }

    it('reloads a clean tab from disk and stays clean', async () => {
      const files: Record<string, { content: string; modifiedMs: number }> = {
        'a.md': { content: 'version one', modifiedMs: 100 },
      };
      const diskService = serviceWithDisk(files);
      await diskService.openFile('a.md');
      expect(diskService.bufferContent()).toBe('version one');

      files['a.md'] = { content: 'version two', modifiedMs: 500 };
      await diskService.reloadFromVaultChange(undefined, ['a.md']);

      expect(diskService.bufferContent()).toBe('version two');
      expect(diskService.savedContent()).toBe('version two');
      expect(diskService.isDirty()).toBe(false);
    });

    it('leaves a dirty tab untouched', async () => {
      const diskService = serviceWithDisk({
        'a.md': { content: 'version two', modifiedMs: 500 },
      });
      await diskService.openFile('a.md');
      diskService.updateBuffer('a.md', 'my local edits');

      await diskService.reloadFromVaultChange(undefined, ['a.md']);

      expect(diskService.bufferContent()).toBe('my local edits');
      expect(diskService.isDirty()).toBe(true);
    });

    it('reloads a dirty CHAT tab — the note is the source of truth (ADR-0048)', async () => {
      const diskService = serviceWithDisk({
        'chats/2026/09/2026-09-13-topic.md': { content: '## User\n\nasked\n', modifiedMs: 500 },
      });
      await diskService.openFile('chats/2026/09/2026-09-13-topic.md');
      diskService.updateBuffer('chats/2026/09/2026-09-13-topic.md', 'my local edits');

      await diskService.reloadFromVaultChange(undefined, ['chats/2026/09/2026-09-13-topic.md']);

      expect(diskService.bufferContent()).toBe('## User\n\nasked\n');
      expect(diskService.isDirty()).toBe(false);
    });

    it('marks a tab draft-like when the file is gone', async () => {
      const files: Record<string, { content: string; modifiedMs: number } | null> = {
        'gone.md': { content: 'on disk', modifiedMs: 100 },
      };
      const diskService = serviceWithDisk(files);
      await diskService.openFile('gone.md');
      expect(diskService.bufferContent()).toBe('on disk');

      files['gone.md'] = null; // external delete
      await diskService.reloadFromVaultChange(undefined, ['gone.md']);

      const doc = diskService.docFor('gone.md');
      expect(doc?.existsOnDisk).toBe(false);
      expect(diskService.bufferContent()).toBe('on disk');
    });

    it('is a no-op when the push carries no paths (full refresh)', async () => {
      const diskService = serviceWithDisk({
        'a.md': { content: 'version two', modifiedMs: 500 },
      });
      await diskService.openFile('a.md');

      await diskService.reloadFromVaultChange(undefined, undefined);

      expect(diskService.bufferContent()).toBe('version two');
    });

    it('ignores tabs that are not in the changed set', async () => {
      const diskService = serviceWithDisk({
        'a.md': { content: 'version two', modifiedMs: 500 },
      });
      await diskService.openFile('a.md');

      await diskService.reloadFromVaultChange(undefined, ['other.md']);

      expect(diskService.bufferContent()).toBe('version two');
    });
  });

  describe('auto-save for app-owned files (ADR-0048 chats, .drafts)', () => {
    const DELAY = EditorService.AUTO_SAVE_DELAY_MS + 50;

    it('auto-saves an edited chat note after the idle and ends clean', async () => {
      await service.openFile('chats/2026/09/2026-09-13-topic.md');
      service.updateBuffer('chats/2026/09/2026-09-13-topic.md', 'first turn');
      expect(service.isDirty()).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, DELAY));

      expect(saves).toHaveLength(1);
      expect(saves[0].path).toBe('chats/2026/09/2026-09-13-topic.md');
      expect(service.isDirty()).toBe(false);
    });

    it('auto-saves an edited .drafts file, but never a regular note', async () => {
      await service.openFile('.drafts/unnamed-1.md');
      service.updateBuffer('.drafts/unnamed-1.md', 'draft edit');
      await service.openFile('note.md');
      service.updateBuffer('note.md', 'note edit');

      await new Promise((resolve) => setTimeout(resolve, DELAY));

      expect(saves.map((s) => s.path)).toEqual(['.drafts/unnamed-1.md']);
    });

    it('debounces a typing burst into one save', async () => {
      await service.openFile('chats/2026/09/x.md');
      service.updateBuffer('chats/2026/09/x.md', 'one');
      await new Promise((resolve) => setTimeout(resolve, 100));
      service.updateBuffer('chats/2026/09/x.md', 'one two');

      await new Promise((resolve) => setTimeout(resolve, DELAY));

      expect(saves).toHaveLength(1);
      expect(saves[0].body).toBe('one two');
    });
  });
});
