import { TestBed } from '@angular/core/testing';
import type { DreyApi } from '../../../shared/ipc-api';
import { DocKindRegistry } from '../plugin-host';
import { EditorService } from '../services/editor.service';
import { PaneService } from '../panes';
import { VaultService } from '../vault';
import { SessionService, type SessionSnapshot } from './session.service';

describe('SessionService', () => {
  let session: SessionService;
  let editor: EditorService;
  let panes: PaneService;
  const backups: Record<string, string> = { 'b-scratch': 'draft body', 'b-dirty': 'edited body' };
  /** `restore` calls the fake browser doc kind recorded, payload included. */
  let restoredKinds: Array<{ kind: string; path: string; data: unknown }>;

  beforeEach(() => {
    localStorage.clear();
    restoredKinds = [];
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (p: string) => Promise.resolve({ content: `disk of ${p}`, modifiedMs: 1 }),
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

    // A doc-kind contribution standing in for the browser (ADR-0044
    // stage 8A): restore records the payload and re-registers the tab.
    TestBed.inject(DocKindRegistry).register({
      kind: 'browser',
      serialize: (path) => ({ url: `https://serialized/${path}` }),
      mount: () => () => undefined,
      restore: (path, data) => {
        restoredKinds.push({ kind: 'browser', path, data });
        editor.addPluginDoc('browser', path, 'New tab');
      },
    });
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

  it('re-opens a disk file, a scratch buffer and a doc-kind tab into the saved layout', async () => {
    writeSession(
      [
        { path: 'notes/a.md', kind: 'text', onDisk: true },
        { path: 'untitled.md', kind: 'text', onDisk: false, backupId: 'b-scratch' },
        { path: 'browser://2', kind: 'browser', data: { url: 'https://example.com' } },
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

    // The doc-kind tab went through the registry, payload intact.
    expect(restoredKinds).toEqual([
      { kind: 'browser', path: 'browser://2', data: { url: 'https://example.com' } },
    ]);
    expect(editor.docFor('browser://2')?.kind).toBe('browser');
    expect(panes.pane('p1')?.tabs).toEqual(['notes/a.md', 'untitled.md']);
    expect(panes.pane('p2')?.tabs).toEqual(['browser://2']);
    expect(panes.focusedId()).toBe('p2');
  });

  it('hands pre-registry snapshots (payload at the top level) to the kind as-is', async () => {
    writeSession(
      [{ path: 'browser://1', kind: 'browser', url: 'https://legacy.example' } as unknown as SessionSnapshot['tabs'][number]],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { id: 'p1', tabs: ['browser://1'], active: 'browser://1' } },
        focusedId: 'p1',
      },
    );

    expect(await session.restore()).toBe(true);
    expect(restoredKinds).toEqual([
      { kind: 'browser', path: 'browser://1', data: { path: 'browser://1', kind: 'browser', url: 'https://legacy.example' } },
    ]);
  });

  it('drops a doc-kind tab whose kind is not registered (plugin disabled since)', async () => {
    writeSession(
      [{ path: 'gone://1', kind: 'extinct-kind', data: null }],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { id: 'p1', tabs: ['gone://1'], active: 'gone://1' } },
        focusedId: 'p1',
      },
    );

    expect(await session.restore()).toBe(false);
    expect(editor.openDocs()).toHaveLength(0);
    expect(restoredKinds).toEqual([]);
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
