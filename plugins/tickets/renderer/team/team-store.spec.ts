import { describe, expect, it, vi } from 'vitest';
import type { DeskDeps } from '../desk-deps';
import { createTeamStore } from './team-store';

function fakeDeps(reply: () => Promise<unknown>) {
  const listeners = new Set<() => void>();
  const invoke = vi.fn(async (method: string) => (method === 'personas' ? reply() : null));
  const deps = {
    invoke,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as DeskDeps;
  return { deps, invoke, fire: () => listeners.forEach((listener) => listener()), listeners };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the team store', () => {
  it('pulls the directory when the first listener arrives and names a persona', async () => {
    const { deps, invoke } = fakeDeps(async () => [{ id: 'ben', title: 'Ben' }]);
    const store = createTeamStore(deps);
    expect(store.loaded()).toBe(false);
    const seen = vi.fn();
    store.subscribe(seen);
    await flush();
    expect(invoke).toHaveBeenCalledWith('personas');
    expect(store.loaded()).toBe(true);
    expect(store.nameOf('ben')).toBe('Ben');
    expect(store.nameOf('ralf')).toBe('ralf');
    expect(store.nameOf(null)).toBe('');
    expect(seen).toHaveBeenCalled();
  });

  it('pulls on board or fleet changes only after the gap', async () => {
    let t = 1_000_000;
    const { deps, invoke, fire } = fakeDeps(async () => []);
    const store = createTeamStore(deps, () => t);
    store.subscribe(() => undefined);
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    t += 1_000;
    fire();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    t += 5_000;
    fire();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('keeps the last directory and reports a failure', async () => {
    let fail = false;
    const { deps } = fakeDeps(async () => {
      if (fail) {
        throw new Error('engine down');
      }
      return [{ id: 'ben', title: 'Ben' }];
    });
    const store = createTeamStore(deps);
    store.subscribe(() => undefined);
    await flush();
    fail = true;
    await store.refresh();
    expect(store.error()).toBe('engine down');
    expect(store.nameOf('ben')).toBe('Ben');
    fail = false;
    await store.refresh();
    expect(store.error()).toBe('');
  });

  it('stops listening to the fleet when the last listener leaves', async () => {
    const { deps, listeners } = fakeDeps(async () => []);
    const store = createTeamStore(deps);
    const off = store.subscribe(() => undefined);
    await flush();
    expect(listeners.size).toBe(1);
    off();
    expect(listeners.size).toBe(0);
  });
});
