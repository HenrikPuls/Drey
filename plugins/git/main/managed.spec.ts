import { describe, expect, it, vi } from 'vitest';
import type { MainPluginContext } from '../../../shared/plugin-api';
import plugin from './index';

/**
 * The plugin-managed read-only guard (SDK 1.32, ADR-0080): a vault flagged
 * by another plugin (the tickets vault — one transition is one structured
 * commit) refuses stage / discard / commit (+amend) / pull / push with
 * "Managed by <name>", BEFORE any repository is located or git runs. The
 * read surface (status, branches, log, file history) is untouched.
 */

const MANAGED = 'tickets-vault';
const FREE = 'notes-vault';

type Handler = (payload: unknown) => unknown;

async function harness(managedIds: readonly string[]): Promise<{
  invoke(method: string, payload?: unknown): Promise<unknown>;
}> {
  const handlers = new Map<string, Handler>();
  const ctx = {
    pluginId: 'git',
    manifest: { id: 'git', name: 'Git', apiVersion: '1.32' },
    config: { get: async () => undefined, set: async () => undefined },
    app: {
      onMainWindowCreated: () => () => undefined,
      getMainWindow: () => null,
      onWillQuit: () => () => undefined,
      appVersion: '0.0.0-test',
      userRoot: 'C:/tmp',
    },
    ipc: {
      handle: (method: string, fn: Handler) => handlers.set(method, fn),
      emit: () => undefined,
    },
    vault: {
      // `exists: false` everywhere: locate() then answers "none" without
      // spawning git — the specs never need a real repository.
      listVaults: async () => [
        { id: MANAGED, name: 'Tickets', path: 'C:/tickets', exists: false, active: true },
        { id: FREE, name: 'Notes', path: 'C:/notes', exists: false, active: false },
      ],
      onChanged: () => () => undefined,
      managedBy: vi.fn((vaultId: string) =>
        managedIds.includes(vaultId) ? 'Tickets' : null,
      ),
    },
    save: { onNoteSaved: () => () => undefined },
    log: () => undefined,
  } as unknown as MainPluginContext;
  await plugin.activate(ctx);
  return {
    invoke: (method: string, payload?: unknown) => {
      const handler = handlers.get(method);
      if (handler === undefined) {
        throw new Error(`no handler registered for "${method}"`);
      }
      return Promise.resolve(handler(payload));
    },
  };
}

describe('git plugin: plugin-managed vaults are read-only (SDK 1.32)', () => {
  it('stage refuses with the managing plugin\'s name', async () => {
    const h = await harness([MANAGED]);
    await expect(h.invoke('stage', { vaultId: MANAGED, paths: [] })).rejects.toThrow(
      'Managed by Tickets — staging, committing, discarding, pulling and pushing are disabled',
    );
  });

  it('discard refuses', async () => {
    const h = await harness([MANAGED]);
    await expect(h.invoke('discard', { vaultId: MANAGED, paths: ['tickets/10-plan/T-0001.md'] })).rejects.toThrow(
      'Managed by Tickets',
    );
  });

  it('commit refuses — amend and commit-and-push alike', async () => {
    const h = await harness([MANAGED]);
    await expect(h.invoke('commit', { vaultId: MANAGED, message: 'x' })).rejects.toThrow('Managed by Tickets');
    await expect(h.invoke('commit', { vaultId: MANAGED, message: '', amend: true })).rejects.toThrow(
      'Managed by Tickets',
    );
    await expect(h.invoke('commit', { vaultId: MANAGED, message: 'x', push: true })).rejects.toThrow(
      'Managed by Tickets',
    );
  });

  it('pull and push refuse', async () => {
    const h = await harness([MANAGED]);
    await expect(h.invoke('pull', { vaultId: MANAGED })).rejects.toThrow('Managed by Tickets');
    await expect(h.invoke('push', { vaultId: MANAGED })).rejects.toThrow('Managed by Tickets');
  });

  it('the refusal needs no repository: it precedes the repo lookup', async () => {
    const h = await harness([MANAGED]);
    // The managed vault is `exists: false` — without the guard-first order
    // these would reject with "not a Git repository" instead.
    await expect(h.invoke('push', { vaultId: MANAGED })).rejects.toThrow('Managed by Tickets');
  });

  it('an ordinary vault runs the ordinary path (no managed error)', async () => {
    const h = await harness([MANAGED]);
    await expect(h.invoke('stage', { vaultId: FREE, paths: [] })).rejects.toThrow('not a Git repository');
  });

  it('queries are untouched: status of the managed vault answers without the managed error', async () => {
    const h = await harness([MANAGED]);
    // `status` answers with the full state list — read surface, no refusal.
    await expect(h.invoke('status', { vaultId: MANAGED })).resolves.toEqual([
      { vaultId: MANAGED, state: 'not-a-repo' },
      { vaultId: FREE, state: 'not-a-repo' },
    ]);
    await expect(h.invoke('branches', { vaultId: MANAGED })).rejects.toThrow('not a Git repository');
  });

  it('unstage stays allowed for a managed vault (passes the guard to the ordinary path)', async () => {
    const h = await harness([MANAGED]);
    await expect(h.invoke('unstage', { vaultId: MANAGED, paths: [] })).rejects.not.toThrow('Managed by Tickets');
  });
});
