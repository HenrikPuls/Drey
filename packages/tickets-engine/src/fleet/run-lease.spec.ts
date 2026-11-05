import { describe, expect, it, vi } from 'vitest';
import { TicketStoreError } from '../ports/ticket-store';
import { dricketTrailers, RunLease, runOwnerId, trailerInstruction } from './run-lease';
import { FakeStore, FakeTimers } from './run-lease.fake';

const NOW = new Date('2026-10-17T12:00:00Z');

function lease(store: FakeStore, timers: FakeTimers, onLost = vi.fn()): RunLease {
  return new RunLease({
    store,
    ticketId: 'T-0001',
    actor: 'agent-r-1@box',
    runId: 'R-1',
    size: 'S',
    log: () => undefined,
    onLost,
    now: () => NOW,
    timers,
  });
}

describe('runOwnerId', () => {
  it('stays inside dk\'s owner grammar and is stable per run', () => {
    expect(runOwnerId('R-20261105123000-ab12', 'LEGION.lan')).toBe('agent-r-20261105123000-ab12@legion.lan');
    expect(runOwnerId('R-1', 'My Box')).toBe('agent-r-1@my-box');
    expect(runOwnerId('R-1', 'x')).toBe(runOwnerId('R-1', 'x'));
  });
});

describe('dricketTrailers', () => {
  it('writes the four trailers dk validate --trailers reads', () => {
    const lines = dricketTrailers({ dricketId: 't-1', epoch: 3, actor: 'agent-r-1@box', op: 'work' });
    expect(lines).toEqual(['Dricket-Ticket: t-1', 'Dricket-Epoch: 3', 'Dricket-Op: work', 'Dricket-Actor: agent-r-1@box']);
    expect(trailerInstruction(lines)).toContain('Dricket-Epoch: 3');
  });
});

describe('RunLease', () => {
  it('claims (remembering the stage it came from), then keeps the lease alive at half the time left', async () => {
    const store = new FakeStore();
    const timers = new FakeTimers();
    const l = lease(store, timers);
    const claim = await l.claim();
    expect(claim.epoch).toBe(1);
    expect(l.epoch).toBe(1);
    expect(l.preStage).toBe('prioritized');
    expect(store.calls.map((c) => c.op)).toEqual(['show', 'claim']);
    expect(store.of('claim')[0]).toMatchObject({ actor: 'agent-r-1@box', size: 'S' });
    expect(timers.armed?.ms).toBe(3_600_000); // 2 h left -> extend after 1 h

    await timers.fire();
    expect(store.of('extend')).toHaveLength(1);
    expect(store.of('extend')[0]?.text).toContain('R-1');
    expect(timers.armed).not.toBeNull(); // re-armed
  });

  it('exit 13 on an extension fences the lease and reports it once', async () => {
    const store = new FakeStore();
    const timers = new FakeTimers();
    const onLost = vi.fn();
    const l = lease(store, timers, onLost);
    await l.claim();
    store.loseClaim();
    await timers.fire();
    expect(l.fenced).toBe(true);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(timers.armed).toBeNull();
    // Nothing is written after the fence.
    const result = await l.release(['prioritized'], 'late note');
    expect(result).toMatchObject({ ok: false, lost: true });
    expect(store.of('release')).toHaveLength(0);
    expect(store.of('comment')).toHaveLength(0);
  });

  it('a transient extension failure is retried after a minute, a spent budget just ends the keep-alive', async () => {
    const store = new FakeStore();
    const timers = new FakeTimers();
    const l = lease(store, timers);
    await l.claim();
    store.failNext('extend', new TicketStoreError('network', 'store unreachable', 15));
    await timers.fire();
    expect(timers.armed?.ms).toBe(60_000);
    store.failNext('extend', new TicketStoreError('invalid', 'extension budget spent', 14));
    await timers.fire();
    expect(timers.armed).toBeNull();
    expect(l.fenced).toBe(false);
  });

  it('release puts the note in a comment (never release -m) and takes the first stage dk accepts', async () => {
    const store = new FakeStore();
    const l = lease(store, new FakeTimers());
    await l.claim();
    // build -> build is refused for an agent: the second candidate is taken.
    const result = await l.release(['build', 'prioritized', 'build'], 'run R-1 failed');
    expect(result).toEqual({ ok: true, stage: 'prioritized' });
    expect(store.calls.map((c) => c.op)).toEqual(['show', 'claim', 'comment', 'release', 'release']);
    expect(store.of('comment')[0]?.text).toBe('run R-1 failed');
    expect(store.of('release').map((c) => c.stage)).toEqual(['build', 'prioritized']);
    expect(l.released).toBe(true);
  });

  it('an unknown stage or an unreachable store ends the candidate walk with the reason', async () => {
    const store = new FakeStore();
    const l = lease(store, new FakeTimers());
    await l.claim();
    const none = await l.release(['blocked'], null);
    expect(none).toMatchObject({ ok: false, lost: false });
    expect(store.of('comment')).toHaveLength(0);

    store.failNext('release', new TicketStoreError('network', 'store unreachable', 15));
    const down = await l.release(['prioritized', 'inbox'], null);
    expect(down).toMatchObject({ ok: false, lost: false, error: 'store unreachable' });
    expect(store.of('release').filter((c) => c.stage === 'inbox')).toHaveLength(0);
  });

  it('a refused claim throws dk\'s error and starts no keep-alive', async () => {
    const store = new FakeStore();
    const timers = new FakeTimers();
    const l = lease(store, timers);
    store.failNext('claim', new TicketStoreError('claimed', 'ticket t-1 is claimed by henrik', 11));
    await expect(l.claim()).rejects.toMatchObject({ kind: 'claimed' });
    expect(timers.armed).toBeNull();
  });
});
