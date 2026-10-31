import { TestBed } from '@angular/core/testing';
import { ConfirmDialogService } from './confirm-dialog.service';
import { EditorService, stripFrontmatter } from './editor.service';
import { PaneService } from '../panes/pane.service';
import { SettingsService } from './settings.service';
import { AppConfig, DreyApi, NoteSaveRequest, NoteSaveResult } from '../../../shared/ipc-api';

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

    expect(saves).toEqual([
      { path: 'note.md', body: 'content of note.md + edit', eol: '\n', baseModifiedMs: 100 },
    ]);
    expect(service.savedContent()).toBe('content of note.md + edit');
    expect(service.isDirty()).toBe(false);
  });

  describe('in-app help documents (ADR-0070)', () => {
    it('opens read-only and pinned: view mode, clean buffer, help flag', () => {
      service.openHelpDoc('help/manual.md', 'User manual', '# Manual\r\n', 'manual/');

      const doc = service.docFor('help/manual.md');
      expect(doc).not.toBeNull();
      expect(doc?.kind).toBe('text');
      expect(doc?.name).toBe('User manual');
      expect(doc?.pinned).toBe(true);
      expect(doc?.viewMode).toBe('view');
      expect(doc?.help).toEqual({ assetBase: 'manual/' });
      // CRLF normalised, buffer === saved -- never dirty, never prompts.
      expect(doc?.savedContent).toBe('# Manual\n');
      expect(doc?.bufferContent).toBe('# Manual\n');
      expect(service.isDirty()).toBe(false);
      expect(service.isHelpDoc('help/manual.md')).toBe(true);
      expect(service.openAssetBase()).toBe('manual/');
    });

    it('cannot be edited: updateBuffer and setViewMode are no-ops', () => {
      service.openHelpDoc('help/shortcuts.md', 'Keyboard shortcuts', '# Keys');
      const before = service.docFor('help/shortcuts.md');

      service.updateBuffer('help/shortcuts.md', '# Changed');
      service.setViewMode('live', 'help/shortcuts.md');

      const after = service.docFor('help/shortcuts.md');
      expect(after?.bufferContent).toBe('# Keys');
      expect(after?.viewMode).toBe('view');
      expect(before?.bufferContent).toBe(after?.bufferContent);
    });

    it('saving a help doc writes nothing (clean buffer falls through)', async () => {
      service.openHelpDoc('help/manual.md', 'User manual', '# Manual');

      await service.save({ key: 'help/manual.md' });

      expect(saves).toEqual([]);
    });

    it('re-opening refreshes the content instead of adding a tab', () => {
      service.openHelpDoc('help/manual.md', 'User manual', '# v1');
      service.openHelpDoc('help/manual.md', 'User manual', '# v2');

      const docs = service.openDocs().filter((d) => d.key === 'help/manual.md');
      expect(docs).toHaveLength(1);
      expect(docs[0]?.bufferContent).toBe('# v2');
      expect(docs[0]?.savedContent).toBe('# v2');
    });
  });

  describe('caret memory (milestone 50)', () => {
    it('stores and updates the viewport (caret + scroll offset) per doc key', () => {
      service.recordCaret('note.md', { head: 7, scrollTop: 120, caretRel: 88 });
      expect(service.caretFor('note.md')).toEqual({ head: 7, scrollTop: 120, caretRel: 88 });
      service.recordCaret('note.md', { head: 42, scrollTop: 0 });
      expect(service.caretFor('note.md')).toEqual({ head: 42, scrollTop: 0 });
    });

    it('needs no open doc -- the memory is what outlives the tab', () => {
      service.recordCaret('ghost.md', { head: 3, scrollTop: 10 });
      expect(service.caretFor('ghost.md')).toEqual({ head: 3, scrollTop: 10 });
    });

    it('survives closing and reopening the tab (app-session scoped)', async () => {
      await service.openFile('note.md');
      service.recordCaret('note.md', { head: 9, scrollTop: 240 });
      await service.closeTab('note.md');
      expect(service.docFor('note.md')).toBeNull();
      // Remembered past the tab -- a clean tab replaced by another file
      // reopens on its viewport, not at the top.
      expect(service.caretFor('note.md')).toEqual({ head: 9, scrollTop: 240 });
    });
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
    expect(crlfSaves).toMatchObject([
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
    it('replaces the clean focused tab when another file opens', async () => {
      await service.openFile('a.md');
      await service.openFile('b.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['b.md']);
      expect(service.openPath()).toBe('b.md');
    });

    it('re-activates an already-open file without closing anything (reveal)', async () => {
      await service.openFile('a.md');
      await service.openFile('b.md', undefined, { keepFocused: true });
      await service.openFile('a.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md']);
      expect(service.openPath()).toBe('a.md');
    });

    it('opens alongside a dirty focused tab', async () => {
      await service.openFile('a.md');
      service.updateBuffer('a.md', 'content of a.md + edit');
      await service.openFile('b.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md']);
      expect(service.openPath()).toBe('b.md');
      expect(service.docFor('a.md')?.bufferContent).toBe('content of a.md + edit');
    });

    it('keeps the focused tab when it turned dirty while the new file was read', async () => {
      await service.openFile('a.md');
      // Gate b.md's read so the buffer edit lands while the open is in flight.
      let release: (() => void) | null = null;
      const base = window.dreyApi as DreyApi;
      window.dreyApi = {
        ...base,
        readVaultFile: (relativePath: string) =>
          relativePath === 'b.md'
            ? new Promise<{ content: string; modifiedMs: number }>((resolve) => {
                release = () => resolve({ content: 'content of b.md', modifiedMs: 100 });
              })
            : base.readVaultFile(relativePath),
      } as DreyApi;
      const opening = service.openFile('b.md');
      service.updateBuffer('a.md', 'typed during the read');
      release!();
      await opening;

      expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md']);
      expect(service.openPath()).toBe('b.md');
    });

    it('keeps the focused tab when the read of the new file fails', async () => {
      await service.openFile('a.md');
      (window.dreyApi as unknown as { readVaultFile: unknown }).readVaultFile = (p: string) =>
        p === 'gone.md'
          ? Promise.reject(new Error('ENOENT'))
          : Promise.resolve({ content: `content of ${p}`, modifiedMs: 1 });
      await service.openFile('gone.md');

      expect(service.openDocs().map((d) => d.path)).toEqual(['a.md']);
      expect(service.openPath()).toBe('a.md');
    });

    it('replaces a clean image or pdf viewer tab like any clean tab', async () => {
      await service.openFile('x.png');
      await service.openFile('note.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['note.md']);

      await service.openFile('docs/spec.pdf');
      expect(service.openDocs().map((d) => d.path)).toEqual(['docs/spec.pdf']);
    });

    it('never closes a plugin doc kind tab (its state is not behind the file)', async () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      await service.openFile('note.md');
      expect(service.openDocs().map((d) => d.key)).toEqual(['browser://1', 'note.md']);
      expect(service.openPath()).toBe('note.md');
    });

    it('replaces an empty untitled scratch tab, keeps a dirty one', async () => {
      service.newUntitled(); // empty buffer == empty saved content: clean
      await service.openFile('note.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['note.md']);

      service.openScratch('search-results.md', 'hits'); // dirty from the start
      await service.openFile('other.md');
      expect(service.openDocs().map((d) => d.path)).toEqual([
        'note.md',
        'search-results.md',
        'other.md',
      ]);
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
      await service.openFile('b.md', undefined, { keepFocused: true });
      await service.openFile('c.md', undefined, { keepFocused: true });

      service.activate('b.md');
      await service.closeTab('b.md');
      expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'c.md']);
      expect(service.openPath()).toBe('c.md');

      await service.closeTab('c.md');
      await service.closeTab('a.md');
      expect(service.openDocs()).toEqual([]);
      expect(service.openPath()).toBeNull();
    });

    describe('pinned tabs', () => {
      it('open pinned straight from openFile via the pinned option', async () => {
        await service.openFile('a.md', undefined, { pinned: true });
        await service.openFile('b.md'); // a plain open must not replace the pin

        expect(service.docFor('a.md')?.pinned).toBe(true);
        expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md']);
        expect(service.openPath()).toBe('b.md');
      });

      it('pin an already-open unpinned tab when reopened with the pinned option', async () => {
        await service.openFile('a.md');
        expect(service.docFor('a.md')?.pinned).toBeUndefined();
        await service.openFile('a.md', undefined, { pinned: true });

        expect(service.openDocs().map((d) => d.path)).toEqual(['a.md']); // revealed, not duplicated
        expect(service.docFor('a.md')?.pinned).toBe(true);
      });

      it('open image / pdf viewer tabs pinned via the pinned option', async () => {
        await service.openFile('x.png', undefined, { pinned: true });
        await service.openFile('docs/spec.pdf', undefined, { pinned: true });
        await service.openFile('note.md'); // a plain open replaces nothing

        expect(service.docFor('x.png')?.pinned).toBe(true);
        expect(service.docFor('docs/spec.pdf')?.pinned).toBe(true);
        expect(service.openDocs().map((d) => d.path)).toEqual([
          'x.png',
          'docs/spec.pdf',
          'note.md',
        ]);
      });

      it('are not replaced: the next file opens in a new tab beside them', async () => {
        await service.openFile('a.md');
        service.togglePin('a.md');
        await service.openFile('b.md');

        expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md']);
        expect(service.docFor('a.md')?.pinned).toBe(true);
        expect(service.openPath()).toBe('b.md');
      });

      it('hand the replacement to the unpinned tab when the pinned one is active', async () => {
        await service.openFile('a.md');
        service.togglePin('a.md');
        await service.openFile('b.md'); // beside the pin: [a, b]
        service.activate('a.md'); // the user looks at the pinned note again
        await service.openFile('c.md');

        expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'c.md']);
        expect(service.openPath()).toBe('c.md');
        expect(service.docFor('a.md')?.pinned).toBe(true);
      });

      it('open beside the pin when the only other tab is dirty', async () => {
        await service.openFile('a.md');
        service.togglePin('a.md');
        await service.openFile('b.md');
        service.updateBuffer('b.md', 'content of b.md + edit');
        service.activate('a.md');
        await service.openFile('c.md');

        expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md', 'c.md']);
        expect(service.docFor('b.md')?.bufferContent).toBe('content of b.md + edit');
      });

      it('never replace a second pinned tab', async () => {
        await service.openFile('a.md');
        service.togglePin('a.md');
        await service.openFile('b.md');
        service.togglePin('b.md');
        service.activate('a.md');
        await service.openFile('c.md');

        expect(service.openDocs().map((d) => d.path)).toEqual(['a.md', 'b.md', 'c.md']);
      });

      it('replace again once unpinned', async () => {
        await service.openFile('a.md');
        service.togglePin('a.md');
        service.togglePin('a.md');
        await service.openFile('b.md');

        expect(service.openDocs().map((d) => d.path)).toEqual(['b.md']);
      });

      it('also hold for image / pdf viewer tabs', async () => {
        await service.openFile('x.png');
        service.togglePin('x.png');
        await service.openFile('note.md');

        expect(service.openDocs().map((d) => d.path)).toEqual(['x.png', 'note.md']);
      });

      it('keep their pin across a rename on disk', async () => {
        await service.openFile('a.md');
        service.togglePin('a.md');
        service.retargetTabs('a.md', 'renamed.md');

        expect(service.docFor('renamed.md')?.pinned).toBe(true);
      });
    });

    describe('closing a dirty tab (Save / Don\'t save / Cancel)', () => {
      let decide: ReturnType<typeof vi.spyOn>;

      async function openDirty(): Promise<void> {
        await service.openFile('a.md');
        service.updateBuffer('a.md', 'content of a.md + edit');
      }

      beforeEach(() => {
        decide = vi.spyOn(TestBed.inject(ConfirmDialogService), 'decide');
      });

      it('Cancel keeps the tab open and its buffer intact', async () => {
        decide.mockResolvedValue('cancel');
        await openDirty();

        expect(await service.closeTab('a.md')).toBe(false);
        expect(service.docFor('a.md')?.bufferContent).toBe('content of a.md + edit');
        expect(saves).toEqual([]);
      });

      it("Don't save closes without writing", async () => {
        decide.mockResolvedValue('discard');
        await openDirty();

        expect(await service.closeTab('a.md')).toBe(true);
        expect(service.openDocs()).toEqual([]);
        expect(saves).toEqual([]);
      });

      it('Save writes the buffer, then closes', async () => {
        decide.mockResolvedValue('save');
        await openDirty();

        expect(await service.closeTab('a.md')).toBe(true);
        expect(saves).toMatchObject([{ path: 'a.md', body: 'content of a.md + edit', eol: '\n' }]);
        expect(service.openDocs()).toEqual([]);
      });

      it('Save keeps the tab open when the write fails', async () => {
        decide.mockResolvedValue('save');
        await openDirty();
        (window.dreyApi as unknown as { saveNote: unknown }).saveNote = () =>
          Promise.reject(new Error('EACCES'));

        expect(await service.closeTab('a.md')).toBe(false);
        expect(service.docFor('a.md')?.bufferContent).toBe('content of a.md + edit');
        expect(service.error()).toBe('EACCES');
      });

      it('never asks for a clean tab', async () => {
        await service.openFile('a.md');

        expect(await service.closeTab('a.md')).toBe(true);
        expect(decide).not.toHaveBeenCalled();
      });
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
        await service.openFile('proj/sub/two.md', undefined, { keepFocused: true });
        await service.openFile('other.md', undefined, { keepFocused: true });

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

    it('replaces the clean focused tab; a dirty one stays', async () => {
      await service.openFile('a.md');
      await service.openDailyNote('2026-09-05');
      expect(service.openDocs().map((d) => d.path)).toEqual(['daily/2026/09/2026-09-05.md']);

      await service.openFile('b.md', undefined, { keepFocused: true });
      service.updateBuffer('b.md', 'edit');
      await service.openDailyNote('2026-09-06');
      // The first daily tab (clean) is still there from the phase above --
      // only b.md, dirty, blocked the replacement here.
      expect(service.openDocs().map((d) => d.path)).toEqual([
        'daily/2026/09/2026-09-05.md',
        'b.md',
        'daily/2026/09/2026-09-06.md',
      ]);
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

    it('opens an existing daily note in the configured folder', async () => {
      TestBed.resetTestingModule();
      const journalApi: Partial<DreyApi> = {
        getConfig: () => Promise.resolve({ daily: { dir: 'Journal' } } as AppConfig),
        readVaultFile: (relativePath: string) =>
          relativePath === 'Journal/2026/09/2026-09-05.md'
            ? Promise.resolve({ content: 'journal body', modifiedMs: 1 })
            : Promise.reject(new Error('ENOENT')),
      };
      window.dreyApi = journalApi as DreyApi;
      await TestBed.inject(SettingsService).load();
      const journalService = TestBed.inject(EditorService);

      await journalService.openDailyNote('2026-09-05');
      expect(journalService.openPath()).toBe('Journal/2026/09/2026-09-05.md');
      expect(journalService.bufferContent()).toBe('journal body');
      expect(journalService.activeIsDraft()).toBe(false);
    });

    it('falls back to a flat file inside the configured folder', async () => {
      TestBed.resetTestingModule();
      const flatApi: Partial<DreyApi> = {
        getConfig: () => Promise.resolve({ daily: { dir: 'Journal' } } as AppConfig),
        readVaultFile: (relativePath: string) =>
          relativePath === 'Journal/2026-09-05.md'
            ? Promise.resolve({ content: 'flat body', modifiedMs: 1 })
            : Promise.reject(new Error('ENOENT')),
      };
      window.dreyApi = flatApi as DreyApi;
      await TestBed.inject(SettingsService).load();
      const flatService = TestBed.inject(EditorService);

      await flatService.openDailyNote('2026-09-05');
      expect(flatService.openPath()).toBe('Journal/2026-09-05.md');
      expect(flatService.bufferContent()).toBe('flat body');
    });

    it('never reads the old daily/ root once the folder is configured', async () => {
      TestBed.resetTestingModule();
      const reads: string[] = [];
      const strictApi: Partial<DreyApi> = {
        getConfig: () => Promise.resolve({ daily: { dir: 'Journal' } } as AppConfig),
        readVaultFile: (relativePath: string) => {
          reads.push(relativePath);
          return Promise.reject(new Error('ENOENT'));
        },
        buildDailyNoteContent: () => Promise.resolve('# 2026-09-06\n'),
      };
      window.dreyApi = strictApi as DreyApi;
      await TestBed.inject(SettingsService).load();
      const strictService = TestBed.inject(EditorService);

      await strictService.openDailyNote('2026-09-06');
      // A draft at the configured path; nothing under the old daily/ root
      // was probed (configured-folder-only reads).
      expect(strictService.openPath()).toBe('Journal/2026/09/2026-09-06.md');
      expect(strictService.activeIsDraft()).toBe(true);
      expect(reads).toEqual(['Journal/2026/09/2026-09-06.md', 'Journal/2026-09-06.md']);
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
          // A draft says "there is no file yet" (ADR-0060).
          baseModifiedMs: 0,
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

  describe('external (out-of-vault) documents (ADR-0054)', () => {
    const EXTERNAL = 'C:\\Users\\me\\Downloads\\note.md';
    const KEY = 'external://C:/Users/me/Downloads/note.md';
    let saved: NoteSaveRequest[];
    let written: Array<{ path: string; content: string }>;
    let picked: string | null;
    let svc: EditorService;

    beforeEach(() => {
      TestBed.resetTestingModule();
      saved = [];
      written = [];
      picked = 'notes/kept.md';
      const api: Partial<DreyApi> = {
        writeExternalFile: (path: string, content: string) => {
          written.push({ path, content });
          return Promise.resolve(99);
        },
        readExternalFile: () => Promise.resolve({ content: '# From outside\r\n\r\nbody\r\n', modifiedMs: 7 }),
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

    it('opens as a pinned, editable text tab keyed external://', async () => {
      await svc.openExternalFile(EXTERNAL);

      const doc = svc.docFor(KEY);
      expect(doc).not.toBeNull();
      expect(doc?.external).toBe(true);
      expect(doc?.pinned).toBe(true);
      expect(doc?.vaultId).toBeNull();
      expect(doc?.name).toBe('note.md');
      expect(doc?.path).toBe(EXTERNAL);
      expect(doc?.bufferContent).toBe('# From outside\n\nbody\n');
      expect(svc.isExternal(KEY)).toBe(true);
      expect(svc.isDirty()).toBe(false);
    });

    it('reveals the already-open tab instead of opening a second one', async () => {
      await svc.openExternalFile(EXTERNAL);
      await svc.openExternalFile(EXTERNAL);
      expect(svc.openDocs().filter((d) => d.external)).toHaveLength(1);
    });

    it('opening it replaces nothing, and it is never the tab the next file replaces', async () => {
      await svc.openFile('a.md');
      await svc.openExternalFile(EXTERNAL);
      expect(svc.openDocs().map((d) => d.path)).toEqual(['a.md', EXTERNAL]);

      // Pinned + active: the next file reuses the clean unpinned "preview"
      // tab (milestone 35) -- the external tab itself stays.
      await svc.openFile('b.md');
      expect(svc.openDocs().map((d) => d.path)).toEqual([EXTERNAL, 'b.md']);
    });

    it('turns dirty on an edit', async () => {
      await svc.openExternalFile(EXTERNAL);
      svc.updateBuffer(KEY, '# Edited\n');

      expect(svc.docFor(KEY)?.bufferContent).toBe('# Edited\n');
      expect(svc.isDirty()).toBe(true);
    });

    it('saves in place through writeExternalFile, restoring the file line endings', async () => {
      await svc.openExternalFile(EXTERNAL);
      svc.updateBuffer(KEY, '# Edited\n\nbody\n');
      await svc.save();

      expect(written).toEqual([{ path: EXTERNAL, content: '# Edited\r\n\r\nbody\r\n' }]);
      expect(saved).toEqual([]); // none of the vault pipeline
      expect(svc.docFor(KEY)?.savedContent).toBe('# Edited\n\nbody\n');
      expect(svc.docFor(KEY)?.modifiedMs).toBe(99);
      expect(svc.isDirty()).toBe(false);
    });

    it('does not write an unchanged buffer', async () => {
      await svc.openExternalFile(EXTERNAL);
      await svc.save({ key: KEY });

      expect(written).toEqual([]);
    });

    it('keeps the tab dirty and reports the error when the write is refused', async () => {
      window.dreyApi = {
        ...(window.dreyApi as DreyApi),
        writeExternalFile: () => Promise.reject(new Error('no longer exists')),
      };
      await svc.openExternalFile(EXTERNAL);
      svc.updateBuffer(KEY, '# Edited\n');
      await svc.save();

      expect(svc.isDirty()).toBe(true);
      expect(svc.error()).toBe('no longer exists');
    });

    it('has no pin toggle', async () => {
      await svc.openExternalFile(EXTERNAL);
      svc.togglePin(KEY);
      expect(svc.docFor(KEY)?.pinned).toBe(true);
    });

    it('Save as… copies it into the vault and swaps the tab for that copy', async () => {
      await svc.openExternalFile(EXTERNAL);
      await svc.saveAs(KEY);

      expect(saved).toEqual([{ path: 'notes/kept.md', body: '# From outside\n\nbody\n', eol: '\r\n' }]);
      expect(svc.docFor(KEY)).toBeNull();
      const copy = svc.docFor('notes/kept.md');
      expect(copy?.external).toBeUndefined();
      expect(copy?.pinned).toBe(true); // the pin travels with the tab
    });

    it('reports an unreadable file as an error and opens nothing', async () => {
      window.dreyApi = {
        ...(window.dreyApi as DreyApi),
        readExternalFile: () => Promise.reject(new Error('not allowed')),
      };
      await svc.openExternalFile(EXTERNAL);

      expect(svc.openDocs()).toEqual([]);
      expect(svc.error()).toBe('not allowed');
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

    it("stores and restores a 'view' default", async () => {
      localStorage.setItem('drey.editor', JSON.stringify({ defaultMode: 'view' }));
      await service.openFile('a.md');
      expect(service.viewMode()).toBe('view');
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

  describe('documents that open in their own program (ADR-0066)', () => {
    it('hands an Office file to the OS instead of opening a tab', async () => {
      const opened: string[] = [];
      let reads = 0;
      const api = window.dreyApi as unknown as {
        readVaultFile: unknown;
        openVaultFileExternally: unknown;
      };
      api.readVaultFile = () => {
        reads++;
        return Promise.resolve({ content: 'PK', modifiedMs: 1 });
      };
      api.openVaultFileExternally = (path: string) => {
        opened.push(path);
        return Promise.resolve();
      };
      const before = service.openDocs().map((d) => d.path);

      await service.openFile('docs/Report.DOCX');

      expect(opened).toEqual(['docs/Report.DOCX']);
      expect(reads).toBe(0);
      expect(service.openDocs().map((d) => d.path)).toEqual(before);
    });

    it('shows the reason when the OS cannot open it', async () => {
      (window.dreyApi as unknown as { openVaultFileExternally: unknown }).openVaultFileExternally =
        () => Promise.reject(new Error('File not found: x.xlsx'));

      await service.openFile('x.xlsx');

      expect(service.error()).toBe('File not found: x.xlsx');
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
      await service.closeTab('docs/spec.pdf');
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

    it('closeTab on a browser tab closes cleanly (never dirty, no prompt)', async () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      // A browser doc has savedContent === bufferContent === '' so the
      // dirty check that would prompt is never reached.
      await service.closeTab('browser://1');
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

  describe('split open (SDK 1.35)', () => {
    let panes: PaneService;

    beforeEach(() => {
      panes = TestBed.inject(PaneService);
    });

    it("split: 'right' opens the file in a fresh pane beside the focused one", async () => {
      await service.openFile('notes/a.md');
      await service.openFile('notes/b.md', undefined, { split: 'right' });

      expect(panes.paneIds().length).toBe(2);
      const focused = panes.focusedPane()!;
      expect(focused.tabs).toEqual(['notes/b.md']);
      expect(service.activePath()).toBe('notes/b.md');
      const other = panes.paneIds().find((id) => id !== focused.id)!;
      expect(panes.pane(other)).toEqual({ id: other, tabs: ['notes/a.md'], active: 'notes/a.md' });
      // side by side: a row split at the root
      expect(panes.root()).toEqual({
        kind: 'split',
        id: expect.any(String),
        direction: 'row',
        children: [{ kind: 'leaf', paneId: other }, { kind: 'leaf', paneId: focused.id }],
        sizes: [1, 1],
      });
    });

    it("split: 'down' opens the file in a fresh pane below (a column split)", async () => {
      await service.openFile('notes/a.md');
      await service.openFile('notes/b.md', undefined, { split: 'down' });

      expect(panes.paneIds().length).toBe(2);
      const focused = panes.focusedPane()!;
      const other = panes.paneIds().find((id) => id !== focused.id)!;
      expect(panes.root()).toEqual({
        kind: 'split',
        id: expect.any(String),
        direction: 'column',
        children: [{ kind: 'leaf', paneId: other }, { kind: 'leaf', paneId: focused.id }],
        sizes: [1, 1],
      });
      expect(focused.tabs).toEqual(['notes/b.md']);
    });

    it('an already-open tab just reveals -- the split option is not applied', async () => {
      await service.openFile('notes/a.md');
      await service.openFile('notes/b.md', undefined, { split: 'right' });
      const ids = panes.paneIds();

      await service.openFile('notes/a.md', undefined, { split: 'right' });

      expect(panes.paneIds()).toEqual(ids);
      expect(panes.focusedPane()!.tabs).toEqual(['notes/a.md']);
    });

    it('addPluginDoc with split lands the tab in a fresh sibling pane', () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab', { split: 'right' });

      expect(panes.paneIds().length).toBe(2);
      expect(panes.focusedPane()!.tabs).toEqual(['browser://1']);
      expect(service.activePath()).toBe('browser://1');
    });

    it('addPluginDoc of an already-open key reveals it, no split', () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      service.addPluginDoc('browser', 'browser://2', 'Second', { split: 'right' });
      const ids = panes.paneIds();

      service.addPluginDoc('browser', 'browser://1', 'New tab', { split: 'right' });

      expect(panes.paneIds()).toEqual(ids);
      expect(panes.focusedPane()!.tabs).toEqual(['browser://1']);
    });

    it('a focused dock band cannot split -- the tab opens there plainly', async () => {
      await service.openFile('notes/a.md');
      const p1 = panes.focusedId();
      panes.detachToDock(p1, 'right'); // focuses the docked p1

      await service.openFile('notes/b.md', undefined, { split: 'right' });

      expect(panes.pane(p1)!.tabs).toEqual(['notes/a.md', 'notes/b.md']);
      expect(panes.dockPane('right')).toBe(p1);
      // the centre kept its single placeholder leaf -- nothing split
      expect(panes.root().kind).toBe('leaf');
    });
  });

  describe('beside anchor (SDK 1.37)', () => {
    let panes: PaneService;

    beforeEach(() => {
      panes = TestBed.inject(PaneService);
    });

    it('a plain open lands in the anchor pane, replacing its clean active tab', async () => {
      await service.openFile('notes/a.md');
      const anchor = panes.focusedId();
      await service.openFile('notes/b.md', undefined, { split: 'right' }); // focus: the fresh pane

      await service.openFile('notes/c.md', undefined, { beside: 'notes/a.md' });

      // The victim came from the ANCHOR pane: c.md replaced a.md there,
      // and the pane that happened to be focused kept its tab.
      expect(panes.pane(anchor)!.tabs).toEqual(['notes/c.md']);
      expect(panes.focusedPane()!.active).toBe('notes/c.md');
      const other = panes.paneIds().find((id) => id !== anchor)!;
      expect(panes.pane(other)!.tabs).toEqual(['notes/b.md']);
    });

    it('an anchor that is not open is a no-op -- the focused pane decides, as before', async () => {
      await service.openFile('notes/a.md');
      await service.openFile('notes/b.md', undefined, { split: 'right' }); // focus: the fresh pane
      const focused = panes.focusedId();

      await service.openFile('notes/c.md', undefined, { beside: 'notes/gone.md' });

      // Today's behaviour unchanged: the focused pane's clean tab (b.md) is replaced.
      expect(panes.paneIds().length).toBe(2);
      expect(panes.pane(focused)!.tabs).toEqual(['notes/c.md']);
    });

    it('an already-open key reveals exactly as today -- the anchor option is moot', async () => {
      await service.openFile('notes/a.md');
      const anchor = panes.focusedId();
      await service.openFile('notes/b.md', undefined, { split: 'right' });
      const ids = panes.paneIds();

      await service.openFile('notes/a.md', undefined, { beside: 'notes/b.md' });

      expect(panes.paneIds()).toEqual(ids);
      expect(panes.focusedId()).toBe(anchor);
      expect(panes.focusedPane()!.active).toBe('notes/a.md');
    });

    it('beside + split opens the fresh pane off the anchor pane, never replacing in it', async () => {
      await service.openFile('notes/a.md');
      const anchor = panes.focusedId();
      await service.openFile('notes/b.md', undefined, { split: 'right' });
      const bPane = panes.focusedId();

      await service.openFile('notes/c.md', undefined, { beside: 'notes/a.md', split: 'right' });

      expect(panes.paneIds().length).toBe(3);
      const fresh = panes.paneIds().find((id) => id !== anchor && id !== bPane)!;
      // The split happened at the anchor pane: a.md and c.md are siblings.
      expect(panes.root()).toEqual({
        kind: 'split',
        id: expect.any(String),
        direction: 'row',
        children: [
          {
            kind: 'split',
            id: expect.any(String),
            direction: 'row',
            children: [
              { kind: 'leaf', paneId: anchor },
              { kind: 'leaf', paneId: fresh },
            ],
            sizes: [1, 1],
          },
          { kind: 'leaf', paneId: bPane },
        ],
        sizes: [1, 1],
      });
      expect(panes.pane(anchor)!.tabs).toEqual(['notes/a.md']);
      expect(panes.pane(fresh)!.tabs).toEqual(['notes/c.md']);
    });

    it('addPluginDoc lands the tab in the anchor pane named by a contributed key', () => {
      service.addPluginDoc('browser', 'browser://1', 'New tab');
      const anchor = panes.focusedId();
      service.addPluginDoc('browser', 'browser://2', 'Second', { split: 'right' }); // focus: the fresh pane

      service.addPluginDoc('tickets', 'thread://ticket', 'Ticket thread', { beside: 'browser://1' });

      expect(panes.pane(anchor)!.tabs).toEqual(['browser://1', 'thread://ticket']);
      expect(panes.focusedPane()!.active).toBe('thread://ticket');
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
