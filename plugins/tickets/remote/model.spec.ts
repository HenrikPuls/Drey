import { describe, expect, it } from 'vitest';
import type { RunInfo } from '../main/fleet/protocol';
import type { BoardColumn, BoardSnapshot, PipelinePhase, TicketCard } from '../shared/tickets';
import {
  blocksOf,
  claimActionOf,
  commitLineOf,
  liveRunOf,
  nextColumnOf,
  placeOf,
  primaryActionOf,
  sectionsOf,
  swipeCommits,
  answersOf,
  dropActionOf,
  dropIndexOf,
  refineKeyOf,
  sectionTextOf,
  runsForList,
  runStateLabel,
  tokensLabel,
} from './model';

/** req-66: the phone client's view logic. */

const card = (id: string, patch: Record<string, unknown> = {}): TicketCard =>
  ({ id, meta: { title: id, run: null, claimedBy: null, ...patch } }) as unknown as TicketCard;

const column = (id: string, handover: string, tickets: TicketCard[] = [], unknown = false): BoardColumn => ({
  phase: { id, title: id[0]!.toUpperCase() + id.slice(1), handover } as PipelinePhase,
  tickets,
  unknown,
});

const board = (columns: BoardColumn[], checkpoints: string[] = []): BoardSnapshot =>
  ({ columns, checkpoints }) as unknown as BoardSnapshot;

const run = (patch: Partial<RunInfo>): RunInfo => ({ ticketId: 'T-0001', state: 'running', startedAt: '2026-10-30T10:00:00Z', ...patch }) as RunInfo;

const snap = board(
  [
    column('plan', 'agent plan-default', [card('T-0001')]),
    column('plan-review', 'manual', [card('T-0002')]),
    column('build', 'agent build-default', [card('T-0003')]),
    column('done', 'none', [card('T-0004')]),
    column('qa-old', 'manual', [card('T-0005')], true),
  ],
  ['plan-review'],
);

describe('placement', () => {
  it('finds a ticket and the next real column', () => {
    expect(placeOf(snap, 'T-0003')?.column.phase.id).toBe('build');
    expect(placeOf(snap, 'T-9999')).toBeNull();
    expect(nextColumnOf(snap, 'build')?.phase.id).toBe('done');
    expect(nextColumnOf(snap, 'done')).toBeNull();
  });
});

describe('primaryActionOf', () => {
  it('approves at a checkpoint, runs an agent column, has none in the last column', () => {
    expect(primaryActionOf(snap, 'plan-review', card('T-0002'), [])).toEqual({
      kind: 'approve',
      to: 'build',
      label: 'Approve → Build',
    });
    expect(primaryActionOf(snap, 'build', card('T-0003'), [])).toEqual({ kind: 'run', label: 'Run agent' });
    expect(primaryActionOf(snap, 'done', card('T-0004'), [])).toBeNull();
  });

  it('moves on from a manual column and is busy while a run lives', () => {
    const manual = board([column('inbox', 'manual', [card('T-0009')]), column('plan', 'agent')]);
    expect(primaryActionOf(manual, 'inbox', card('T-0009'), [])).toMatchObject({ kind: 'move', to: 'plan' });
    expect(primaryActionOf(snap, 'build', card('T-0003'), [run({ ticketId: 'T-0003' })])).toMatchObject({ kind: 'busy' });
    expect(primaryActionOf(snap, 'build', card('T-0003', { run: { pid: 1 } }), [])).toMatchObject({ kind: 'busy' });
  });
});

describe('runs and claims', () => {
  it('picks the newest live run only', () => {
    const runs = [
      run({ id: 'a', state: 'done', startedAt: '2026-10-30T12:00:00Z' }),
      run({ id: 'b', startedAt: '2026-10-30T09:00:00Z' }),
      run({ id: 'c', startedAt: '2026-10-30T11:00:00Z' }),
    ];
    expect(liveRunOf('T-0001', runs)?.id).toBe('c');
    expect(liveRunOf('T-0002', runs)).toBeNull();
  });

  it('releases your own claim, takes over any other', () => {
    expect(claimActionOf(card('T-1', { claimedBy: 'owner@ipad' }), 'owner@ipad')).toBe('release');
    expect(claimActionOf(card('T-1', { claimedBy: 'owner@desk' }), 'owner@ipad')).toBe('takeover');
    expect(claimActionOf(card('T-1'), 'owner@ipad')).toBe('takeover');
    expect(commitLineOf('T-1', 'build', 'review')).toBe('tickets: T-1 build -> review');
  });
});

describe('the ticket file as blocks', () => {
  const text = [
    '---',
    'id: T-0053',
    'title: x',
    '---',
    '',
    '## Description',
    '',
    'The chip is',
    'display-only.',
    '',
    '## Plan',
    '',
    '### Acceptance criteria',
    '',
    '- [x] Chip opens the menu',
    '- [ ] One commit per move',
    '1. numbered',
    '```',
    'npm test',
    '```',
  ].join('\n');

  it('drops the frontmatter and splits at headings', () => {
    expect(sectionsOf(text).map((s) => [s.level, s.title])).toEqual([
      [2, 'Description'],
      [2, 'Plan'],
      [3, 'Acceptance criteria'],
    ]);
  });

  it('reads paragraphs, checkboxes, list items and code', () => {
    const sections = sectionsOf(text);
    expect(blocksOf(sections[0]!.lines)).toEqual([{ kind: 'p', text: 'The chip is display-only.' }]);
    expect(blocksOf(sections[2]!.lines)).toEqual([
      { kind: 'li', text: 'Chip opens the menu', checked: true },
      { kind: 'li', text: 'One commit per move', checked: false },
      { kind: 'li', text: 'numbered', checked: null },
      { kind: 'code', text: 'npm test' },
    ]);
  });

  it('reads a pipe table right after a paragraph line, closing the paragraph', () => {
    expect(
      blocksOf(['Ledger:', '', '| Phase | Gate |', '|---|---|', '| plan | lint |', '| build | e2e |']),
    ).toEqual([
      { kind: 'p', text: 'Ledger:' },
      { kind: 'table', rows: [['Phase', 'Gate'], ['plan', 'lint'], ['build', 'e2e']] },
    ]);
    expect(blocksOf(['| a | b |', '|---|---|', '| 1 | `x` |'])).toEqual([
      { kind: 'table', rows: [['a', 'b'], ['1', '`x`']] },
    ]);
  });

  it('reads rules and in-section headings as their own blocks', () => {
    expect(
      blocksOf(['Before', '---', '#### Details', 'After **bold**', '##### Deeper']),
    ).toEqual([
      { kind: 'p', text: 'Before' },
      { kind: 'hr' },
      { kind: 'h', level: 4, text: 'Details' },
      { kind: 'p', text: 'After **bold**' },
      { kind: 'h', level: 5, text: 'Deeper' },
    ]);
  });

  it('keeps a lone table-rule line and table-less pipe text as a paragraph', () => {
    expect(blocksOf(['|---|'])).toEqual([{ kind: 'p', text: '|---|' }]);
    expect(blocksOf(['| not a table'])).toEqual([{ kind: 'p', text: '| not a table' }]);
  });
});

describe('swipeCommits', () => {
  it('needs a clear sideways pull past the threshold', () => {
    expect(swipeCommits(-120, 10, 300)).toBe(true);
    expect(swipeCommits(-60, 0, 300)).toBe(false);
    expect(swipeCommits(-120, 100, 300)).toBe(false);
    expect(swipeCommits(120, 0, 300)).toBe(false);
  });
});

describe('runs for the phone', () => {
  it('lists live runs first, then recent settled ones, each run once', () => {
    const list = runsForList([
      run({ id: 'a', state: 'done', startedAt: '2026-10-30T12:00:00Z' }),
      run({ id: 'b', startedAt: '2026-10-30T09:00:00Z' }),
      run({ id: 'b', startedAt: '2026-10-30T09:00:00Z' }),
      run({ id: 'c', state: 'failed', startedAt: '2026-10-30T08:00:00Z' }),
    ]);
    expect(list.live.map((r) => r.id)).toEqual(['b']);
    expect(list.recent.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('names what a run waits for before its raw state', () => {
    expect(runStateLabel(run({ waiting: { kind: 'question', text: '?', since: '' } }))).toBe('asks you');
    expect(runStateLabel(run({ waiting: { kind: 'permission', text: 'bash', since: '' } }))).toBe('needs permission');
    expect(runStateLabel(run({ turn: 'idle' }))).toBe('standing');
    expect(runStateLabel(run({ state: 'done', gateResult: 'red', gateFailure: null }))).toBe('gate red');
    expect(tokensLabel(48_213)).toBe('48k');
    expect(tokensLabel(1_250_000)).toBe('1.3M');
    expect(tokensLabel(undefined)).toBe('');
  });
});

describe('answersOf', () => {
  const qs = [
    { key: 'q0', multiple: false },
    { key: 'q1', multiple: true },
  ];
  it('takes own words over choices and waits until every field is answered', () => {
    expect(answersOf(qs, new Map([['q0', ['Fold']]]), new Map())).toBeNull();
    expect(answersOf(qs, new Map([['q0', ['Fold']], ['q1', ['a', 'b']]]), new Map())).toEqual({ q0: 'Fold', q1: ['a', 'b'] });
    expect(answersOf(qs, new Map([['q0', ['Fold']]]), new Map([['q1', ' only docs ']]))).toEqual({ q0: 'Fold', q1: 'only docs' });
  });
});

describe('refining', () => {
  const file = '---\nid: T-1\n---\n\n## Description\n\nWhy.\n\n## Plan\n\nHow.\n\n### Acceptance criteria\n\n- [ ] `npm test`\n\n## Log\n';
  it('reads one section as the editor starts from it', () => {
    expect(sectionTextOf(file, 'plan')).toBe('How.');
    expect(sectionTextOf(file, 'acceptance')).toBe('- [ ] `npm test`');
    expect(sectionTextOf('---\nid: T-1\n---\n', 'description')).toBe('');
    expect(refineKeyOf('Acceptance criteria')).toBe('acceptance');
    expect(refineKeyOf('Log')).toBeNull();
  });
});

describe('kanban drops', () => {
  it('counts the other cards above the pointer', () => {
    expect(dropIndexOf([50, 150, 250], 10)).toBe(0);
    expect(dropIndexOf([50, 150, 250], 200)).toBe(2);
    expect(dropIndexOf([], 999)).toBe(0);
  });

  it('moves across columns, reorders within one, and skips a drop in place', () => {
    expect(dropActionOf('build', 1, 'review', 0)).toEqual({ kind: 'move', from: 'build', to: 'review', index: 0 });
    expect(dropActionOf('build', 1, 'build', 0)).toEqual({ kind: 'reorder', phase: 'build', index: 0 });
    expect(dropActionOf('build', 1, 'build', 1)).toBeNull();
  });
});
