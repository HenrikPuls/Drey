import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFrame } from './engine-client';
import { MAX_PATHS, PathAnnouncer } from './path-announcer';

const VAULT = { id: 'drey-1', path: 'E:\\tickets', exists: true };

function make(over: Partial<ConstructorParameters<typeof PathAnnouncer>[0]> = {}) {
  const announce = vi.fn();
  const announcer = new PathAnnouncer({
    listVaults: async () => [{ id: 'other', path: 'E:\\notes', exists: true }, VAULT],
    announce,
    debounceMs: 100,
    maxWaitMs: 500,
    platform: 'win32',
    ...over,
  });
  return { announce, announcer };
}

describe('PathAnnouncer (D-3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces a move as new path changed and old path deleted, in one round', async () => {
    const { announce, announcer } = make();
    announcer.add({
      vaultPath: 'E:\\tickets',
      changed: ['tickets/review/T-1.md'],
      deleted: ['tickets/build/T-1.md'],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith({
      vaultId: 'drey-1',
      changedPaths: ['tickets/review/T-1.md'],
      deletedPaths: ['tickets/build/T-1.md'],
    });
  });

  it('matches the Drey vault by path, case-insensitively on Windows', async () => {
    const { announce, announcer } = make();
    announcer.add({ vaultPath: 'e:\\Tickets', changed: ['a.md'], deleted: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'drey-1' }));
  });

  it('stays silent when the engine vault is not registered in Drey', async () => {
    const { announce, announcer } = make();
    announcer.add({ vaultPath: 'E:\\elsewhere', changed: ['a.md'], deleted: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(announce).not.toHaveBeenCalled();
  });

  it('coalesces a burst into one round and dedupes paths (no refresh storm)', async () => {
    const { announce, announcer } = make();
    for (let i = 0; i < 50; i += 1) {
      announcer.add({ vaultPath: 'E:\\tickets', changed: ['tickets/build/T-1.md', `tickets/log/${i % 5}.md`], deleted: [] });
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(announce).toHaveBeenCalledTimes(2); // the max wait cut the burst once, the tail flushed
    const all = announce.mock.calls.flatMap((c) => c[0].changedPaths as string[]);
    expect(new Set(all).size).toBe(6);
  });

  it('flushes a never-ending stream at the max wait', async () => {
    const { announce, announcer } = make();
    for (let i = 0; i < 40; i += 1) {
      announcer.add({ vaultPath: 'E:\\tickets', changed: [`f${i}.md`], deleted: [] });
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(announce.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('last write wins: changed after deleted counts as changed, and the reverse', async () => {
    const { announce, announcer } = make();
    announcer.add({ vaultPath: 'E:\\tickets', changed: [], deleted: ['a.md'] });
    announcer.add({ vaultPath: 'E:\\tickets', changed: ['a.md'], deleted: ['b.md'] });
    announcer.add({ vaultPath: 'E:\\tickets', changed: [], deleted: ['a.md'] });
    announcer.add({ vaultPath: 'E:\\tickets', changed: ['b.md'], deleted: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(announce).toHaveBeenCalledWith({ vaultId: 'drey-1', changedPaths: ['b.md'], deletedPaths: ['a.md'] });
  });

  it('degrades a huge batch to a full refresh of the vault', async () => {
    const { announce, announcer } = make();
    announcer.add({ vaultPath: 'E:\\tickets', changed: Array.from({ length: MAX_PATHS + 1 }, (_, i) => `f${i}.md`), deleted: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(announce).toHaveBeenCalledWith({ vaultId: 'drey-1', changedPaths: [] });
  });

  it('ignores empty reports and a disposed announcer', async () => {
    const { announce, announcer } = make();
    announcer.add({ vaultPath: 'E:\\tickets', changed: [], deleted: [] });
    announcer.add({ vaultPath: 'E:\\tickets', changed: ['a.md'], deleted: [] });
    announcer.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(announce).not.toHaveBeenCalled();
  });

  it('a report of a store checkout reaches the vault that is the checkout (D-28)', async () => {
    const { announce, announcer } = make({ listVaults: async () => [{ id: 'co', path: 'E:\\drey-tickets', exists: true }, VAULT] });
    announcer.add({ vaultPath: 'E:\\drey-tickets', changed: ['tickets/t/0000/t-92/ticket.md'], deleted: [] });
    await announcer.flushAll();
    expect(announce.mock.calls).toEqual([[{ vaultId: 'co', changedPaths: ['tickets/t/0000/t-92/ticket.md'] }]]);
  });

  it('a checkout inside a larger vault reaches it with its prefix, and the checkout vault too (D-25, D-28)', async () => {
    const { announce, announcer } = make({
      listVaults: async () => [
        { id: 'big', path: 'E:\\Data', exists: true },
        { id: 'co', path: 'E:\\Data\\Work\\Store', exists: true },
        { id: 'gone', path: 'E:\\Data\\Work', exists: false },
        { id: 'sibling', path: 'E:\\Data\\Work\\Store-2', exists: true },
      ],
    });
    announcer.add({ vaultPath: 'e:\\data\\Work\\Store', changed: ['tickets/a.md'], deleted: ['tickets/b.md'] });
    await announcer.flushAll();
    expect(announce.mock.calls).toEqual([
      [{ vaultId: 'big', changedPaths: ['Work/Store/tickets/a.md'], deletedPaths: ['Work/Store/tickets/b.md'] }],
      [{ vaultId: 'co', changedPaths: ['tickets/a.md'], deletedPaths: ['tickets/b.md'] }],
    ]);
  });

  it('survives a failing vault listing', async () => {
    const log = vi.fn();
    const { announce, announcer } = make({
      listVaults: async () => {
        throw new Error('boom');
      },
      log,
    });
    announcer.add({ vaultPath: 'E:\\tickets', changed: ['a.md'], deleted: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(announce).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'), 'warn');
  });
});

describe('dispatchFrame', () => {
  it('routes paths frames to the payload callback and signals to the debounced one', () => {
    const fire = vi.fn();
    const onPaths = vi.fn();
    dispatchFrame('{"change":"board"}', fire, onPaths);
    dispatchFrame('{"change":"paths","vaultPath":"E:\\\\t","changed":["a.md",1],"deleted":["b.md"]}', fire, onPaths);
    dispatchFrame('not json', fire, onPaths);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith('board');
    expect(onPaths).toHaveBeenCalledWith({ vaultPath: 'E:\\t', changed: ['a.md'], deleted: ['b.md'] });
  });

  it('never turns a paths frame into a board signal', () => {
    const fire = vi.fn();
    dispatchFrame('{"change":"paths","vaultPath":"x","changed":[],"deleted":[]}', fire);
    expect(fire).not.toHaveBeenCalled();
  });
});
