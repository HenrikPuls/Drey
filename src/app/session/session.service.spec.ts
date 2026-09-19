import { TestBed } from '@angular/core/testing';
import type { DreyApi } from '../../../shared/ipc-api';
import { DocKindRegistry } from '../plugin-host';
import { EditorService } from '../services/editor.service';
import { PaneService } from '../panes';
import { VaultService } from '../vault';
import { SessionService, type SessionSnapshot } from './session.service';

const VAULT_ID = 'v1';
const VAULT_PATH = 'E:/vault';

describe('SessionService', () => {
  let session: SessionService;
  let editor: EditorService;
  let panes: PaneService;
  const backups: Record<string, string> = { 'b-scratch': 'draft body', 'b-dirty': 'edited body' };
  /** `restore` calls the fake browser doc kind recorded, payload included. */
  let restoredKinds: Array<{ kind: string; path: string; data: unknown }>;
  /** The registered vault path -- flipped by tests to simulate a vault change. */
  let vaultPath: string;

  beforeEach(async () => {
    localStorage.clear();
    restoredKinds = [];
    vaultPath = VAULT_PATH;
    const fakeApi: Partial<DreyApi> = {
      getActiveVault: () => Promise.resolve(vaultPath),
      getActiveVaultId: () => Promise.resolve(vaultPath === VAULT_PATH ? VAULT_ID : 'v2'),
      listVaults: () =>
        Promise.resolve([
          {
            id: vaultPath === VAULT_PATH ? VAULT_ID : 'v2',
            name: 'vault',
            path: vaultPath,
            exists: true,
            active: true,
          },
        ]),
      listVaultFiles: () => Promise.resolve([]),
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
    TestBed.inject(VaultService);
    // Let the registry load (getActiveVaultId + listVaults) settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

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

  function writeSession(
    tabs: ReadonlyArray<Record<string, unknown>>,
    layout: SessionSnapshot['layout'],
    version: 1 | 2 = 2,
  ): void {
    const snap =
      version === 2
        ? { version: 2, savedAt: 1, layout, tabs }
        : // A v1 snapshot as the pre-registry app wrote it: one global vault,
          // bare relative paths in the layout.
          {
            version: 1,
            savedAt: 1,
            vault: vaultPath,
            layout: {
              ...layout,
              panes: Object.fromEntries(
                Object.entries(layout.panes).map(([id, pane]) => [
                  id,
                  {
                    ...pane,
                    tabs: pane.tabs.map((p) => p.replace(`${VAULT_ID}::`, '')),
                    active: pane.active?.replace(`${VAULT_ID}::`, '') ?? null,
                  },
                ]),
              ),
            },
            tabs: tabs.map((t) => {
              const { vaultId: _ignored, ...rest } = t as { vaultId?: unknown };
              return rest;
            }),
          };
    localStorage.setItem('drey.session', JSON.stringify(snap));
  }

  it('returns false with no stored session', async () => {
    expect(await session.restore()).toBe(false);
  });

  it('returns false when the stored v1 vault differs', async () => {
    writeSession(
      [{ vaultId: VAULT_ID, path: 'a.md', kind: 'text', onDisk: true }],
      { root: { kind: 'leaf', paneId: 'p1' }, panes: { p1: { id: 'p1', tabs: [`${VAULT_ID}::a.md`], active: `${VAULT_ID}::a.md` } }, focusedId: 'p1' },
    );
    vaultPath = 'E:/other-vault';
    await TestBed.inject(VaultService).refresh();

    expect(await session.restore()).toBe(false);
  });

  it('re-opens a disk file, a scratch buffer and a doc-kind tab into the saved layout', async () => {
    writeSession(
      [
        { vaultId: VAULT_ID, path: 'notes/a.md', kind: 'text', onDisk: true },
        { vaultId: null, path: 'untitled.md', kind: 'text', onDisk: false, backupId: 'b-scratch' },
        { vaultId: null, path: 'browser://2', kind: 'browser', data: { url: 'https://example.com' } },
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
          p1: {
            id: 'p1',
            tabs: [`${VAULT_ID}::notes/a.md`, 'untitled.md'],
            active: 'untitled.md',
          },
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

    // The vault file is keyed into its vault's namespace.
    const diskDoc = editor.docFor(`${VAULT_ID}::notes/a.md`)!;
    expect(diskDoc.vaultId).toBe(VAULT_ID);

    // The doc-kind tab went through the registry, payload intact.
    expect(restoredKinds).toEqual([
      { kind: 'browser', path: 'browser://2', data: { url: 'https://example.com' } },
    ]);
    expect(editor.docFor('browser://2')?.kind).toBe('browser');
    expect(panes.pane('p1')?.tabs).toEqual([`${VAULT_ID}::notes/a.md`, 'untitled.md']);
    expect(panes.pane('p2')?.tabs).toEqual(['browser://2']);
    expect(panes.focusedId()).toBe('p2');
  });

  it('restores every disk tab side by side (no clean-focused-tab replacement)', async () => {
    // Regression guard: restore passes `keepFocused` into `openFile`, whose
    // default would otherwise close each clean tab when the next one opens.
    writeSession(
      [
        { vaultId: VAULT_ID, path: 'notes/a.md', kind: 'text', onDisk: true },
        { vaultId: VAULT_ID, path: 'notes/b.md', kind: 'text', onDisk: true },
      ],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: {
          p1: {
            id: 'p1',
            tabs: [`${VAULT_ID}::notes/a.md`, `${VAULT_ID}::notes/b.md`],
            active: `${VAULT_ID}::notes/b.md`,
          },
        },
        focusedId: 'p1',
      },
    );

    expect(await session.restore()).toBe(true);
    expect(panes.pane('p1')?.tabs).toEqual([
      `${VAULT_ID}::notes/a.md`,
      `${VAULT_ID}::notes/b.md`,
    ]);
    expect(editor.openDocs().map((d) => d.path).sort()).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('restores a pinned tab as pinned and writes the pin back into the snapshot', async () => {
    writeSession(
      [
        { vaultId: VAULT_ID, path: 'notes/a.md', kind: 'text', onDisk: true, pinned: true },
        { vaultId: VAULT_ID, path: 'notes/b.md', kind: 'text', onDisk: true },
      ],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: {
          p1: {
            id: 'p1',
            tabs: [`${VAULT_ID}::notes/a.md`, `${VAULT_ID}::notes/b.md`],
            active: `${VAULT_ID}::notes/b.md`,
          },
        },
        focusedId: 'p1',
      },
    );

    expect(await session.restore()).toBe(true);
    expect(editor.docFor(`${VAULT_ID}::notes/a.md`)?.pinned).toBe(true);
    expect(editor.docFor(`${VAULT_ID}::notes/b.md`)?.pinned).toBeUndefined();

    await session.flushNow();
    const stored = JSON.parse(localStorage.getItem('drey.session') ?? '{}') as SessionSnapshot;
    expect(stored.tabs.map((t) => ('pinned' in t ? t.pinned : undefined))).toEqual([true, undefined]);
  });

  it('restores a v1 snapshot by mapping every tab to the active vault', async () => {
    writeSession(
      [
        { path: 'notes/a.md', kind: 'text', onDisk: true },
        { path: 'untitled.md', kind: 'text', onDisk: false, backupId: 'b-scratch' },
      ],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { id: 'p1', tabs: ['notes/a.md', 'untitled.md'], active: 'notes/a.md' } },
        focusedId: 'p1',
      },
      1,
    );

    expect(await session.restore()).toBe(true);
    const diskDoc = editor.docFor(`${VAULT_ID}::notes/a.md`)!;
    expect(diskDoc.vaultId).toBe(VAULT_ID);
    expect(panes.pane('p1')?.tabs).toEqual([`${VAULT_ID}::notes/a.md`, 'untitled.md']);
  });

  it('hands pre-registry snapshots (payload at the top level) to the kind as-is', async () => {
    writeSession(
      [{ vaultId: null, path: 'browser://1', kind: 'browser', url: 'https://legacy.example' } as unknown as SessionSnapshot['tabs'][number]],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { id: 'p1', tabs: ['browser://1'], active: 'browser://1' } },
        focusedId: 'p1',
      },
    );

    expect(await session.restore()).toBe(true);
    expect(restoredKinds).toEqual([
      { kind: 'browser', path: 'browser://1', data: { vaultId: null, path: 'browser://1', kind: 'browser', url: 'https://legacy.example' } },
    ]);
  });

  it('drops a doc-kind tab whose kind is not registered (plugin disabled since)', async () => {
    writeSession(
      [{ vaultId: null, path: 'gone://1', kind: 'extinct-kind', data: null }],
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

  it('drops a tab whose vault is no longer registered', async () => {
    writeSession(
      [
        { vaultId: 'v-gone', path: 'notes/gone.md', kind: 'text', onDisk: true },
        { vaultId: VAULT_ID, path: 'notes/stays.md', kind: 'text', onDisk: true },
      ],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: {
          p1: {
            id: 'p1',
            tabs: [`v-gone::notes/gone.md`, `${VAULT_ID}::notes/stays.md`],
            active: `${VAULT_ID}::notes/stays.md`,
          },
        },
        focusedId: 'p1',
      },
    );

    expect(await session.restore()).toBe(true);
    expect(editor.openDocs().map((d) => d.path)).toEqual(['notes/stays.md']);
  });

  it('re-applies unsaved edits over a disk file via its backup', async () => {
    writeSession(
      [{ vaultId: VAULT_ID, path: 'notes/x.md', kind: 'text', onDisk: true, backupId: 'b-dirty' }],
      {
        root: { kind: 'leaf', paneId: 'p1' },
        panes: { p1: { id: 'p1', tabs: [`${VAULT_ID}::notes/x.md`], active: `${VAULT_ID}::notes/x.md` } },
        focusedId: 'p1',
      },
    );

    await session.restore();

    const doc = editor.docFor(`${VAULT_ID}::notes/x.md`)!;
    expect(doc.savedContent).toBe('disk of notes/x.md');
    expect(doc.bufferContent).toBe('edited body');
    expect(doc.bufferContent !== doc.savedContent).toBe(true);
  });

  it('skips a scratch tab whose backup is gone', async () => {
    writeSession(
      [{ vaultId: null, path: 'untitled.md', kind: 'text', onDisk: false, backupId: 'missing' }],
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
