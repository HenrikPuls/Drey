import { NoteManager } from '../../../electron/note-manager';
import type { VaultManager } from '../../../electron/vault-manager';

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
});
