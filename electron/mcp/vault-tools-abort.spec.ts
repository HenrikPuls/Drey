import { describe, expect, it } from 'vitest';
import { VaultTools } from './vault-tools';
import type { VaultToolDeps } from './vault-tools';

/**
 * The abort semantics of the vault tool set (ADR-0071 later change): a
 * call whose ask was cancelled refuses to run, the user-dialog waits
 * race against the signal (an abort wins over the dialog's answer and
 * nothing is written), and anything that is NOT an abort still comes
 * back as `Error:` text the model can act on.
 */

/**
 * An in-memory single vault. `onConfirmOpen` / `onApproveOpen` fire when
 * the diff confirm / the approval dialog opens; the test decides how the
 * wait settles (never, by answer, by cancel).
 */
function harness(
  over: {
    onConfirmOpen?: () => void;
    onApproveOpen?: () => void;
    confirmWrite?: VaultToolDeps['confirmWrite'];
  } = {},
) {
  const store: Record<string, string> = { 'a.md': 'first\n' };
  const writes: Array<{ path: string; content: string }> = [];
  const deletions: string[] = [];

  const deps: VaultToolDeps = {
    vault: {
      listVaults: () =>
        [{ id: 'vtest', name: 'Test Vault', path: '/vaults/vtest', exists: true, active: true }] as never,
      getActiveVaultId: () => 'vtest',
      listFiles: async () => [],
      listMarkdownFiles: async () => Object.keys(store),
      readFile: async (path: string) => {
        if (!(path in store)) {
          throw new Error(`not found: ${path}`);
        }
        return { content: store[path]!, modifiedMs: 1 };
      },
      writeFile: async (path: string, content: string) => {
        store[path] = content;
        writes.push({ path, content });
        return 2;
      },
      deleteEntry: async (path: string) => {
        delete store[path];
        deletions.push(path);
        return { trashed: true };
      },
    },
    getSearchProvider: () => null,
    getTaskProvider: () => null,
    getConfig: () =>
      ({ mcp: { enabled: true, httpEnabled: false, httpPort: 4319, yolo: false } }) as never,
    confirmWrite:
      over.confirmWrite ??
      (() =>
        new Promise<boolean>(() => {
          over.onConfirmOpen?.();
        })),
    approve: () =>
      new Promise<boolean>(() => {
        over.onApproveOpen?.();
      }),
    rename: (async () => {
      throw new Error('unexpected rename');
    }) as never,
    announce: () => undefined,
    announceRefresh: () => undefined,
  };
  return { tools: new VaultTools(deps), writes, deletions };
}

describe('VaultTools — the abort signal', () => {
  it('refuses to run at all when the call arrives already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { tools } = harness();

    await expect(
      tools.call('vault_read', { path: 'a.md' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'Generation cancelled.' });
  });

  it('lets an abort from inside the tool through instead of flattening it', async () => {
    const controller = new AbortController();
    const { tools } = harness({
      confirmWrite: () => {
        controller.abort();
        return Promise.reject(Object.assign(new Error('Generation cancelled.'), { name: 'AbortError' }));
      },
    });

    await expect(
      tools.call(
        'vault_edit',
        { path: 'a.md', edits: [{ old_text: 'first', new_text: 'second' }] },
        { write: 'confirm', signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('races the confirm dialog: a cancel during the wait writes nothing', async () => {
    const controller = new AbortController();
    const { tools, writes } = harness({
      onConfirmOpen: () => controller.abort(),
    });
    const pending = tools.call(
      'vault_write',
      { path: 'b.md', content: 'new', mode: 'create' },
      { write: 'confirm', signal: controller.signal },
    );

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(writes).toEqual([]);
  });

  it('races the delete approval the same way', async () => {
    const controller = new AbortController();
    const { tools, deletions } = harness({
      onApproveOpen: () => controller.abort(),
    });
    const pending = tools.call('vault_delete', { path: 'a.md' }, { signal: controller.signal });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(deletions).toEqual([]);
  });

  it('still turns a non-abort throw into Error: text the model can act on', async () => {
    const controller = new AbortController();
    const { tools } = harness({
      confirmWrite: async () => {
        throw new Error('dialog exploded');
      },
    });

    const result = await tools.call(
      'vault_edit',
      { path: 'a.md', edits: [{ old_text: 'first', new_text: 'second' }] },
      { write: 'confirm', signal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Error: vault_edit failed — dialog exploded/);
  });
});
