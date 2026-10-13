import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSavedEvent, SaveHookResult } from '../shared/plugin-api';
import { createTempVaults, type TempVaults } from './testing/temp-vaults';

const env = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

import { NoteManager, type NoteSaveHooks } from './note-manager';
import { VaultManager } from './vault-manager';

let vaults: TempVaults;
let vault: VaultManager;

/** Save hooks that answer with `results` and remember what they were told. */
function hooks(results: SaveHookResult[] = []): NoteSaveHooks & { events: NoteSavedEvent[] } {
  const events: NoteSavedEvent[] = [];
  return {
    events,
    onNoteSaved: () => () => undefined,
    emitNoteSaved: async (event) => {
      events.push(event);
      return results;
    },
  };
}

/** Sets a file's mtime to a fixed point, so "changed since" is unambiguous. */
function stamp(root: string, rel: string, seconds: number): number {
  const file = path.join(root, rel);
  fs.utimesSync(file, seconds, seconds);
  return fs.statSync(file).mtimeMs;
}

beforeEach(() => {
  vaults = createTempVaults();
  env.userData = vaults.userData;
  vault = new VaultManager();
});

afterEach(() => {
  vaults.dispose();
});

describe('NoteManager.saveNote', () => {
  it('writes a note without frontmatter exactly as typed', async () => {
    const manager = new NoteManager(vault, hooks());
    const body = '# Title\n\nText with #tag\n';

    const result = await manager.saveNote({ path: 'notes/a.md', body, eol: '\n' });

    expect(vaults.read(vaults.a, 'notes/a.md')).toBe(body);
    expect(result).toEqual({
      path: 'notes/a.md',
      content: body,
      modifiedMs: fs.statSync(path.join(vaults.a, 'notes/a.md')).mtimeMs,
    });
  });

  it('never adds frontmatter keys, and bumps `updated:` only where it exists', async () => {
    const manager = new NoteManager(vault, hooks());
    const foreign = '---\ntitle: mkdocs page\n---\nBody\n';
    const own = '---\ntitle: Mine\nupdated: "2020-01-01T00:00:00"\n---\nBody\n';

    await manager.saveNote({ path: 'foreign.md', body: foreign, eol: '\n' });
    const result = await manager.saveNote({ path: 'own.md', body: own, eol: '\n' });

    expect(vaults.read(vaults.a, 'foreign.md')).toBe(foreign);
    expect(result.content).toMatch(/^---\ntitle: Mine\nupdated: "20\d\d-[^"]+"\n---\nBody\n$/);
    expect(result.content).not.toContain('2020-01-01');
    // The renderer adopts the returned text, so it must be what is on disk.
    expect(vaults.read(vaults.a, 'own.md')).toBe(result.content);
  });

  it('restores CRLF on disk and keeps LF towards the editor', async () => {
    const manager = new NoteManager(vault, hooks());

    const result = await manager.saveNote({ path: 'win.md', body: 'one\ntwo\n', eol: '\r\n' });

    expect(vaults.read(vaults.a, 'win.md')).toBe('one\r\ntwo\r\n');
    expect(result.content).toBe('one\ntwo\n');
  });

  it('saves into the vault the request names', async () => {
    const saveHooks = hooks();
    await new NoteManager(vault, saveHooks).saveNote({ path: 'x.md', body: 'b', eol: '\n', vaultId: 'vb' });

    expect(vaults.exists(vaults.b, 'x.md')).toBe(true);
    expect(vaults.exists(vaults.a, 'x.md')).toBe(false);
    expect(saveHooks.events[0].vaultId).toBe('vb');
  });
});

describe('NoteManager conflict guard', () => {
  it('writes nothing when the file changed since the tab read it', async () => {
    const saveHooks = hooks();
    const manager = new NoteManager(vault, saveHooks);
    vaults.put(vaults.a, 'note.md', 'theirs\r\nline\r\n');
    const diskMs = stamp(vaults.a, 'note.md', 1_800_000_000);
    const seenMs = diskMs - 60_000;

    const result = await manager.saveNote({ path: 'note.md', body: 'mine\n', eol: '\n', baseModifiedMs: seenMs });

    expect(result).toEqual({
      path: 'note.md',
      content: 'mine\n',
      modifiedMs: seenMs,
      conflict: { content: 'theirs\nline\n', modifiedMs: diskMs },
    });
    expect(vaults.read(vaults.a, 'note.md')).toBe('theirs\r\nline\r\n');
    expect(saveHooks.events).toEqual([]);
  });

  it('writes when the tab saw the current file', async () => {
    const manager = new NoteManager(vault, hooks());
    vaults.put(vaults.a, 'note.md', 'old\n');
    const diskMs = stamp(vaults.a, 'note.md', 1_800_000_000);

    const result = await manager.saveNote({ path: 'note.md', body: 'new\n', eol: '\n', baseModifiedMs: diskMs + 1 });

    expect(result.conflict).toBeUndefined();
    expect(vaults.read(vaults.a, 'note.md')).toBe('new\n');
  });

  it('overwrites once the user resolved the conflict', async () => {
    const manager = new NoteManager(vault, hooks());
    vaults.put(vaults.a, 'note.md', 'theirs\n');
    const diskMs = stamp(vaults.a, 'note.md', 1_800_000_000);

    const result = await manager.saveNote({
      path: 'note.md',
      body: 'merged\n',
      eol: '\n',
      baseModifiedMs: diskMs - 60_000,
      force: true,
    });

    expect(result.conflict).toBeUndefined();
    expect(vaults.read(vaults.a, 'note.md')).toBe('merged\n');
  });

  it('reports a file that appeared where the tab expected none', async () => {
    const manager = new NoteManager(vault, hooks());
    vaults.put(vaults.a, 'draft.md', 'somebody else\n');

    const result = await manager.saveNote({ path: 'draft.md', body: 'mine\n', eol: '\n', baseModifiedMs: 0 });

    expect(result.conflict?.content).toBe('somebody else\n');
    expect(vaults.read(vaults.a, 'draft.md')).toBe('somebody else\n');
  });

  it('writes when the file is gone from disk', async () => {
    const manager = new NoteManager(vault, hooks());

    const result = await manager.saveNote({ path: 'deleted.md', body: 'mine\n', eol: '\n', baseModifiedMs: 12345 });

    expect(result.conflict).toBeUndefined();
    expect(vaults.read(vaults.a, 'deleted.md')).toBe('mine\n');
  });
});

describe('NoteManager save hooks', () => {
  it('tells the hooks what was written', async () => {
    const saveHooks = hooks();
    const result = await new NoteManager(vault, saveHooks).saveNote({ path: 'a.md', body: 'text\n', eol: '\r\n' });

    expect(saveHooks.events).toEqual([
      { vaultId: 'va', path: 'a.md', content: 'text\n', modifiedMs: result.modifiedMs, eol: '\r\n', applyingAction: false },
    ]);
  });

  it('adopts a rewrite and collects the confirmations of every hook', async () => {
    const first = { id: 'one' } as unknown as NonNullable<SaveHookResult['pendingActions']>[number];
    const second = { id: 'two' } as unknown as NonNullable<SaveHookResult['pendingActions']>[number];
    const manager = new NoteManager(
      vault,
      hooks([
        { pendingActions: [first] },
        { content: 'rewritten by a hook\n', modifiedMs: 42 },
        { pendingActions: [] },
        { pendingActions: [second] },
      ]),
    );

    const result = await manager.saveNote({ path: 'a.md', body: 'typed\n', eol: '\n' });

    expect(result).toEqual({
      path: 'a.md',
      content: 'rewritten by a hook\n',
      modifiedMs: 42,
      pendingActions: [first, second],
    });
  });

  it('skips the hooks when the save applies a confirmed rewrite', async () => {
    const saveHooks = hooks([{ content: 'never used' }]);

    const result = await new NoteManager(vault, saveHooks).saveNote({
      path: 'a.md',
      body: 'applied\n',
      eol: '\n',
      runOnSaveActions: false,
    });

    expect(saveHooks.events).toEqual([]);
    expect(result.content).toBe('applied\n');
    expect(result).not.toHaveProperty('pendingActions');
  });

  it('marks only the user\'s own saves as throttled for the history', async () => {
    const writeFile = vi.spyOn(vault, 'writeFile');
    const manager = new NoteManager(vault, hooks());

    await manager.saveNote({ path: 'a.md', body: '1\n', eol: '\n' });
    await manager.saveNote({ path: 'a.md', body: '2\n', eol: '\n', origin: 'restore' });

    expect(writeFile.mock.calls.map((call) => call[3])).toEqual([
      { origin: 'save', throttled: true },
      { origin: 'restore', throttled: false },
    ]);
  });
});

/**
 * `NoteManager.saveNote`'s conflict guard and history origin (ADR-0060),
 * against a one-file fake vault.
 */
describe('NoteManager save conflicts', () => {
  let file: { content: string; modifiedMs: number } | null;
  let writes: Array<{ content: string; opts: unknown }>;
  let manager: NoteManager;

  beforeEach(() => {
    file = { content: 'on disk\r\nline two\r\n', modifiedMs: 500 };
    writes = [];
    const vault = {
      resolveVaultId: (id?: string) => id ?? 'v1',
      readFile: () => (file === null ? Promise.reject(new Error('ENOENT')) : Promise.resolve({ ...file })),
      writeFile: (_path: string, content: string, _vaultId: string, opts: unknown) => {
        writes.push({ content, opts });
        file = { content, modifiedMs: (file?.modifiedMs ?? 0) + 10 };
        return Promise.resolve(file.modifiedMs);
      },
    } as unknown as VaultManager;
    manager = new NoteManager(vault, {
      onNoteSaved: () => () => undefined,
      emitNoteSaved: () => Promise.resolve([]),
    });
  });

  const request = { path: 'a.md', body: 'mine\n', eol: '\n' as const };

  it('writes when the base matches, within the timestamp tolerance', async () => {
    const result = await manager.saveNote({ ...request, baseModifiedMs: 501 });
    expect(result.conflict).toBeUndefined();
    expect(result.modifiedMs).toBe(510);
    expect(writes).toEqual([{ content: 'mine\n', opts: { origin: 'save', throttled: true } }]);
  });

  it('refuses a stale base and hands back the disk text in LF form', async () => {
    const result = await manager.saveNote({ ...request, baseModifiedMs: 100 });
    expect(result.conflict).toEqual({ content: 'on disk\nline two\n', modifiedMs: 500 });
    expect(writes).toEqual([]);
  });

  it('a draft (base 0) conflicts with a file that appeared, not with a missing one', async () => {
    expect((await manager.saveNote({ ...request, baseModifiedMs: 0 })).conflict).toBeDefined();
    file = null;
    expect((await manager.saveNote({ ...request, baseModifiedMs: 0 })).conflict).toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it('force and a missing base skip the check; a named origin is not throttled', async () => {
    await manager.saveNote({ ...request, baseModifiedMs: 100, force: true, origin: 'conflict' });
    await manager.saveNote(request);
    expect(writes.map((w) => w.opts)).toEqual([
      { origin: 'conflict', throttled: false },
      { origin: 'save', throttled: true },
    ]);
  });

  it('writes a frontmatter without `updated:` verbatim and bumps an existing one', async () => {
    const foreign = '---\ntitle: Architecture\n---\n# Page\n';
    await manager.saveNote({ ...request, body: foreign });
    expect(writes[0].content).toBe(foreign);

    await manager.saveNote({ ...request, body: '---\nupdated: "2020-01-01T00:00:00"\n---\nbody\n' });
    expect(writes[1].content).toMatch(/^---\nupdated: "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d"\n---\nbody\n$/);
    expect(writes[1].content).not.toContain('2020-01-01');
    expect(writes[1].content).not.toContain('created');
  });
});
