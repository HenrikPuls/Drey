import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteHistoryStore } from './history/note-history-store';

/** Stand-ins for the Electron APIs the manager touches; reset per test. */
const electronMock = vi.hoisted(() => ({
  userData: '',
  showOpenDialog: vi.fn(),
  trashItem: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => electronMock.userData },
  dialog: { showOpenDialog: electronMock.showOpenDialog },
  shell: { trashItem: electronMock.trashItem, showItemInFolder: vi.fn(), openPath: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { OwnWriteLedger } from './own-write-ledger';
import { VaultManager } from './vault-manager';

let tmp = '';

const registryFile = (): string => path.join(electronMock.userData, 'vault-config.json');
const readRegistry = (): { vaults: Array<{ id: string; name: string; path: string }>; activeVaultId: string | null } =>
  JSON.parse(fs.readFileSync(registryFile(), 'utf8'));

function vaultDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRegistry(vaults: Array<{ id: string; name: string; path: string }>, activeVaultId: string | null): void {
  fs.writeFileSync(registryFile(), JSON.stringify({ version: 2, vaults, activeVaultId }));
}

/** A manager over two registered vault folders, `a` (active) and `b`. */
function twoVaults(
  ledger?: OwnWriteLedger,
  history?: NoteHistoryStore,
): { manager: VaultManager; a: string; b: string } {
  const a = vaultDir('vault-a');
  const b = vaultDir('vault-b');
  writeRegistry(
    [
      { id: 'va', name: 'A', path: a },
      { id: 'vb', name: 'B', path: b },
    ],
    'va',
  );
  return { manager: new VaultManager(ledger, history), a, b };
}

function put(root: string, rel: string, content = ''): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const exists = (root: string, rel: string): boolean => fs.existsSync(path.join(root, rel));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-vault-'));
  electronMock.userData = path.join(tmp, 'user-data');
  fs.mkdirSync(electronMock.userData);
  electronMock.showOpenDialog.mockReset();
  electronMock.trashItem.mockReset();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('VaultManager registry', () => {
  it('starts empty without a config file and writes nothing', () => {
    const manager = new VaultManager();
    expect(manager.listVaults()).toEqual([]);
    expect(manager.getActiveVaultId()).toBeNull();
    expect(manager.loadProblem).toBeNull();
    expect(fs.existsSync(registryFile())).toBe(false);
  });

  it('reads the registered vaults and drops entries it cannot use', () => {
    const a = vaultDir('a');
    fs.writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 2,
        vaults: [{ id: 'va', name: 'A', path: a }, { id: 'broken' }, null],
        activeVaultId: 'va',
      }),
    );

    const manager = new VaultManager();

    expect(manager.listVaults()).toEqual([{ id: 'va', name: 'A', path: a, exists: true, active: true }]);
    expect(manager.getActiveVaultPath()).toBe(a);
  });

  it('ignores an active id that names no registered vault', () => {
    writeRegistry([{ id: 'va', name: 'A', path: vaultDir('a') }], 'gone');
    expect(new VaultManager().getActiveVaultId()).toBeNull();
  });

  it('migrates a v1 file once: the minted id stays the same on the next start', () => {
    const a = vaultDir('notes');
    fs.writeFileSync(registryFile(), JSON.stringify({ activeVaultPath: a }));

    const first = new VaultManager();
    const id = first.getActiveVaultId();

    expect(first.listVaults()).toEqual([{ id, name: 'notes', path: a, exists: true, active: true }]);
    expect(readRegistry()).toEqual({ version: 2, vaults: [{ id, name: 'notes', path: a }], activeVaultId: id });
    expect(new VaultManager().getActiveVaultId()).toBe(id);
  });

  it('keeps a vault whose folder is missing, without making it the target', () => {
    const missing = path.join(tmp, 'unplugged');
    writeRegistry([{ id: 'va', name: 'A', path: missing }], 'va');
    const before = fs.readFileSync(registryFile(), 'utf8');

    const manager = new VaultManager();

    expect(manager.listVaults()).toEqual([{ id: 'va', name: 'A', path: missing, exists: false, active: false }]);
    expect(manager.getActiveVaultPath()).toBeNull();
    // Untouched, so the vault is active again once the drive is back.
    expect(fs.readFileSync(registryFile(), 'utf8')).toBe(before);
  });

  it('reports a config file it cannot read and sets it aside', () => {
    fs.writeFileSync(registryFile(), '{ not json');

    const manager = new VaultManager();

    expect(manager.listVaults()).toEqual([]);
    expect(manager.loadProblem).not.toBeNull();
    expect(fs.readdirSync(electronMock.userData).some((name) => name.startsWith('vault-config.json.'))).toBe(true);
  });

  it('adds a picked folder, makes the first one active and refuses it twice', async () => {
    const a = vaultDir('Work');
    const b = vaultDir('Private');
    const manager = new VaultManager();

    electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(manager.addVault()).resolves.toBeNull();

    electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [a] });
    const first = await manager.addVault();
    electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [b] });
    const second = await manager.addVault();

    expect(first?.name).toBe('Work');
    expect(manager.getActiveVaultId()).toBe(first?.id);
    expect(second?.id).not.toBe(first?.id);
    expect(readRegistry().vaults.map((v) => v.name)).toEqual(['Work', 'Private']);

    electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [a.toUpperCase()] });
    await expect(manager.addVault()).rejects.toThrow('already registered as vault "Work"');
  });

  it('renames, activates and removes vaults, never touching the folders', () => {
    const { manager, a, b } = twoVaults();

    expect(manager.renameVault('vb', '  Archive ').name).toBe('Archive');
    expect(() => manager.renameVault('vb', '   ')).toThrow('cannot be empty');
    expect(() => manager.setActiveVault('nope')).toThrow('Unknown vault');

    manager.setActiveVault('vb');
    expect(manager.getActiveVaultPath()).toBe(b);

    // Removing the active vault promotes the first one left.
    manager.removeVault('vb');
    expect(manager.getActiveVaultId()).toBe('va');
    manager.removeVault('va');
    expect(manager.getActiveVaultId()).toBeNull();
    expect(readRegistry()).toEqual({ version: 2, vaults: [], activeVaultId: null });
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    expect(() => manager.resolveVaultId()).toThrow('No vault is active');
  });
});

describe('VaultManager path guard', () => {
  it('refuses every path that leaves the vault', async () => {
    const { manager, a } = twoVaults();
    // A sibling folder whose name merely starts like the vault's.
    put(tmp, 'vault-a-private/secret.md', 'secret');
    put(tmp, 'outside.md', 'outside');

    for (const escape of ['../outside.md', '../vault-a-private/secret.md', 'sub/../../outside.md', path.join(tmp, 'outside.md')]) {
      await expect(manager.readFile(escape)).rejects.toThrow('outside the vault');
      await expect(manager.writeFile(escape, 'x')).rejects.toThrow('outside the vault');
      await expect(manager.deleteEntry(escape, undefined, { trash: false })).rejects.toThrow('outside the vault');
      expect(manager.resolveAssetPath(escape)).toBeNull();
    }
    await expect(manager.renameEntry('note.md', '../moved.md')).rejects.toThrow('outside the vault');
    expect(fs.readFileSync(path.join(tmp, 'outside.md'), 'utf8')).toBe('outside');
    expect(manager.resolveAssetPath('img/a.png')).toBe(path.join(a, 'img', 'a.png'));
    expect(manager.resolveAssetPath('img/a.png', 'unknown')).toBeNull();
  });
});

describe('VaultManager reading and writing', () => {
  it('writes into the named vault, creating folders, and reads it back', async () => {
    const ledger = new OwnWriteLedger();
    const { manager, a, b } = twoVaults(ledger);

    const mtime = await manager.writeFile('daily/2026/note.md', 'hello', 'vb');

    expect(exists(a, 'daily')).toBe(false);
    expect(await manager.readFile('daily/2026/note.md', 'vb')).toEqual({ content: 'hello', modifiedMs: mtime });
    expect(fs.readdirSync(path.join(b, 'daily/2026'))).toEqual(['note.md']);
    // The watcher must recognise this write as the app's own.
    expect(ledger.isOwnEvent('vb', 'daily/2026/note.md', 'change', mtime)).toBe(true);
    expect(ledger.isOwnEvent('va', 'daily/2026/note.md', 'change', mtime)).toBe(false);
  });

  it('hands the replaced text of a note to the history, and only that', async () => {
    const capture = vi.fn(async () => true);
    const history = { capture, rename: vi.fn(async () => undefined) } as unknown as NoteHistoryStore;
    const { manager, a } = twoVaults(undefined, history);
    put(a, 'note.md', 'old');
    put(a, 'data.json', '{}');

    await manager.writeFile('new.md', 'first version');
    await manager.writeFile('note.md', 'old');
    await manager.writeFile('data.json', '{"a":1}');
    expect(capture).not.toHaveBeenCalled();

    await manager.writeFile('note.md', 'new', undefined, { origin: 'save', throttled: true });
    expect(capture).toHaveBeenCalledExactlyOnceWith('va', 'note.md', 'old', 'save', { throttled: true });
  });

  it('writes and reads bytes unchanged', async () => {
    const { manager } = twoVaults();
    const bytes = Uint8Array.from([0, 255, 10, 13, 128]);
    await manager.writeBinaryFile('diagrams/a.drawio.png', bytes);
    expect([...(await manager.readBinaryFile('diagrams/a.drawio.png'))]).toEqual([...bytes]);
  });

  it('lists folders first, sorted, and hides dot entries', async () => {
    const { manager, a } = twoVaults();
    put(a, 'b.md');
    put(a, 'a.txt');
    put(a, 'zeta/inner.md');
    put(a, '.git/config');
    put(a, '.drafts/draft.md');
    put(a, 'alpha/.hidden.md');

    expect(await manager.listFiles()).toEqual([
      { name: 'alpha', relativePath: 'alpha', type: 'directory', children: [] },
      {
        name: 'zeta',
        relativePath: 'zeta',
        type: 'directory',
        children: [{ name: 'inner.md', relativePath: 'zeta/inner.md', type: 'file' }],
      },
      { name: 'a.txt', relativePath: 'a.txt', type: 'file' },
      { name: 'b.md', relativePath: 'b.md', type: 'file' },
    ]);
    expect(await manager.listMarkdownFiles()).toEqual(['b.md', 'zeta/inner.md']);
  });

  it('hides reserved _ root folders, but tickets/_meta below the root stays listed (T-0044)', async () => {
    const { manager, a } = twoVaults();
    put(a, '_worktrees/T-0044/plugins/tickets/main/index.ts');
    put(a, '_worktrees/T-0044/note.md');
    put(a, '_scratch/hidden.md');
    put(a, 'tickets/_meta/pipeline.md');
    put(a, 'tickets/10-inbox/T-0042.md');

    expect((await manager.listMarkdownFiles()).sort()).toEqual(
      ['tickets/10-inbox/T-0042.md', 'tickets/_meta/pipeline.md'].sort(),
    );
    const tree = await manager.listFiles();
    expect(tree.map((e) => e.name)).toEqual(['tickets']);
    // localeCompare order — '_' sorts before the digits.
    expect(tree[0]!.children.map((e) => e.name)).toEqual(['_meta', '10-inbox']);
  });

  it('lists the notes of every vault whose folder is there', async () => {
    const { manager, a, b } = twoVaults();
    put(a, 'one.md');
    put(b, 'two.MD');
    fs.rmSync(a, { recursive: true });

    expect(await manager.listAllMarkdownFiles()).toEqual([{ vaultId: 'vb', path: 'two.MD' }]);
    await expect(manager.listFiles('va')).rejects.toThrow('no longer exists');
  });

  it('stores a pasted image beside the note without overwriting an earlier one', async () => {
    const { manager, a } = twoVaults();
    const bytes = Uint8Array.from([1, 2, 3]);

    const first = await manager.saveAsset(bytes, 'pdf', 'projects/plan.md', undefined, 'Report 2026.pdf');
    const second = await manager.saveAsset(bytes, 'pdf', 'projects/plan.md', undefined, 'Report 2026.pdf');
    const atRoot = await manager.saveAsset(bytes, 'png', 'scratch.md');

    expect(first).toMatch(/^attachments\/.+\.pdf$/);
    expect(second).not.toBe(first);
    expect(second).toMatch(/-2\.pdf$/);
    expect(exists(a, `projects/${first}`) && exists(a, `projects/${second}`)).toBe(true);
    expect(exists(a, atRoot)).toBe(true);
  });
});

describe('VaultManager creating and deleting', () => {
  it('creates files and folders but never over something that is there', async () => {
    const { manager, a } = twoVaults();

    await expect(manager.createFile('new/note.md')).resolves.toBe('new/note.md');
    await expect(manager.createDirectory('new/sub')).resolves.toBe('new/sub');
    expect(fs.readFileSync(path.join(a, 'new/note.md'), 'utf8')).toBe('');

    await expect(manager.createFile('new/note.md')).rejects.toThrow('Already exists');
    await expect(manager.createDirectory('new')).rejects.toThrow('Already exists');
  });

  it('removes a folder only when it is empty, and never the vault root', async () => {
    const { manager, a } = twoVaults();
    put(a, 'full/x.md');
    fs.mkdirSync(path.join(a, 'empty'));

    await manager.removeDirIfEmpty('full');
    await manager.removeDirIfEmpty('empty');
    await manager.removeDirIfEmpty('missing');
    await manager.removeDirIfEmpty('');

    expect(exists(a, 'full/x.md')).toBe(true);
    expect(exists(a, 'empty')).toBe(false);
    expect(fs.existsSync(a)).toBe(true);
  });

  it('moves a deleted note and its chat sidecar to the recycle bin', async () => {
    const { manager, a } = twoVaults();
    put(a, 'daily/note.md');
    put(a, 'daily/.note.chat.json');
    electronMock.trashItem.mockResolvedValue(undefined);

    await expect(manager.deleteEntry('daily/note.md')).resolves.toEqual({ trashed: true });

    expect(electronMock.trashItem.mock.calls.map(([p]) => p)).toEqual([
      path.join(a, 'daily', 'note.md'),
      path.join(a, 'daily', '.note.chat.json'),
    ]);
  });

  it('deletes permanently when asked to, or when the volume has no recycle bin', async () => {
    const { manager, a } = twoVaults();
    put(a, 'one.md');
    put(a, '.one.chat.json');
    put(a, 'folder/two.md');

    await expect(manager.deleteEntry('one.md', undefined, { trash: false })).resolves.toEqual({ trashed: false });
    expect(electronMock.trashItem).not.toHaveBeenCalled();
    expect(exists(a, 'one.md') || exists(a, '.one.chat.json')).toBe(false);

    electronMock.trashItem.mockRejectedValue(new Error('no recycle bin'));
    await expect(manager.deleteEntry('folder')).resolves.toEqual({ trashed: false });
    expect(exists(a, 'folder')).toBe(false);

    // The tree the user clicked in may be a step behind.
    await expect(manager.deleteEntry('gone.md', undefined, { trash: false })).resolves.toEqual({ trashed: false });
  });

  it('refuses to delete or rename the vault root', async () => {
    const { manager, a } = twoVaults();
    await expect(manager.deleteEntry('', undefined, { trash: false })).rejects.toThrow('vault root');
    await expect(manager.deleteEntry('.', undefined, { trash: false })).rejects.toThrow('vault root');
    await expect(manager.renameEntry('', 'elsewhere')).rejects.toThrow('vault root');
    expect(fs.existsSync(a)).toBe(true);
  });
});

describe('VaultManager renaming and moving', () => {
  it('renames a note within its vault, taking the sidecar and the history along', async () => {
    const rename = vi.fn(async () => undefined);
    const history = { capture: vi.fn(async () => true), rename } as unknown as NoteHistoryStore;
    const ledger = new OwnWriteLedger();
    const { manager, a } = twoVaults(ledger, history);
    put(a, 'inbox/idea.md', 'text');
    put(a, 'inbox/.idea.chat.json', '{}');

    await expect(manager.renameEntry('inbox/idea.md', 'projects/plan.md')).resolves.toBe('projects/plan.md');

    expect(fs.readFileSync(path.join(a, 'projects/plan.md'), 'utf8')).toBe('text');
    expect(exists(a, 'projects/.plan.chat.json')).toBe(true);
    expect(exists(a, 'inbox/idea.md') || exists(a, 'inbox/.idea.chat.json')).toBe(false);
    expect(rename).toHaveBeenCalledExactlyOnceWith('va', 'inbox/idea.md', 'va', 'projects/plan.md');
    expect(ledger.isOwnEvent('va', 'inbox/idea.md', 'unlink')).toBe(true);
    expect(ledger.isOwnEvent('va', 'projects/plan.md', 'add')).toBe(true);
  });

  it('refuses a missing source, an occupied target and a folder into itself', async () => {
    const { manager, a } = twoVaults();
    put(a, 'a.md', 'a');
    put(a, 'b.md', 'b');
    put(a, 'folder/x.md');

    await expect(manager.renameEntry('missing.md', 'c.md')).rejects.toThrow('Not found');
    await expect(manager.renameEntry('a.md', 'b.md')).rejects.toThrow('Already exists');
    await expect(manager.renameEntry('folder', 'folder/inner')).rejects.toThrow('into itself');
    await expect(manager.renameEntry('a.md', 'a.md')).resolves.toBe('a.md');

    // A sibling whose name only starts the same is an ordinary rename.
    await expect(manager.renameEntry('folder', 'folder2')).resolves.toBe('folder2');
    expect(fs.readFileSync(path.join(a, 'b.md'), 'utf8')).toBe('b');
  });

  it('moves a folder into another vault and leaves nothing behind', async () => {
    const rename = vi.fn(async () => undefined);
    const history = { capture: vi.fn(async () => true), rename } as unknown as NoteHistoryStore;
    const { manager, a, b } = twoVaults(undefined, history);
    put(a, 'project/notes/one.md', '1');
    put(a, 'project/two.md', '2');

    await expect(manager.renameEntry('project', 'archive/project', 'va', 'vb')).resolves.toBe('archive/project');

    expect(exists(a, 'project')).toBe(false);
    expect(fs.readFileSync(path.join(b, 'archive/project/notes/one.md'), 'utf8')).toBe('1');
    expect(fs.readFileSync(path.join(b, 'archive/project/two.md'), 'utf8')).toBe('2');
    expect(rename).toHaveBeenCalledExactlyOnceWith('va', 'project', 'vb', 'archive/project');
  });

  it('moves a note with its sidecar across vaults, and not over an existing note', async () => {
    const { manager, a, b } = twoVaults();
    put(a, 'idea.md', 'mine');
    put(a, '.idea.chat.json', '{}');
    put(b, 'taken.md', 'theirs');

    await expect(manager.renameEntry('idea.md', 'taken.md', 'va', 'vb')).rejects.toThrow('Already exists');
    expect(fs.readFileSync(path.join(a, 'idea.md'), 'utf8')).toBe('mine');

    await manager.renameEntry('idea.md', 'idea.md', 'va', 'vb');
    expect(exists(b, 'idea.md') && exists(b, '.idea.chat.json')).toBe(true);
    expect(exists(a, 'idea.md') || exists(a, '.idea.chat.json')).toBe(false);
    expect(fs.readFileSync(path.join(b, 'taken.md'), 'utf8')).toBe('theirs');
  });
});

describe('VaultManager copying', () => {
  it('keeps the name when it is free and numbers the copy when it is not', async () => {
    const { manager, a, b } = twoVaults();
    put(a, 'note.md', 'text');
    put(a, '.note.chat.json', '{}');
    fs.mkdirSync(path.join(a, 'dest'));

    await expect(manager.copyEntry('note.md', 'dest')).resolves.toBe('dest/note.md');
    expect(exists(a, 'dest/.note.chat.json')).toBe(true);

    await expect(manager.duplicateEntry('note.md')).resolves.toBe('note copy.md');
    await expect(manager.duplicateEntry('note.md')).resolves.toBe('note copy 2.md');
    expect(fs.readFileSync(path.join(a, 'note copy 2.md'), 'utf8')).toBe('text');

    await expect(manager.copyEntry('dest', '', 'va', 'vb')).resolves.toBe('dest');
    expect(exists(b, 'dest/note.md')).toBe(true);
    expect(exists(a, 'dest/note.md')).toBe(true);
  });

  it('refuses a missing source, a target that is no folder and a folder into itself', async () => {
    const { manager, a } = twoVaults();
    put(a, 'folder/x.md');
    put(a, 'file.md');

    await expect(manager.copyEntry('missing.md', '')).rejects.toThrow('Not found');
    await expect(manager.copyEntry('file.md', 'file.md')).rejects.toThrow('Not a folder');
    await expect(manager.copyEntry('folder', 'folder')).rejects.toThrow('into itself');
    fs.mkdirSync(path.join(a, 'folder/sub'));
    await expect(manager.copyEntry('folder', 'folder/sub')).rejects.toThrow('into itself');
  });
});
