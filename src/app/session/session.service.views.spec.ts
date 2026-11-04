import { TestBed } from '@angular/core/testing';
import type { DreyApi } from '../../../shared/ipc-api';
import { PaneService } from '../panes';
import { EditorService } from '../services/editor.service';
import { VaultService } from '../vault';
import { ViewService } from '../views';
import { SessionService, type SessionSnapshot } from './session.service';

const VAULT_ID = 'v1';

describe('SessionService views (ADR-0089)', () => {
  let session: SessionService;
  let editor: EditorService;
  let panes: PaneService;
  let views: ViewService;

  beforeEach(async () => {
    localStorage.clear();
  });

  async function boot(): Promise<void> {
    window.dreyApi = {
      getActiveVault: () => Promise.resolve('E:/vault'),
      getActiveVaultId: () => Promise.resolve(VAULT_ID),
      listVaults: () =>
        Promise.resolve([{ id: VAULT_ID, name: 'vault', path: 'E:/vault', exists: true, active: true }]),
      listVaultFiles: () => Promise.resolve([]),
      readVaultFile: (p: string) => Promise.resolve({ content: `disk of ${p}`, modifiedMs: 1 }),
      readSessionBackup: () => Promise.resolve(null),
      writeSessionBackup: () => Promise.resolve(),
      listSessionBackups: () => Promise.resolve([]),
      deleteSessionBackups: () => Promise.resolve(),
    } as unknown as DreyApi;
    session = TestBed.inject(SessionService);
    editor = TestBed.inject(EditorService);
    panes = TestBed.inject(PaneService);
    views = TestBed.inject(ViewService);
    TestBed.inject(VaultService);
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
  }

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.clear();
  });

  function tab(path: string): Record<string, unknown> {
    return { vaultId: VAULT_ID, path, kind: 'text', onDisk: true };
  }
  const key = (path: string): string => `${VAULT_ID}::${path}`;

  it('writes the Notes layout as `layout` and every other view under `views`', async () => {
    await boot();
    await editor.openFile('a.md');
    const second = views.saveCurrentAs('Second');
    await editor.openFile('b.md', undefined, { keepFocused: true });
    await session.flushNow();

    const snap = JSON.parse(localStorage.getItem('drey.session')!) as SessionSnapshot;
    expect(snap.layout.panes[snap.layout.focusedId].tabs).toEqual([key('a.md')]);
    expect(Object.keys(snap.views!)).toEqual([second]);
    const secondTabs = Object.values(snap.views![second].panes).flatMap((p) => p.tabs);
    expect(secondTabs).toEqual([key('a.md'), key('b.md')]);
    expect(snap.tabs.map((t) => t.path).sort()).toEqual(['a.md', 'b.md']);
  });

  it('restores every view with its own tabs and the active one on screen', async () => {
    localStorage.setItem('drey.views', JSON.stringify({ views: [{ id: 'work', label: 'Work' }] }));
    localStorage.setItem('drey.dock', JSON.stringify({ active: 'work', views: { work: {} } }));
    const leaf = (id: string, tabs: string[]) => ({
      root: { kind: 'leaf', paneId: id },
      panes: { [id]: { id, tabs: tabs.map(key), active: key(tabs[0]) } },
      focusedId: id,
    });
    localStorage.setItem(
      'drey.session',
      JSON.stringify({
        version: 2,
        savedAt: 1,
        layout: leaf('p1', ['note.md']),
        tabs: [tab('note.md'), tab('ticket.md'), tab('shared.md')],
        views: { work: leaf('p2', ['ticket.md', 'shared.md']) },
      }),
    );
    await boot();

    expect(await session.restore()).toBe(true);
    expect(views.activeId()).toBe('work');
    expect(panes.tabsOfView('work')).toEqual([key('ticket.md'), key('shared.md')]);
    expect(panes.tabsOfView('notes')).toEqual([key('note.md')]);
    expect(editor.openDocs().length).toBe(3);
    views.switchTo('notes');
    expect(editor.activePath()).toBe(key('note.md'));
  });

  it('a snapshot without views restores into Notes', async () => {
    localStorage.setItem(
      'drey.session',
      JSON.stringify({
        version: 2,
        savedAt: 1,
        layout: {
          root: { kind: 'leaf', paneId: 'p1' },
          panes: { p1: { id: 'p1', tabs: [key('a.md')], active: key('a.md') } },
          focusedId: 'p1',
        },
        tabs: [tab('a.md')],
      }),
    );
    await boot();
    expect(await session.restore()).toBe(true);
    expect(views.activeId()).toBe('notes');
    expect(panes.tabsOfView('notes')).toEqual([key('a.md')]);
  });

  it('drops the layout of a view that no longer exists', async () => {
    localStorage.setItem(
      'drey.session',
      JSON.stringify({
        version: 2,
        savedAt: 1,
        layout: {
          root: { kind: 'leaf', paneId: 'p1' },
          panes: { p1: { id: 'p1', tabs: [key('a.md')], active: key('a.md') } },
          focusedId: 'p1',
        },
        tabs: [tab('a.md'), tab('ghost.md')],
        views: {
          gone: {
            root: { kind: 'leaf', paneId: 'p2' },
            panes: { p2: { id: 'p2', tabs: [key('ghost.md')], active: key('ghost.md') } },
            focusedId: 'p2',
          },
        },
      }),
    );
    await boot();
    await session.restore();
    expect(panes.allTabKeys()).toEqual(new Set([key('a.md')]));
  });
});
