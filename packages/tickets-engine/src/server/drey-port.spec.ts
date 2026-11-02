import { describe, expect, it, vi } from 'vitest';
import { remoteActorOf } from '../contracts/remote-protocol';
import type { BoardSnapshot } from '../contracts/tickets';
import { BYPASS_REFUSAL, ChangeHub, DreyTicketsPort, type RemoteBoard, type RemoteFleet } from './drey-port';

/**
 * req-66: the Drey adapter behind the remote port — the actor reaches
 * every board write, bypass runs are refused unless allowed, and the
 * chain controls answer "not running" when the runner is down.
 */

const ok = { ok: true } as const;

/** A full-shaped persona for the E6 reply fakes (the reply type carries Persona). */
function fakePersona(id: string, title: string): import('../core/persona').Persona {
  return {
    id,
    title,
    role: 'builder',
    worker: 'claude-code',
    models: { default: 'opus', pool: ['opus'], router: 'off' },
    color: '#a78bfa',
    skills: [],
  };
}

function fakes(): { board: RemoteBoard; fleet: RemoteFleet } {
  const board: RemoteBoard = {
    refresh: vi.fn(async () => ({ columns: [], checkpoints: [] }) as unknown as BoardSnapshot),
    readTicket: vi.fn(async () => ({ ok: false as const, error: 'x' })),
    refineTicket: vi.fn(async () => ({ ok: true, revision: '0123456789abcdef' })),
    saveAttachment: vi.fn(async () => ({ ok: true, file: 'tickets/attachments/img-test.png' })),
    createTicket: vi.fn(async () => ({ ok: true, id: 'T-0001' })),
    transition: vi.fn(async () => ok),
    setClaim: vi.fn(async () => ok),
    archive: vi.fn(async () => ok),
    startRun: vi.fn(async () => ({ ok: true, runId: 'r1' })),
    listPersonas: vi.fn(async () => []),
    saveTicket: vi.fn(async () => ({ ok: true, revision: '0123456789abcdef' })),
    ticketDiff: vi.fn(async () => ({ files: [], truncated: false })),
    worktreeChangesOf: vi.fn(async () => []),
    acceptTicket: vi.fn(async () => ok),
    sendBack: vi.fn(async () => ok),
    personaImprovements: vi.fn(async () => ({ ok: false as const, error: 'persona "pia" does not exist' })),
    decideImprovement: vi.fn(async () => ok),
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
  it('maps personas to the team cards the Team tab renders', async () => {
    const { board, fleet } = fakes();
    vi.mocked(board.listPersonas).mockResolvedValue([
      {
        id: 'pia',
        title: 'Pia',
        role: 'planner',
        worker: 'claude-code',
        models: { default: 'opus', pool: ['opus', 'sonnet'], router: 'off' },
        color: '#a78bfa',
        skills: [],
        body: 'Who Pia is.',
      },
    ] as unknown as Awaited<ReturnType<typeof board.listPersonas>>);
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    await expect(port.personas()).resolves.toEqual([
      { id: 'pia', title: 'Pia', role: 'planner', worker: 'claude-code', model: 'opus', pool: ['opus', 'sonnet'], color: '#a78bfa' },
    ]);
  });

  it('hands the actor to every board write', async () => {
    const { board, fleet } = fakes();
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    await port.move({ id: 'T-0001', from: 'build', to: 'review' }, 'owner@ipad');
    await port.claim({ id: 'T-0001', mode: 'takeover' }, 'owner@ipad');
    await port.archive({ id: 'T-0001' }, 'owner@ipad');
    await port.create({ title: 'x', priority: 'normal', repo: null, description: '' }, 'owner@ipad');
    await port.refine({ id: 'T-0001', baseRevision: '0123456789abcdef', sections: { plan: 'p' }, header: {} }, 'owner@ipad');
    await port.saveAttachment({ bytes: Buffer.from([0x89, 0x50]), ext: 'png' }, 'owner@ipad');
    expect(board.refineTicket).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad', sections: { plan: 'p' } }));
    expect(board.saveAttachment).toHaveBeenCalledWith({ bytes: Buffer.from([0x89, 0x50]), ext: 'png', actor: 'owner@ipad' });
    expect(board.transition).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad', to: 'review' }));
    expect(board.setClaim).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad', mode: 'takeover' }));
    expect(board.archive).toHaveBeenCalledWith({ id: 'T-0001', actor: 'owner@ipad' });
    expect(board.createTicket).toHaveBeenCalledWith(expect.objectContaining({ actor: 'owner@ipad' }));
  });

  it('hands an attachment upload to the board service and passes a failed commit through as a warning', async () => {
    const { board, fleet } = fakes();
    board.saveAttachment = vi.fn(async () => ({ ok: true, file: 'tickets/attachments/img-test.png', warning: 'git commit failed: no user' }));
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    expect(await port.saveAttachment({ bytes: Buffer.alloc(4), ext: 'png' }, 'owner@iphone')).toEqual({
      ok: true,
      file: 'tickets/attachments/img-test.png',
      warning: 'git commit failed: no user',
    });
  });

  it('refuses a bypass run unless the setting allows it', async () => {
    const cmd = { ticketId: 'T-0001', workerChoice: null, permissionMode: 'bypass', handover: null, interactive: null } as const;
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

  it('delegates the E6 improvements card and the 1:1 decision to the board', async () => {
    const { board, fleet } = fakes();
    const view = {
      ok: true as const,
      persona: fakePersona('pia', 'Pia'),
      proposals: [{ id: 'imp-1', state: 'open' as const, target: 'prompt.md' as const, title: 'T', evidence: [], content: 'c', lesson: null, at: '2026-11-02T10:00:00Z', decidedAt: null }],
      openCount: 1,
      frictionCount: 2,
    };
    vi.mocked(board.personaImprovements).mockResolvedValue(view);
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    await expect(port.personaImprovements('pia')).resolves.toBe(view);
    expect(board.personaImprovements).toHaveBeenCalledWith('pia');

    await port.personaImprovementDecide({ persona: 'pia', proposal: 'imp-1', decision: 'accepted' });
    expect(board.decideImprovement).toHaveBeenCalledWith({ id: 'pia', proposalId: 'imp-1', decision: 'accepted' });
  });

  it('appends an improvements need per persona at or above the threshold, after the ticket needs', async () => {
    const { board, fleet } = fakes();
    vi.mocked(board.listPersonas).mockResolvedValue([
      { id: 'ben', title: 'Ben' },
      { id: 'pia', title: 'Pia' },
    ] as unknown as Awaited<ReturnType<typeof board.listPersonas>>);
    vi.mocked(board.personaImprovements).mockImplementation(async (id: string) =>
      id === 'pia'
        ? { ok: true, persona: fakePersona('pia', 'Pia'), proposals: [], openCount: 3, frictionCount: 5 }
        : { ok: true, persona: fakePersona('ben', 'Ben'), proposals: [], openCount: 2, frictionCount: 5 },
    );
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    expect(await port.needs()).toEqual([
      {
        kind: 'improvements',
        ticketId: '',
        title: 'Pia',
        phase: '',
        runId: null,
        text: '3 improvement proposals wait for the 1:1',
        since: null,
      },
    ]);

    // Below the threshold (and a broken read) appends nothing.
    vi.mocked(board.personaImprovements).mockImplementation(async (id: string) =>
      id === 'pia'
        ? { ok: false, error: 'no tickets vault detected' }
        : { ok: true, persona: fakePersona('ben', 'Ben'), proposals: [], openCount: 1, frictionCount: 0 },
    );
    expect(await port.needs()).toEqual([]);
  });
});

describe('remoteActorOf', () => {
  it('fits a device name into the <who>@<host> grammar', () => {
    expect(remoteActorOf('iPad')).toBe('owner@ipad');
    expect(remoteActorOf("Henrik's iPhone 15")).toBe('owner@henrik-s-iphone-15');
    expect(remoteActorOf('  ')).toBe('owner@remote');
  });
});
