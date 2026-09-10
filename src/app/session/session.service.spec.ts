import { TestBed } from '@angular/core/testing';
import type { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { PaneService } from '../panes';
import { VaultService } from '../vault';
import { SessionService, type SessionSnapshot } from './session.service';

describe('SessionService', () => {
  let session: SessionService;
  let editor: EditorService;
  let panes: PaneService;
  const backups: Record<string, string> = { 'b-scratch': 'draft body', 'b-dirty': 'edited body' };

  beforeEach(() => {
    localStorage.clear();
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (p: string) => Promise.resolve({ content: `disk of ${p}`, modifiedMs: 1 }),
      listTags: () => Promise.resolve([]),
      onBrowserEvent: () => () => undefined,
      onBrowserOpenTab: () => () => undefined,
      createBrowserView: () => Promise.resolve(),
      destroyBrowserView: () => Promise.resolve(),
      setBrowserViewVisible: () => Promise.resolve(),
      readSessionBackup: (id: string) => Promise.resolve(backups[id] ?? null),
      writeSessionBackup: () => Promise.resolve(),
      listSessionBackups: () => Promise.resolve(['b-orphan', 'b-scratch']),
      deleteSessionBackups: () => Promise.resolve(),
    };
    window.dreyApi = fakeApi as DreyApi;
    session = TestBed.inject(SessionService);
    editor = TestBed.inject(EditorService);
    panes = TestBed.inject(PaneService);
    TestBed.inject(VaultService).activeVaultPath.set('E:/vault');
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.clear();
  });

  function writeSession(tabs: SessionSnapshot['tabs'], layout: SessionSnapshot['layout']): void {
    const snap: SessionSnapshot = { version: 1, savedAt: 1, vault: 'E:/vault', layout, tabs };
    localStorage.setItem('drey.session', JSON.stringify(snap));
  }

  it('returns false with no stored session', async () => {
    expect(await session.restore()).toBe(false);
  });

  it('returns false when the stored vault differs', async () => {
    writeSession(
      [{ path: 'a.md', kind: 'text', onDisk: true }],
      { root: { kind: 'leaf', paneId: 'p1' }, panes: { p1: { id: 'p1', tabs: ['a.md'], active: 'a.md' } }, focusedId: 'p1' },
    );
    TestBed.inject(VaultService).activeVaultPath.set('E:/other-vault');
    expect(await session.restore()).toBe(false);
  });

  it('re-opens a disk file, a scratch buffer and a browser tab into the saved layout', async () => {
    writeSession(
      [
        { path: 'notes/a.md', kind: 'text', onDisk: true },
        { path: 'untitled.md', kind: 'text', onDisk: false, backupId: 'b-scratch' },
        { path: 'browser://2', kind: 'browser', url: 'https://example.com' },
      ],
      {
        root: {
          kind: 'split',
          id: 's1',
          direction: 'row',
          children: [
            { kind: 'leaf', paneId: 'p1' },
            { kind: 'leaf', paneId: 'p2' },
          ],
          sizes: [1, 1],
        },
        panes: {
          p1: { id: 'p1', tabs: ['notes/a.md', 'untitled.md'], active: 'untitled.md' },
          p2: { id: 'p2', tabs: ['browser://2'], active: 'browser://2' },
        },
        focusedId: 'p2',
      },
    );

    const restored = await session.restore();

    expect(restored).toBe(true);
    const paths = editor.openDocs().map((d) => d.path).sort();
    expect(paths).toEqual(['browser://2', 'notes/a.md', 'untitled.md']);

    const scratch = editor.docFor('untitled.md')!;
    expect(scratch.kind).toBe('text');
    expect(scratch.bufferContent).toBe('draft body');
    expect(scratch.existsOnDisk).toBe(false);

    expect(editor.docFor('browser://2')?.kind).toBe('browser');
    expect(panes.pane('p1')?.tabs).toEqual(['notes/a.md', 'untitled.md']);
    expect(panes.pane('p2')?.tabs).toEqual(['browser://2']);
    expect(panes.focusedId()).toBe('p2');
  });

  it('re-applies unsaved edits over a disk file via its backup', async () => {
    writeSession(
      [{ path: 'notes/x.md', kind: 'text', onDisk: true, backupId: 'b-dirty' }],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { id: 'p1', tabs: ['notes/x.md'], active: 'notes/x.md' } },
        focusedId: 'p1',
      },
    );

    await session.restore();

    const doc = editor.docFor('notes/x.md')!;
    expect(doc.savedContent).toBe('disk of notes/x.md');
    expect(doc.bufferContent).toBe('edited body');
    expect(doc.bufferContent !== doc.savedContent).toBe(true);
  });

  it('skips a scratch tab whose backup is gone', async () => {
    writeSession(
      [{ path: 'untitled.md', kind: 'text', onDisk: false, backupId: 'missing' }],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { id: 'p1', tabs: ['untitled.md'], active: 'untitled.md' } },
        focusedId: 'p1',
      },
    );
    expect(await session.restore()).toBe(false);
    expect(editor.openDocs()).toHaveLength(0);
  });
});
