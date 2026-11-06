// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonaView } from '../../shared/remote-protocol';
import type { ChainStatus, RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import type { DeskDeps } from '../desk-deps';
import { mountBoard } from '../board/board-view';
import { bandStatusOf, mountCapacity, personaLineOf } from './capacity-view';
import { personaCardOf } from './team-model';
import type { TeamStore } from './team-store';
import { mountTeam } from './team-view';

const persona = (patch: Partial<PersonaView>): PersonaView => ({
  id: 'ben',
  title: 'Ben',
  role: 'Builder',
  worker: 'opencode',
  model: 'qwen3-coder',
  pool: ['qwen3-coder'],
  color: '#3366cc',
  budget: 5,
  dailyCost: 2.67,
  phases: ['build'],
  ...patch,
});

const run = (patch: Partial<RunInfo>): RunInfo =>
  ({
    id: 'r1',
    ticketId: 'T-0126',
    persona: 'tessa',
    provider: 'opencode',
    state: 'running',
    startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    lastActivity: new Date(Date.now() - 9 * 60_000).toISOString(),
    stuck: true,
    ...patch,
  }) as unknown as RunInfo;

let runs: RunInfo[];
let chain: ChainStatus | null;
let invoked: [string, unknown][];
let opened: string[];

const ticketCard = (id: string, at: string): TicketCard =>
  ({ id, path: `tickets/${at}/${id}.md`, phase: at, meta: { title: `Ticket ${id}`, persona: null, parent: null, entered: {} }, usage: { tokensIn: 0, tokensOut: 0, cost: 1.2, runs: 1 }, blocked: [], blocks: [], issues: [] }) as unknown as TicketCard;

const snapshot = {
  vaultId: 'v',
  columns: [
    { phase: { id: 'inbox', title: 'Inbox', persona: null }, unknown: false, tickets: [ticketCard('T-0133', 'inbox')] },
    { phase: { id: 'build', title: 'Build', persona: 'ben' }, unknown: false, tickets: [ticketCard('T-0126', 'build')] },
  ],
  checkpoints: [],
  recentDone: [],
} as unknown as BoardSnapshot;

function deps(): DeskDeps {
  return {
    api: { ui: { icon: () => document.createElement('i') } },
    snapshot: () => snapshot,
    runs: () => runs,
    chain: () => chain,
    invoke: async (method: string, payload?: unknown) => {
      invoked.push([method, payload]);
      return method === 'personaThread' ? { ok: true, messages: [] } : { ok: true };
    },
    subscribe: () => () => undefined,
    mutate: async (_label: string, fn: () => Promise<unknown>) => {
      await fn();
      return { ok: true };
    },
    chainAction: async (method: string, payload: unknown) => {
      invoked.push([method, payload]);
    },
    openTicket: (card: TicketCard) => opened.push(card.id),
    newIdea: () => opened.push('new-idea'),
    titleOf: (id: string) => (id === 'T-0126' ? 'Git panel: stage single hunks' : null),
  } as unknown as DeskDeps;
}

const store = (personas: PersonaView[]): TeamStore => ({
  personas: () => personas,
  nameOf: (id) => personas.find((p) => p.id === id)?.title ?? id ?? '',
  loaded: () => true,
  error: () => '',
  refresh: async () => undefined,
  subscribe: () => () => undefined,
});

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

beforeEach(() => {
  runs = [run({})];
  chain = { master: 'run', poolSize: { opencode: 2, 'claude-code': 3 } } as unknown as ChainStatus;
  invoked = [];
  opened = [];
  document.body.replaceChildren();
});

afterEach(() => vi.restoreAllMocks());

describe('the Team tab', () => {
  const personas = [persona({}), persona({ id: 'tessa', title: 'Tessa', role: 'Tester', dailyCost: 0.36, budget: null })];

  it('shows the head, the capacity chips and a card per persona with its stuck run', () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    expect(host.querySelector('.desk-head-sub')!.textContent).toBe('2 personas · today $3.03');
    expect(host.querySelector('.desk-chips')!.textContent).toBe('Local 1/2Claude Code 0/3');
    const tessa = host.querySelector('[data-persona="tessa"]')!;
    expect(tessa.querySelector('.desk-persona-state')!.textContent).toBe('stuck');
    expect(tessa.querySelector('.desk-run-ticket')!.textContent).toBe('T-0126 Git panel: stage single hunks');
    expect(tessa.querySelector('.desk-run-stuckline')!.textContent).toBe('No progress for 9 minutes.');
    expect([...tessa.querySelectorAll('.desk-run-controls button')].map((b) => b.textContent)).toEqual(['Nudge', 'Hand to Claude Code', 'Stop']);
    expect(host.querySelector('[data-persona="ben"] .desk-persona-cost')!.textContent).toBe('$2.67 of $5.00 today');
  });

  it('wires Nudge, Hand to Claude Code and Stop to the fleet', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    const [nudge, handoff, stop] = [...host.querySelectorAll<HTMLButtonElement>('.desk-run-controls button')];
    nudge!.click();
    handoff!.click();
    stop!.click();
    await Promise.resolve();
    expect(invoked.map(([method]) => method)).toEqual(['fleetSend', 'handoffRun', 'fleetStop']);
    expect(invoked[1]![1]).toEqual({ runId: 'r1' });
  });

  it('offers no hand-off for a run already on Claude Code', () => {
    runs = [run({ provider: 'claude-code' })];
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    expect([...host.querySelectorAll('.desk-run-controls button')].map((b) => b.textContent)).toEqual(['Nudge', 'Stop']);
  });

  it('Pause all halts the chain, then reads Resume all', () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    const pause = [...host.querySelectorAll<HTMLButtonElement>('.desk-head-controls button')].find((b) => b.textContent === 'Pause all')!;
    pause.click();
    expect(invoked).toEqual([['chainMaster', { mode: 'halted' }]]);
    chain = { master: 'halted' } as unknown as ChainStatus;
    const host2 = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host2);
    expect(host2.querySelector('.desk-head-controls')!.textContent).toContain('Resume all');
  });

  it('arms Stop all on the first press and aborts on the second', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    const stopAll = (): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('.desk-head-controls button')].find((b) => b.textContent!.startsWith('Stop all'))!;
    stopAll().click();
    expect(invoked).toEqual([]);
    await nextFrame();
    expect(stopAll().textContent).toBe('Stop all — click again');
    stopAll().click();
    expect(invoked).toEqual([['chainAbort', {}]]);
  });

  it('opens the persona detail with the 1:1 first and asks the thread', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    host.querySelector<HTMLElement>('[data-persona="ben"]')!.click();
    await nextFrame();
    expect(host.querySelector('.desk-tab-on')!.textContent).toBe('1:1');
    expect([...host.querySelectorAll('.desk-tab')].map((t) => t.textContent)).toEqual(['1:1', 'Memory', 'Setup']);
    expect(invoked).toContainEqual(['personaThread', { persona: 'ben' }]);
  });

  it('opens a ticket from a run row', () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    host.querySelector<HTMLElement>('.desk-run-ticket')!.click();
    expect(opened).toEqual(['T-0126']);
  });
});

describe('the Capacity band', () => {
  it('says how many slots are busy and what each persona does', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const personas = [persona({}), persona({ id: 'tessa', title: 'Tessa', role: 'Tester' })];
    const open = vi.fn();
    mountCapacity(deps(), store(personas), host, open);
    expect(host.querySelector('.desk-cap-slots')!.textContent).toBe('1 of 5 slots busy');
    expect([...host.querySelectorAll('.desk-cap-person')].map((p) => p.textContent)).toEqual(['Benidle', 'Tessastuck on T-0126']);
    expect(host.querySelector('.desk-cap-today')!.textContent).toBe('Today $5.34 of $10.00');
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Open Crew ›')!.click();
    expect(open).toHaveBeenCalled();
  });

  it('names a persona line and the header status', () => {
    expect(personaLineOf(personaCardOf(persona({ id: 'tessa' }), [run({})], [], () => null, Date.now()))).toBe('stuck on T-0126');
    expect(personaLineOf(personaCardOf(persona({ id: 'tessa' }), [run({ stuck: false }), run({ id: 'r2', stuck: false })], [], () => null, Date.now()))).toBe('works on T-0126 +1');
    expect(bandStatusOf([run({})])).toBe('1 stuck');
    expect(bandStatusOf([run({ stuck: false })])).toBe('1 running');
    expect(bandStatusOf([])).toBeNull();
  });
});

describe('the Board tab', () => {
  it('draws the columns with cost, persona and the New idea button', () => {
    runs = [run({ persona: 'ben', stuck: false })];
    const host = document.body.appendChild(document.createElement('div'));
    mountBoard(deps(), store([persona({})]), host);
    expect([...host.querySelectorAll('.desk-col-title')].map((t) => t.textContent)).toEqual(['Inbox', 'Build']);
    const build = host.querySelector('[data-phase="build"]')!;
    expect(build.querySelector('.desk-col-cost')!.textContent).toBe('$1.20');
    expect(build.querySelector('.desk-persona-chip')!.textContent).toBe('Ben');
    expect(build.querySelector('.desk-card-kind')!.textContent).toBe('Running');
    host.querySelector<HTMLElement>('.desk-col-new')!.click();
    host.querySelector<HTMLElement>('[data-id="T-0126"]')!.click();
    expect(opened).toEqual(['new-idea', 'T-0126']);
  });
});
