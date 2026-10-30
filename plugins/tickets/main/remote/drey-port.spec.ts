import { describe, expect, it, vi } from 'vitest';
import { remoteActorOf } from '../../shared/remote-protocol';
import type { BoardSnapshot } from '../../shared/tickets';
import { BYPASS_REFUSAL, ChangeHub, DreyTicketsPort, type RemoteBoard, type RemoteFleet } from './drey-port';

/**
 * req-66: the Drey adapter behind the remote port — the actor reaches
 * every board write, bypass runs are refused unless allowed, and the
 * chain controls answer "not running" when the runner is down.
 */

const ok = { ok: true } as const;

function fakes(): { board: RemoteBoard; fleet: RemoteFleet } {
  const board: RemoteBoard = {
    refresh: vi.fn(async () => ({ columns: [], checkpoints: [] }) as unknown as BoardSnapshot),
    readTicket: vi.fn(async () => ({ ok: false as const, error: 'x' })),
    refineTicket: vi.fn(async () => ({ ok: true, revision: '0123456789abcdef' })),
    createTicket: vi.fn(async () => ({ ok: true, id: 'T-0001' })),
    transition: vi.fn(async () => ok),
    reorder: vi.fn(async () => ok),
    unpin: vi.fn(async () => ok),
    setClaim: vi.fn(async () => ok),
    archive: vi.fn(async () => ok),
    startRun: vi.fn(async () => ({ ok: true, runId: 'r1' })),
  };
  const fleet: RemoteFleet = {
    runs: vi.fn(async () => []),
    chainStatus: vi.fn(async () => null),
    stop: vi.fn(async () => ok),
    send: vi.fn(async () => ok),
    answerPermission: vi.fn(async () => ok),
    answerQuestion: vi.fn(async () => ok),
    stream: vi.fn(async () => null),
    setMaster: vi.fn(async () => null),
    setColumn: vi.fn(async () => null),
    stopColumn: vi.fn(async () => null),
    abortAll: vi.fn(async () => null),
  };
  return { board, fleet };
}

describe('DreyTicketsPort', () => {
  it('hands the actor to every board write', async () => {
    const { board, fleet } = fakes();
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    await port.move({ id: 'T-0001', from: 'build', to: 'review', index: null }, 'owner@ipad');
    await port.claim({ id: 'T-0001', mode: 'takeover' }, 'owner@ipad');
    await port.archive({ id: 'T-0001' }, 'owner@ipad');
    await port.create({ title: 'x', priority: 'normal', repo: null, description: '' }, 'owner@ipad');
    await port.refine({ id: 'T-0001', baseRevision: '0123456789abcdef', sections: { plan: 'p' }, header: {} }, 'owner@ipad');
    expect(board.refineTicket).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad', sections: { plan: 'p' } }));
    expect(board.transition).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad', to: 'review' }));
    expect(board.setClaim).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad', mode: 'takeover' }));
    expect(board.archive).toHaveBeenCalledWith({ id: 'T-0001', actor: 'owner@ipad' });
    expect(board.createTicket).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad' }));
  });

  it('refuses a bypass run unless the setting allows it', async () => {
    const cmd = { ticketId: 'T-0001', workerChoice: null, permissionMode: 'bypass', handover: null } as const;
    const refused = fakes();
    const strict = new DreyTicketsPort(refused.board, refused.fleet, new ChangeHub(), { allowBypass: () => false });
    expect(await strict.startRun(cmd)).toEqual({ ok: false, error: BYPASS_REFUSAL });
    expect(refused.board.startRun).not.toHaveBeenCalled();
    expect(await strict.startRun({ ...cmd, permissionMode: 'accept-edits' })).toEqual({ ok: true, runId: 'r1' });

    const allowed = fakes();
    const open = new DreyTicketsPort(allowed.board, allowed.fleet, new ChangeHub(), { allowBypass: () => true });
    expect(await open.startRun(cmd)).toEqual({ ok: true, runId: 'r1' });
  });

  it('answers "not running" for chain controls and an empty stream without a runner', async () => {
    const { board, fleet } = fakes();
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    expect(await port.chainMaster('halted')).toEqual({ ok: false, error: 'the fleet runner is not running' });
    expect(await port.chainAbort()).toEqual({ ok: false, error: 'the fleet runner is not running' });
    expect(await port.stream('r1')).toBe('');
    expect(await port.needs()).toEqual([]);
  });

  it('relays changes until unsubscribed', () => {
    const { board, fleet } = fakes();
    const hub = new ChangeHub();
    const port = new DreyTicketsPort(board, fleet, hub, { allowBypass: () => false });
    const seen: string[] = [];
    const off = port.onChanged((what) => seen.push(what));
    hub.emit('board');
    off();
    hub.emit('fleet');
    expect(seen).toEqual(['board']);
  });
});

describe('remoteActorOf', () => {
  it('fits a device name into the <who>@<host> grammar', () => {
    expect(remoteActorOf('iPad')).toBe('owner@ipad');
    expect(remoteActorOf("Henrik's iPhone 15")).toBe('owner@henrik-s-iphone-15');
    expect(remoteActorOf('  ')).toBe('owner@remote');
  });
});
