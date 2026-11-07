import { describe, expect, it } from 'vitest';
import type { PersonaView } from '../../shared/remote-protocol';
import type { ChainStatus, RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import {
  budgetPctOf,
  capacityOf,
  contextPctOf,
  costLineOf,
  initialsOf,
  roleLabel,
  personaCardOf,
  slotsLineOf,
  stateWordOf,
  stuckLineOf,
  summaryOf,
  teamHeadOf,
  teamModelOf,
  usd,
} from './team-model';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

const persona = (patch: Partial<PersonaView> = {}): PersonaView => ({
  id: 'ben',
  title: 'Ben',
  role: 'Builder',
  worker: 'opencode',
  model: 'qwen3-coder',
  pool: ['qwen3-coder'],
  color: '#3366cc',
  budget: 5,
  ...patch,
});

const run = (patch: Partial<RunInfo> = {}): RunInfo =>
  ({
    id: 'r1',
    ticketId: 'T-0001',
    persona: 'ben',
    provider: 'opencode',
    state: 'running',
    startedAt: minutesAgo(4),
    lastActivity: minutesAgo(1),
    ...patch,
  }) as unknown as RunInfo;

const titles = (id: string): string | null => (id === 'T-0001' ? 'Outline: drag headings' : null);

describe('money and initials', () => {
  it('writes dollars with two decimals', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(1.2)).toBe('$1.20');
  });

  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Ben')).toBe('BE');
    expect(initialsOf('X')).toBe('X');
    expect(initialsOf('Claude Code')).toBe('CC');
    expect(initialsOf('  ')).toBe('');
  });
});

describe('role label', () => {
  it('capitalises the role', () => {
    expect(roleLabel('builder')).toBe('Builder');
    expect(roleLabel('')).toBe('');
    expect(personaCardOf(persona({ role: 'tester' }), [], [], titles, NOW).role).toBe('Tester');
  });
});

describe('cost line and budget share', () => {
  it('writes cost against the budget, or alone', () => {
    expect(costLineOf(0.42, 5)).toBe('$0.42 of $5.00 today');
    expect(costLineOf(0.42, null)).toBe('$0.42 today');
    expect(costLineOf(null, 5)).toBe('');
  });

  it('clamps the share and gives none without a budget or cost', () => {
    expect(budgetPctOf(2.5, 5)).toBe(50);
    expect(budgetPctOf(9, 5)).toBe(100);
    expect(budgetPctOf(1, null)).toBeNull();
    expect(budgetPctOf(null, 5)).toBeNull();
    expect(budgetPctOf(1, 0)).toBeNull();
  });
});

describe('stuck copy', () => {
  it('names the quiet minutes', () => {
    expect(stuckLineOf(run({ lastActivity: minutesAgo(9) }), NOW)).toBe('No progress for 9 minutes.');
    expect(stuckLineOf(run({ lastActivity: minutesAgo(1) }), NOW)).toBe('No progress for 1 minute.');
  });

  it('adds the context fill from 60 percent', () => {
    const filling = run({ lastActivity: minutesAgo(9), contextTokens: 78_000, contextWindow: 100_000 });
    expect(contextPctOf(filling)).toBe(78);
    expect(stuckLineOf(filling, NOW)).toBe('No progress for 9 minutes and the context is filling up (78%).');
    const low = run({ lastActivity: minutesAgo(9), contextTokens: 10_000, contextWindow: 100_000 });
    expect(stuckLineOf(low, NOW)).toBe('No progress for 9 minutes.');
  });

  it('reads no context fill when the provider reported none', () => {
    expect(contextPctOf(run())).toBeNull();
  });
});

describe('persona cards', () => {
  it('is idle without live runs', () => {
    const card = personaCardOf(persona(), [run({ state: 'done' })], [], titles, NOW);
    expect(card.state).toBe('idle');
    expect(card.stateWord).toBe('idle');
    expect(card.runs).toEqual([]);
  });

  it('runs: one row per live run with the ticket title and age', () => {
    const card = personaCardOf(persona(), [run(), run({ id: 'r2', ticketId: 'T-0002' })], [], titles, NOW);
    expect(card.state).toBe('running');
    expect(card.stateWord).toBe('2 running');
    expect(card.runs[0]).toMatchObject({ runId: 'r1', title: 'Outline: drag headings', age: '4 min' });
    expect(card.runs[1]!.title).toBe('');
  });

  it('only counts the persona\'s own runs', () => {
    expect(personaCardOf(persona(), [run({ persona: 'ralf' })], [], titles, NOW).state).toBe('idle');
  });

  it('weighs stuck over waiting over running, and paused over all', () => {
    const waiting = run({ waiting: { kind: 'question', since: minutesAgo(1), text: '' } } as unknown as Partial<RunInfo>);
    const stuck = run({ id: 'r3', stuck: true, lastActivity: minutesAgo(9) });
    expect(personaCardOf(persona(), [waiting], [], titles, NOW).state).toBe('waiting');
    expect(personaCardOf(persona(), [waiting, stuck], [], titles, NOW).state).toBe('stuck');
    expect(personaCardOf(persona(), [waiting, stuck], ['ben'], titles, NOW).state).toBe('paused');
    expect(personaCardOf(persona({ paused: true }), [], [], titles, NOW).state).toBe('paused');
  });

  it('flags the stuck row with its amber line', () => {
    const card = personaCardOf(persona(), [run({ stuck: true, lastActivity: minutesAgo(9) })], [], titles, NOW);
    expect(card.runs[0]).toMatchObject({ stuck: true, stuckLine: 'No progress for 9 minutes.' });
  });

  it('carries the cost against the budget and flags an overrun', () => {
    const card = personaCardOf(persona({ dailyCost: 6 }), [], [], titles, NOW);
    expect(card).toMatchObject({ costLine: '$6.00 of $5.00 today', budgetPct: 100, overBudget: true });
    const none = personaCardOf(persona({ budget: null }), [], [], titles, NOW);
    expect(none).toMatchObject({ costLine: '', budgetPct: null, overBudget: false });
  });

  it('falls back to a neutral colour for junk', () => {
    expect(personaCardOf(persona({ color: 'red' }), [], [], titles, NOW).color).toBe('#888888');
  });
});

describe('state words', () => {
  it('counts only for several running runs', () => {
    expect(stateWordOf('running', 1)).toBe('running');
    expect(stateWordOf('running', 3)).toBe('3 running');
    expect(stateWordOf('paused', 2)).toBe('paused');
  });
});

describe('capacity chips', () => {
  const chain = { poolSize: { opencode: 2, 'claude-code': 3 } } as unknown as ChainStatus;

  it('counts live runs per provider against the pool size', () => {
    const runs = [run(), run({ id: 'r2' }), run({ id: 'r3', provider: 'claude-code' }), run({ id: 'r4', state: 'done' })];
    expect(capacityOf(chain, runs)).toEqual([
      { provider: 'opencode', label: 'Local', running: 2, size: 2 },
      { provider: 'claude-code', label: 'Claude Code', running: 1, size: 3 },
    ]);
  });

  it('shows none without pool sizes', () => {
    expect(capacityOf(null, [run()])).toEqual([]);
    expect(capacityOf({} as unknown as ChainStatus, [run()])).toEqual([]);
  });
});

describe('the team model', () => {
  const personas = [
    persona({ id: 'paul', title: 'Paul', role: 'Planner', dailyCost: 0.61, budget: 3 }),
    persona({ dailyCost: 2.67, budget: 5 }),
    persona({ id: 'tessa', title: 'Tessa', role: 'Tester', dailyCost: 0.36, budget: 7 }),
  ];

  it('sums the day, summarises the states and halts', () => {
    const chain = { master: 'halted', poolSize: { opencode: 2, 'claude-code': 3 } } as unknown as ChainStatus;
    const runs = [run(), run({ id: 'r2', persona: 'tessa', stuck: true, lastActivity: minutesAgo(9) })];
    const model = teamModelOf(personas, runs, chain, titles, NOW);
    expect(model.summary).toBe('1 running · 1 stuck');
    expect(model.todayCost).toBeCloseTo(3.64);
    expect(model.todayBudget).toBe(15);
    expect(model.halted).toBe(true);
    expect(model.slots).toBe(5);
    expect(model.liveRuns).toBe(2);
    expect(slotsLineOf(model)).toBe('2 of 5 slots busy');
    expect(teamHeadOf(model)).toBe('3 personas · 1 running · 1 stuck');
  });

  it('knows no cost, budget or slots when nothing reports them', () => {
    const model = teamModelOf([persona({ budget: null })], [], null, titles, NOW);
    expect(model).toMatchObject({ todayCost: null, todayBudget: null, slots: 0, halted: false, summary: 'All idle' });
    expect(slotsLineOf(model)).toBe('');
    expect(teamHeadOf(model)).toBe('1 persona');
  });

  it('reads the chain pause list', () => {
    const chain = { master: 'run', pausedPersonas: ['ben'] } as unknown as ChainStatus;
    expect(teamModelOf([persona()], [run()], chain, titles, NOW).personas[0]!.state).toBe('paused');
  });

  it('summarises only running, waiting and stuck', () => {
    expect(summaryOf([])).toBe('All idle');
  });
});
