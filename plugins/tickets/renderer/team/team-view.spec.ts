// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonaView } from '../../shared/remote-protocol';
import type { ChainStatus, RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import type { DeskDeps } from '../desk-deps';
import { mountBoard } from '../board/board-view';
import { bandHeaderStatusOf, bandShownFor, bandStatusOf, mountCapacity, personaLineOf } from './capacity-view';
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
    { phase: { id: 'inbox', title: 'Inbox', persona: null, handover: 'manual' }, unknown: false, tickets: [ticketCard('T-0133', 'inbox')] },
    { phase: { id: 'build', title: 'Build', persona: 'ben', handover: 'agent build-default' }, unknown: false, tickets: [ticketCard('T-0126', 'build')] },
  ],
  checkpoints: [],
  recentDone: [],
} as unknown as BoardSnapshot;

let activePath: string | null = 'board://all';

function deps(): DeskDeps {
  return {
    api: {
      ui: { icon: () => document.createElement('i') },
      documents: { active: () => ({ path: activePath }), onChange: () => () => undefined },
    },
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

describe('the Crew tab', () => {
  const personas = [persona({}), persona({ id: 'tessa', title: 'Tessa', role: 'Tester', dailyCost: 0.36, budget: null })];

  it('shows the head, the budget and a card per persona with its stuck run', () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    expect(host.querySelector('.desk-head-sub')!.textContent).toBe('2 personas · 1 stuck');
    expect(host.querySelector('.desk-budget')!.textContent).toBe('Budget$3.03 of $5 today');
    const tessa = host.querySelector('[data-persona="tessa"]')!;
    expect(tessa.querySelector('.desk-persona-state')!.textContent).toBe('stuck');
    expect(tessa.querySelector('.desk-persona-headline')!.textContent).toBe('No output for 9 min on T-0126');
    expect(tessa.querySelector('.desk-persona-role')!.textContent).toBe('Tester · $0.36 today');
    expect([...tessa.querySelectorAll('.desk-persona-controls button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Nudge the worker', 'Hand to Claude Code', 'Stop']);
    expect(host.querySelector('[data-persona="ben"] .desk-persona-role')!.textContent).toBe('Builder · $2.67 today');
  });

  it('wires Nudge and Hand to Claude Code to the fleet; Stop asks first', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    const [nudge, handoff, stop] = [...host.querySelectorAll<HTMLButtonElement>('.desk-persona-controls button')];
    nudge!.click();
    handoff!.click();
    await Promise.resolve();
    expect(invoked.map(([method]) => method)).toEqual(['fleetSend', 'handoffRun']);
    expect(invoked[1]![1]).toEqual({ runId: 'r1' });
    stop!.click();
    await nextFrame();
    expect(invoked.map(([method]) => method)).toEqual(['fleetSend', 'handoffRun']);
    const ask = host.querySelector('.desk-confirm')!;
    expect(ask.textContent).toContain('Stop Tessa? The branch stays.');
    [...ask.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Stop')!.click();
    await Promise.resolve();
    expect(invoked.map(([method]) => method)).toEqual(['fleetSend', 'handoffRun', 'fleetStop']);
  });

  it('offers no hand-off for a run already on Claude Code', () => {
    runs = [run({ provider: 'claude-code' })];
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    expect([...host.querySelectorAll('.desk-persona-controls button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Nudge the worker', 'Stop']);
  });

  it('Pause all halts the chain, then reads Resume all', () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    host.querySelector<HTMLButtonElement>('.desk-head button[aria-label="Pause all after this step"]')!.click();
    expect(invoked).toEqual([['chainMaster', { mode: 'halted' }]]);
    chain = { master: 'halted' } as unknown as ChainStatus;
    const host2 = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host2);
    expect(host2.querySelector('.desk-head button[aria-label="Resume all"]')).not.toBeNull();
  });

  it('arms Stop all on the first press and aborts on the second', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    const stopAll = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('.desk-head button[aria-label="Stop all"]')!;
    stopAll().click();
    expect(invoked).toEqual([]);
    await nextFrame();
    expect(stopAll().classList.contains('desk-btn-armed')).toBe(true);
    stopAll().click();
    expect(invoked).toEqual([['chainAbort', {}]]);
  });

  it('selects the first persona, lists Setup, Memory and 1:1, and asks the thread on 1:1', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store(personas), host);
    expect(host.querySelector('.desk-detail .desk-persona-title')!.textContent).toBe('Ben');
    expect([...host.querySelectorAll('.desk-tab')].map((t) => t.textContent)).toEqual(['Setup', 'Memory', '1:1']);
    expect(host.querySelector('.desk-tab-on')!.textContent).toBe('Setup');
    expect(host.querySelector('.desk-pool-model')!.textContent).toBe('qwen3-coder');
    [...host.querySelectorAll<HTMLElement>('.desk-tab')].find((t) => t.textContent === '1:1')!.click();
    await nextFrame();
    expect(invoked).toContainEqual(['personaThread', { persona: 'ben' }]);
    host.querySelector<HTMLElement>('[data-persona="tessa"]')!.click();
    await nextFrame();
    expect(host.querySelector('.desk-detail .desk-persona-title')!.textContent).toBe('Tessa');
  });

  it('leaves the owner out of the cards', () => {
    const host = document.body.appendChild(document.createElement('div'));
    mountTeam(deps(), store([...personas, persona({ id: 'you', title: 'You', kind: 'human' })]), host);
    expect(host.querySelector('[data-persona="you"]')).toBeNull();
    expect(host.querySelector('.desk-head-sub')!.textContent).toBe('2 personas · 1 stuck');
  });
});

describe('the Capacity band', () => {
  it('draws one button per persona with what it does, and the day against the budget', () => {
    const host = document.body.appendChild(document.createElement('div'));
    const personas = [persona({}), persona({ id: 'tessa', title: 'Tessa', role: 'Tester' })];
    const open = vi.fn();
    mountCapacity(deps(), store(personas), host, open);
    expect([...host.querySelectorAll('.desk-cap-person .desk-cap-line')].map((p) => p.textContent)).toEqual(['idle', 'stuck on T-0126']);
    expect(host.querySelector('.desk-cap-today')!.textContent).toBe('$5.34 of $10 today');
    expect(host.querySelector('.desk-cap-stuckdot')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.desk-cap-crew')!.click();
    expect(open).toHaveBeenCalled();
  });

  it('shows the band only while the Board tab is active (7e)', () => {
    expect(bandShownFor('board://all')).toBe(true);
    expect(bandShownFor('team://all')).toBe(false);
    expect(bandShownFor('notes/a.md')).toBe(false);
    expect(bandShownFor(null)).toBe(false);
    const host = document.body.appendChild(document.createElement('div'));
    activePath = 'notes/a.md';
    mountCapacity(deps(), store([persona({})]), host, vi.fn());
    expect(host.querySelector<HTMLElement>('.desk-capacity')!.hidden).toBe(true);
    activePath = 'board://all';
  });

  it('names a persona line and the header status', () => {
    expect(personaLineOf(personaCardOf(persona({ id: 'tessa' }), [run({})], [], () => null, Date.now()))).toBe('stuck on T-0126');
    expect(personaLineOf(personaCardOf(persona({ id: 'tessa' }), [run({ stuck: false }), run({ id: 'r2', stuck: false })], [], () => null, Date.now()))).toBe('works on T-0126 +1');
    expect(personaLineOf(personaCardOf(persona({ id: 'tessa' }), [run({ stuck: false, waiting: { kind: 'question', text: '?', since: '' } as never })], [], () => null, Date.now()))).toBe('T-0126 waits for you');
    expect(bandStatusOf([run({})])).toBe('1 stuck');
    expect(bandStatusOf([run({ stuck: false })])).toBe('1 running');
    expect(bandStatusOf([])).toBeNull();
    expect(bandHeaderStatusOf([run({})], chain)).toBe('1 of 5 slots busy');
    expect(bandHeaderStatusOf([run({})], null)).toBe('1 stuck');
  });
});

describe('the Board tab', () => {
  it('draws the columns with cost and persona, the New idea button in the head and Done this week last', () => {
    runs = [run({ persona: 'ben', stuck: false })];
    const host = document.body.appendChild(document.createElement('div'));
    mountBoard(deps(), store([persona({})]), host);
    expect([...host.querySelectorAll('.desk-col-title')].map((t) => t.textContent)).toEqual(['Inbox', 'Done this week']); // the last phase is the Done column
    const build = host.querySelector('[data-phase="done-this-week"]')!;
    expect(build.querySelector('.desk-col-cost')!.textContent).toBe('$1.20');
    expect(build.querySelector('.desk-card-who')!.textContent).toBe('Ben');
    expect(build.querySelector('.desk-card-kind')?.textContent).toBe('Accept');
    expect(host.querySelector('[data-phase="inbox"] .desk-card-who')!.textContent).toBe('unassigned');
    host.querySelector<HTMLElement>('.desk-head .desk-btn-primary')!.click();
    host.querySelector<HTMLElement>('[data-id="T-0126"]')!.click();
    expect(opened).toEqual(['new-idea', 'T-0126']);
  });
});
