import { describe, expect, it, vi } from 'vitest';
import { remoteActorOf } from '../contracts/remote-protocol';
import type { BoardSnapshot, TicketCard } from '../contracts/tickets';
import type { ChainEntry } from '../contracts/chain';
import type { ScoutReport } from '../contracts/scout';
import { renderScoutReportSection } from '../core/scout';
import { parseStatusLog, type StatusLine } from '../core/status-log';
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
    kind: 'agent',
    title,
    role: 'builder',
    worker: 'claude-code',
    models: { default: 'opus', pool: ['opus'], router: 'off' },
    color: '#a78bfa',
    skills: [],
    budget: null,
  };
}

function fakes(): { board: RemoteBoard; fleet: RemoteFleet } {
  const board: RemoteBoard = {
    refresh: vi.fn(async () => ({ columns: [], checkpoints: [], pipeline: [] }) as unknown as BoardSnapshot),
    readTicket: vi.fn(async () => ({ ok: false as const, error: 'x' })),
    refineTicket: vi.fn(async () => ({ ok: true, revision: '0123456789abcdef' })),
    saveAttachment: vi.fn(async () => ({ ok: true, file: 'tickets/attachments/img-test.png' })),
    createTicket: vi.fn(async () => ({ ok: true, id: 'T-0001' })),
    transition: vi.fn(async () => ok),
    setClaim: vi.fn(async () => ok),
    archive: vi.fn(async () => ok),
    startRun: vi.fn(async () => ({ ok: true, runId: 'r1' })),
    listPersonas: vi.fn(async () => []),
    ledgerText: vi.fn(async () => null),
    saveTicket: vi.fn(async () => ({ ok: true, revision: '0123456789abcdef' })),
    ticketDiff: vi.fn(async () => ({ files: [], truncated: false })),
    estimateOf: vi.fn(async () => null),
    planParts: vi.fn(async () => ({ ok: false as const, error: 'x' })),
    editPlanParts: vi.fn(async () => ok),
    releasePlan: vi.fn(async () => ({ ok: true as const, tickets: [] })),
    flowOf: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    flowEdit: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    saveFlow: vi.fn(async () => ({ ok: true as const })),
    flowDraftContext: vi.fn(async () => ({ ok: true as const, text: 'ctx' })),
    ticketFile: vi.fn(async () => ({ ok: false as const, error: 'nope' })),
    worktreeChangesOf: vi.fn(async () => []),
    acceptTicket: vi.fn(async () => ok),
    sendBack: vi.fn(async () => ok),
    answerNeed: vi.fn(async () => ok),
    personaImprovements: vi.fn(async () => ({ ok: false as const, error: 'persona "pia" does not exist' })),
    decideImprovement: vi.fn(async () => ok),
    statusOf: vi.fn(async () => [] as readonly StatusLine[]),
    snapshot: vi.fn(async () => ({ columns: [], checkpoints: [], pipeline: [] }) as unknown as BoardSnapshot),
    personaThread: vi.fn(async () => ({ ok: true as const, messages: [] })),
    personaThreadAppend: vi.fn(async () => ({ ok: true as const, messages: [] })),
    personaMemory: vi.fn(async () => ({ ok: true as const, entries: [] })),
    personaMemoryAppend: vi.fn(async () => ({ ok: true as const, entries: [] })),
    personaMemoryPin: vi.fn(async () => ({ ok: true as const, entries: [] })),
    personaPatch: vi.fn(async () => ok),
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
    setAutopilot: vi.fn(async () => null),
    setColumn: vi.fn(async () => null),
    stopColumn: vi.fn(async () => null),
    abortAll: vi.fn(async () => null),
    setPersonaPaused: vi.fn(async () => null),
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
        budget: 25,
        body: 'Who Pia is.',
      },
    ] as unknown as Awaited<ReturnType<typeof board.listPersonas>>);
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    await expect(port.personas()).resolves.toEqual([
      {
        id: 'pia',
        title: 'Pia',
        role: 'planner',
        worker: 'claude-code',
        model: 'opus',
        pool: ['opus', 'sonnet'],
        color: '#a78bfa',
        budget: 25,
      },
    ]);
  });

  it('attaches the ledger’s settled costs of today as the persona’s dailyCost (concept §4.3)', async () => {
    const { board, fleet } = fakes();
    const day = new Date().toISOString().slice(0, 10);
    vi.mocked(board.listPersonas).mockResolvedValue([
      fakePersona('pia', 'Pia'),
      { ...fakePersona('ben', 'Ben'), budget: 40 },
    ]);
    vi.mocked(board.ledgerText).mockResolvedValue(
      [
        // Pia spent today (two settled runs) and yesterday (one — not today).
        `{"v":1,"ts":"${day}T09:00:00Z","event":"run_settled","ticket":"T-0001","persona":"pia","model":"opus","tokensIn":48000,"tokensOut":6000,"cost":1.17}`,
        `{"v":1,"ts":"${day}T11:00:00Z","event":"run_settled","ticket":"T-0002","persona":"pia","model":"opus","tokensIn":10000,"tokensOut":1000,"cost":0.23}`,
        `{"v":1,"ts":"2026-01-01T09:00:00Z","event":"run_settled","ticket":"T-0003","persona":"pia","model":"opus","tokensIn":1,"tokensOut":1,"cost":9}`,
        // Ben settled today, but the run carried no cost: no dailyCost — never a fake 0.
        `{"v":1,"ts":"${day}T12:00:00Z","event":"run_settled","ticket":"T-0004","persona":"ben","model":"glm-5.3","tokensIn":5000,"tokensOut":500}`,
        `{"v":1,"ts":"${day}T13:00:00Z","event":"dispatched","ticket":"T-0005","persona":"pia","model":"opus"}`,
      ].join('\n'),
    );
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    const views = await port.personas();
    const pia = views.find((v) => v.id === 'pia');
    const ben = views.find((v) => v.id === 'ben');
    expect(pia?.dailyCost).toBe(1.4); // 1.17 + 0.23, yesterday's 9 excluded
    expect(pia?.budget).toBeNull();
    expect(ben?.budget).toBe(40);
    expect(ben?.dailyCost).toBeUndefined();
  });

  it('carries the persona’s phase assignment and the chain’s pause state (U4)', async () => {
    const { board, fleet } = fakes();
    vi.mocked(board.listPersonas).mockResolvedValue([fakePersona('pia', 'Pia'), fakePersona('ben', 'Ben')]);
    vi.mocked(board.snapshot).mockResolvedValue({
      columns: [],
      checkpoints: [],
      pipeline: [
        { id: 'plan', persona: 'pia' },
        { id: 'review', persona: 'pia' },
        { id: 'build', persona: null },
      ],
    } as unknown as BoardSnapshot);
    vi.mocked(fleet.chainStatus).mockResolvedValue({
      configured: true,
      master: 'run',
      columns: {},
      redStreak: {},
      cooldownUntil: {},
      pausedPersonas: ['pia'],
    });
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    const views = await port.personas();
    const pia = views.find((v) => v.id === 'pia');
    const ben = views.find((v) => v.id === 'ben');
    expect(pia?.phases).toEqual(['plan', 'review']);
    expect(pia?.paused).toBe(true);
    expect(ben?.paused).toBe(false);
    expect(ben?.phases).toBeUndefined(); // no pipeline entry names Ben
    // The runner is down: the pause state is unknown — absent, never a fake false.
    vi.mocked(fleet.chainStatus).mockResolvedValue(null);
    const down = await (port.personas() as Promise<readonly { id: string; paused?: boolean }[]>);
    expect(down.find((v) => v.id === 'pia')?.paused).toBeUndefined();
  });

  it('chainPersonaPause delegates to the runner and refuses honestly when it is down (U4)', async () => {
    const { board, fleet } = fakes();
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    vi.mocked(fleet.setPersonaPaused).mockResolvedValue({
      configured: true,
      master: 'run',
      columns: {},
      redStreak: {},
      cooldownUntil: {},
      pausedPersonas: ['pia'],
    });
    await expect(port.chainPersonaPause({ persona: 'pia', paused: true })).resolves.toEqual({ ok: true, persona: 'pia', paused: true });
    expect(fleet.setPersonaPaused).toHaveBeenCalledWith('pia', true);
    vi.mocked(fleet.setPersonaPaused).mockResolvedValue(null);
    await expect(port.chainPersonaPause({ persona: 'pia', paused: true })).resolves.toEqual({
      ok: false,
      error: 'the fleet runner is not running',
    });
  });

  it('chainAutopilot wraps the runner status and keeps its refusal codes (req-95)', async () => {
    const { board, fleet } = fakes();
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    const status = { configured: true, master: 'halted' as const, autopilot: { state: 'paused' as const }, columns: {}, redStreak: {}, cooldownUntil: {} };
    vi.mocked(fleet.setAutopilot).mockResolvedValue(status);
    await expect(port.chainAutopilot({ state: 'paused' })).resolves.toEqual({ ok: true, status });
    expect(fleet.setAutopilot).toHaveBeenCalledWith({ state: 'paused' });

    const refusal = { ok: false as const, error: 'bad_resume_at', code: 'bad_resume_at' as const };
    vi.mocked(fleet.setAutopilot).mockResolvedValue(refusal);
    await expect(port.chainAutopilot({ state: 'paused', resumeAt: 'x' })).resolves.toEqual(refusal);

    vi.mocked(fleet.setAutopilot).mockResolvedValue(null);
    await expect(port.chainAutopilot({ state: 'on' })).resolves.toEqual({ ok: false, error: 'runner_down', code: 'runner_down' });
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

  describe('the E7 status needs', () => {
    /** A minimal board card — only what needsOf and statusNeeds read. */
    function card(id: string, phase: string, title: string | null): TicketCard {
      return {
        id,
        path: `tickets/${phase}/${id}.md`,
        phase,
        meta: { title, entered: {}, run: null, claimedBy: null },
      } as unknown as TicketCard;
    }

    function boardWith(cards: readonly { id: string; phase: string; title: string | null }[]): BoardSnapshot {
      const phases = [...new Set(cards.map((c) => c.phase))];
      return {
        pipeline: phases.map((id) => ({ id })),
        columns: phases.map((phase) => ({
          phase: { id: phase },
          tickets: cards.filter((c) => c.phase === phase).map((c) => card(c.id, c.phase, c.title)),
          unknown: false,
        })),
        checkpoints: [],
      } as unknown as BoardSnapshot;
    }

    it('surfaces every board ticket open decisions and blockers, keys in the text', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue(
        boardWith([
          { id: 'T-0001', phase: 'build', title: 'The build ticket' },
          { id: 'T-0002', phase: 'review', title: null },
        ]),
      );
      vi.mocked(board.statusOf).mockImplementation(async (id: string) =>
        id === 'T-0001'
          ? parseStatusLog(
              [
                "- '2026-11-02T09:00:00Z' working: build on opus",
                "- '2026-11-02T09:12:00Z' needs-decision: [palette-shortcut] Which shortcut should open the palette?",
                "- '2026-11-02T09:30:00Z' blocked: waiting for CI",
              ].join('\n'),
            )
          : parseStatusLog("- '2026-11-02T10:00:00Z' needs-decision: Which colour?"),
      );
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      expect(await port.needs()).toEqual([
        // The keyless blocked line is its own item and the fold surfaces
        // keyless items before the keyed ones.
        {
          kind: 'blocked',
          ticketId: 'T-0001',
          title: 'The build ticket',
          phase: 'build',
          runId: null,
          text: 'waiting for CI',
          since: '2026-11-02T09:30:00Z',
        },
        {
          kind: 'needs-decision',
          ticketId: 'T-0001',
          title: 'The build ticket',
          phase: 'build',
          runId: null,
          text: '[palette-shortcut] Which shortcut should open the palette?',
          since: '2026-11-02T09:12:00Z',
        },
        {
          kind: 'needs-decision',
          ticketId: 'T-0002',
          title: 'T-0002',
          phase: 'review',
          runId: null,
          text: 'Which colour?',
          since: '2026-11-02T10:00:00Z',
        },
      ]);
    });

    it('a resolved key vanishes; a ticket with nothing open contributes nothing', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue(boardWith([{ id: 'T-0001', phase: 'build', title: 'The build ticket' }]));
      vi.mocked(board.statusOf).mockResolvedValue(
        parseStatusLog(
          [
            "- '2026-11-02T09:12:00Z' needs-decision: [palette-shortcut] Which shortcut should open the palette?",
            "- '2026-11-02T09:40:00Z' resolved: palette-shortcut",
            "- '2026-11-02T09:45:00Z' done: handed over on build",
          ].join('\n'),
        ),
      );
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
      expect(await port.needs()).toEqual([]);
    });

    it('a broken status read appends nothing, the other tickets still surface', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue(
        boardWith([
          { id: 'T-0001', phase: 'build', title: 'The build ticket' },
          { id: 'T-0002', phase: 'review', title: null },
        ]),
      );
      vi.mocked(board.statusOf).mockImplementation(async (id: string) =>
        id === 'T-0001'
          ? Promise.reject(new Error('EBUSY: the status log is locked'))
          : parseStatusLog("- '2026-11-02T10:00:00Z' blocked: [ci-red] the gate is red"),
      );
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      expect(await port.needs()).toEqual([
        {
          kind: 'blocked',
          ticketId: 'T-0002',
          title: 'T-0002',
          phase: 'review',
          runId: null,
          text: '[ci-red] the gate is red',
          since: '2026-11-02T10:00:00Z',
        },
      ]);
    });

    it('caps the status needs at 20', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue(boardWith([{ id: 'T-0001', phase: 'build', title: null }]));
      const many = Array.from({ length: 25 }, (_, i) => `- '2026-11-02T1${String(i).padStart(2, '0')}:00:00Z' needs-decision: question ${i + 1}?`);
      vi.mocked(board.statusOf).mockResolvedValue(parseStatusLog(many.join('\n')));
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      const needs = await port.needs();
      expect(needs).toHaveLength(20);
      expect(needs.every((item) => item.kind === 'needs-decision' && item.ticketId === 'T-0001')).toBe(true);
    });
  });

  describe('the E8 report needs', () => {
    /** A minimal board card — only what needsOf and the sweeps read. */
    function card(id: string, phase: string, title: string | null, form?: 'scout'): TicketCard {
      return {
        id,
        path: `tickets/${phase}/${id}.md`,
        phase,
        meta: { title, entered: {}, run: null, claimedBy: null, form },
      } as unknown as TicketCard;
    }

    /** A ticket file around one `## Report` section, as the scout run leaves it. */
    const ticketFile = (section: string): string => `---\nform: scout\n---\n\n# T-0004\n\n${section}`;

    const report: ScoutReport = {
      writtenAt: '2026-11-02T14:32:00Z',
      by: 'pia',
      summary: 'The repo carries two index implementations.',
      decisions: [
        { key: 'D1', question: 'Which storage should back the index?', recommendation: 'SQLite', resolved: false },
        { key: 'D2', question: 'Migrate existing data?', recommendation: 'yes, one migration script', resolved: true },
      ],
    };

    it("surfaces a scout ticket's report section as a report card", async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue({
        pipeline: [{ id: 'plan' }],
        columns: [{ phase: { id: 'plan' }, tickets: [card('T-0004', 'plan', 'Explore storage', 'scout')], unknown: false }],
        checkpoints: [],
      } as unknown as BoardSnapshot);
      vi.mocked(board.readTicket).mockResolvedValue({
        ok: true,
        card: card('T-0004', 'plan', 'Explore storage', 'scout'),
        text: ticketFile(renderScoutReportSection(report)),
        revision: '0123456789abcdef',
      });
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      expect(await port.needs()).toEqual([
        {
          kind: 'report',
          ticketId: 'T-0004',
          title: 'Explore storage',
          phase: 'plan',
          runId: null,
          text: '1 of 2 decisions open — Which storage should back the index?',
          since: '2026-11-02T14:32:00Z',
          report,
        },
      ]);
    });

    it('skips a promoted ticket even though the report chapter stays in the file', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue({
        pipeline: [{ id: 'plan' }],
        columns: [{ phase: { id: 'plan' }, tickets: [card('T-0004', 'plan', 'Explore storage')], unknown: false }],
        checkpoints: [],
      } as unknown as BoardSnapshot);
      vi.mocked(board.readTicket).mockResolvedValue({
        ok: true,
        card: card('T-0004', 'plan', 'Explore storage'),
        text: ticketFile(renderScoutReportSection(report)),
        revision: '0123456789abcdef',
      });
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      expect(await port.needs()).toEqual([]);
      expect(board.readTicket).not.toHaveBeenCalled();
    });

    it('a scout ticket without a section, a broken read or a failed read surfaces nothing', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue({
        pipeline: [{ id: 'plan' }],
        columns: [
          {
            phase: { id: 'plan' },
            tickets: [
              card('T-0001', 'plan', 'No report yet', 'scout'),
              card('T-0002', 'plan', 'The file is locked', 'scout'),
              card('T-0003', 'plan', 'Leaves the board mid-read', 'scout'),
            ],
            unknown: false,
          },
        ],
        checkpoints: [],
      } as unknown as BoardSnapshot);
      vi.mocked(board.readTicket).mockImplementation(async (id: string) => {
        if (id === 'T-0001') {
          return { ok: true, card: card('T-0001', 'plan', 'No report yet', 'scout'), text: '---\nform: scout\n---\n\n# T-0001\n\nThe scout has not reported yet.\n', revision: '0123456789abcdef' };
        }
        if (id === 'T-0002') {
          throw new Error('EBUSY: the ticket file is locked');
        }
        return { ok: false as const, error: 'T-0003 is not on the board' };
      });
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      expect(await port.needs()).toEqual([]);
    });

    it('appends the report cards after the needsOf, improvements and status needs', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue({
        pipeline: [{ id: 'plan-review' }],
        columns: [
          {
            phase: { id: 'plan-review' },
            tickets: [card('T-0004', 'plan-review', 'Explore storage', 'scout'), card('T-0005', 'plan-review', 'Build it')],
            unknown: false,
          },
        ],
        checkpoints: ['plan-review'],
      } as unknown as BoardSnapshot);
      vi.mocked(board.listPersonas).mockResolvedValue([{ id: 'pia', title: 'Pia' }] as unknown as Awaited<ReturnType<typeof board.listPersonas>>);
      vi.mocked(board.personaImprovements).mockResolvedValue({
        ok: true,
        persona: fakePersona('pia', 'Pia'),
        proposals: [],
        openCount: 3,
        frictionCount: 5,
      });
      vi.mocked(board.statusOf).mockImplementation(async (id: string) =>
        id === 'T-0005' ? parseStatusLog("- '2026-11-02T09:12:00Z' needs-decision: Which colour?") : [],
      );
      vi.mocked(board.readTicket).mockResolvedValue({
        ok: true,
        card: card('T-0004', 'plan-review', 'Explore storage', 'scout'),
        text: ticketFile(renderScoutReportSection(report)),
        revision: '0123456789abcdef',
      });
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      const items = await port.needs();
      expect(items.map((i) => [i.kind, i.ticketId])).toEqual([
        ['checkpoint', 'T-0004'],
        ['checkpoint', 'T-0005'],
        ['improvements', ''],
        ['needs-decision', 'T-0005'],
        ['report', 'T-0004'],
      ]);
    });
  });

  describe('the E9 notify needs', () => {
    /** A minimal board card — only what needsOf and notifyNeedsOf read. */
    function card(id: string, phase: string, title: string | null, chain?: readonly ChainEntry[], entered: Record<string, string> = {}): TicketCard {
      return {
        id,
        path: `tickets/${phase}/${id}.md`,
        phase,
        meta: { title, entered, run: null, claimedBy: null, ...(chain !== undefined && chain.length > 0 ? { chain } : {}) },
      } as unknown as TicketCard;
    }

    const phases = [
      { id: 'plan', title: 'Plan' },
      { id: 'design', title: 'Design' },
      { id: 'build', title: 'Build' },
    ];

    const boardWith = (tickets: readonly TicketCard[]): BoardSnapshot =>
      ({
        pipeline: phases,
        columns: phases.map((phase) => ({ phase, tickets: tickets.filter((t) => t.phase === phase.id), unknown: false })),
        checkpoints: [],
      }) as unknown as BoardSnapshot;

    it('appends a Bescheid card derived from the snapshot alone — no ticket file is read', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue(
        boardWith([card('T-0001', 'design', 'The design ticket', [{ kind: 'notify', phase: 'plan' }], { design: new Date(Date.now() - 60 * 60_000).toISOString() })]),
      );
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      expect(await port.needs()).toEqual([
        {
          kind: 'notify',
          ticketId: 'T-0001',
          title: 'The design ticket',
          phase: 'design',
          runId: null,
          text: 'the Plan gate completed',
          since: expect.any(String),
        },
      ]);
      expect(board.readTicket).not.toHaveBeenCalled();
    });

    it('appends the Bescheid cards after the status and report needs', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue(
        boardWith([
          card('T-0001', 'design', 'The design ticket', [{ kind: 'notify', phase: 'plan' }], { design: new Date(Date.now() - 60 * 60_000).toISOString() }),
          card('T-0002', 'build', 'The build ticket', undefined, { build: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }),
        ]),
      );
      vi.mocked(board.statusOf).mockImplementation(async (id: string) =>
        id === 'T-0002' ? parseStatusLog("- '2026-11-02T09:12:00Z' needs-decision: Which colour?") : [],
      );
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      const items = await port.needs();
      expect(items.map((i) => [i.kind, i.ticketId])).toEqual([
        ['needs-decision', 'T-0002'],
        ['notify', 'T-0001'],
      ]);
    });

    it('a stale or still-running gate appends nothing', async () => {
      const { board, fleet } = fakes();
      vi.mocked(board.refresh).mockResolvedValue(
        boardWith([
          // Stale: the completion is a day and a half old.
          card('T-0001', 'design', 'Old news', [{ kind: 'notify', phase: 'plan' }], { design: new Date(Date.now() - 36 * 60 * 60_000).toISOString() }),
          // Still running: the ticket sits in the notified gate.
          card('T-0002', 'plan', 'Not yet', [{ kind: 'notify', phase: 'plan' }], { plan: new Date(Date.now() - 60 * 60_000).toISOString() }),
          // No delta at all.
          card('T-0003', 'build', 'Standard flow', undefined, { build: new Date(Date.now() - 60 * 60_000).toISOString() }),
        ]),
      );
      const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });

      expect(await port.needs()).toEqual([]);
    });
  });
});

describe('handoffRun (E12-4)', () => {
  const run = (patch: Record<string, unknown>) =>
    ({ id: 'r1', ticketId: 'T-0007', provider: 'opencode', state: 'running', ...patch }) as never;

  it('stops the run, waits it out and restarts the ticket on Claude Code, fresh', async () => {
    const { board, fleet } = fakes();
    vi.mocked(fleet.runs)
      .mockResolvedValueOnce([run({})])
      .mockResolvedValueOnce([run({ state: 'stopping' })])
      .mockResolvedValue([run({ state: 'stopped' })]);
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    await expect(port.handoffRun({ runId: 'r1' })).resolves.toEqual({ ok: true, runId: 'r1' });
    expect(fleet.stop).toHaveBeenCalledWith('r1', 'handed to Claude Code');
    expect(board.startRun).toHaveBeenCalledWith({
      ticketId: 'T-0007',
      workerChoice: 'claude-code',
      permissionMode: 'accept-edits',
      handover: 'fresh',
      interactive: null,
    });
  });

  it('refuses an unknown run and a run already on Claude Code, and starts nothing when the stop fails', async () => {
    const { board, fleet } = fakes();
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false });
    await expect(port.handoffRun({ runId: 'nope' })).resolves.toMatchObject({ ok: false, error: 'no such run' });

    vi.mocked(fleet.runs).mockResolvedValue([run({ provider: 'claude-code' })]);
    await expect(port.handoffRun({ runId: 'r1' })).resolves.toMatchObject({ ok: false });
    expect(fleet.stop).not.toHaveBeenCalled();

    vi.mocked(fleet.runs).mockResolvedValue([run({})]);
    vi.mocked(fleet.stop).mockResolvedValue({ ok: false, error: 'cannot stop' });
    await expect(port.handoffRun({ runId: 'r1' })).resolves.toEqual({ ok: false, error: 'cannot stop' });
    expect(board.startRun).not.toHaveBeenCalled();
  });
});

describe('flowDraft (E10-5)', () => {
  const chat = (draft: unknown) => ({ draftFlow: vi.fn(async () => draft) }) as unknown as import('../contracts/chat').ChatServicePort;
  const view = { ok: true as const, ticket: 'T-1', title: 't', scope: { kind: 'ticket' as const }, chain: ['skip verify'], saved: [], steps: [], phases: [], personas: [], readOnly: null };

  it('reads the draft back through the board and carries Paul’s reason', async () => {
    const { board, fleet } = fakes();
    vi.mocked(board.flowDraftContext).mockResolvedValue({ ok: true, text: 'ctx' });
    vi.mocked(board.flowEdit).mockResolvedValue(view);
    const c = chat({ ok: true, chain: ['skip verify'], reason: 'No tests needed.' });
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false }, c);
    await expect(port.flowDraft({ id: 'T-1', part: null, ask: 'quick one' })).resolves.toEqual({ ...view, reason: 'No tests needed.' });
    expect(vi.mocked(c.draftFlow)).toHaveBeenCalledWith({ ticket: 'T-1', context: 'ctx', ask: 'quick one' });
    expect(board.flowEdit).toHaveBeenCalledWith({ id: 'T-1', part: null, chain: ['skip verify'], edit: { op: 'view' } });
  });

  it('passes the refusal on, and says when his draft does not hold', async () => {
    const { board, fleet } = fakes();
    vi.mocked(board.flowDraftContext).mockResolvedValue({ ok: true, text: 'ctx' });
    const refused = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false }, chat({ ok: false, error: 'No model.' }));
    await expect(refused.flowDraft({ id: 'T-1', part: null, ask: null })).resolves.toEqual({ ok: false, error: 'No model.' });
    vi.mocked(board.flowEdit).mockResolvedValue({ ok: false, error: 'the pipeline has no phase "design"' });
    const bad = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false }, chat({ ok: true, chain: ['insert design after review'], reason: 'r' }));
    await expect(bad.flowDraft({ id: 'T-1', part: null, ask: null })).resolves.toEqual({ ok: false, error: "Paul's draft does not hold: the pipeline has no phase \"design\"" });
  });

  it('stops before asking Paul when the flow cannot change', async () => {
    const { board, fleet } = fakes();
    vi.mocked(board.flowDraftContext).mockResolvedValue({ ok: false, error: 'A run is live.' });
    const c = chat({ ok: true, chain: [], reason: '' });
    const port = new DreyTicketsPort(board, fleet, new ChangeHub(), { allowBypass: () => false }, c);
    await expect(port.flowDraft({ id: 'T-1', part: null, ask: null })).resolves.toEqual({ ok: false, error: 'A run is live.' });
    expect(vi.mocked(c.draftFlow)).not.toHaveBeenCalled();
  });
});

describe('remoteActorOf', () => {
  it('fits a device name into the <who>@<host> grammar', () => {
    expect(remoteActorOf('iPad')).toBe('owner@ipad');
    expect(remoteActorOf("Henrik's iPhone 15")).toBe('owner@henrik-s-iphone-15');
    expect(remoteActorOf('  ')).toBe('owner@remote');
  });
});
