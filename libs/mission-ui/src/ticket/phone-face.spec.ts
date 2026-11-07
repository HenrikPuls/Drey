import { describe, expect, it } from 'vitest';
import type { McPartCard } from '../api/dto';
import { McI18n } from '../i18n/i18n.service';
import { flowLineOf, partRowsOf, withoutPartsChapter } from './phone-face';

const i18n = new McI18n();
const t = i18n.t.bind(i18n);

const STEPS = [
  { title: 'Plan', state: 'past' as const },
  { title: 'Build', state: 'current' as const },
  { title: 'Review', state: 'future' as const },
  { title: 'Test', state: 'future' as const },
  { title: 'Skipped', state: 'future' as const, skipped: true },
];

describe('the flow row (board 10d)', () => {
  it('reads what is done, the current step with its progress, and what is to come', () => {
    expect(flowLineOf(STEPS, { done: 1, total: 4 }, false, t)).toEqual({
      past: '✓ Plan',
      current: 'Build',
      note: '(step 2 of 4)',
      rest: '· Review · Test',
    });
  });

  it('says it is your turn once the decision waits (board 10o)', () => {
    expect(flowLineOf(STEPS, null, true, t).note).toBe('(your turn)');
    expect(flowLineOf(STEPS, null, false, t).note).toBeNull();
  });
});

describe('the Parts rows (boards 10d, 10j)', () => {
  const name = (id: string): string => id.toUpperCase();
  const card = (index: number, state: McPartCard['state']): McPartCard => ({
    index,
    title: `Part ${index}`,
    reason: null,
    persona: 'ben',
    chain: [],
    flow: [],
    ticket: null,
    state,
    phase: null,
    locked: state !== 'new',
    start: '',
  });

  it('marks each state and gives only a waiting part an estimate', () => {
    const rows = partRowsOf([], [card(0, 'done'), card(1, 'running'), card(2, 'new')], name, () => 'est. $1', t);
    expect(rows.map((row) => [row.mark, row.sub, row.cost])).toEqual([
      ['✓', 'Done · BEN', null],
      ['●', 'Running · BEN', null],
      ['○', 'Waiting · BEN', 'est. $1'],
    ]);
  });

  it("falls back on the plan's own lines until the desk answers", () => {
    const rows = partRowsOf([{ title: 'From the plan', persona: null }], null, name, () => null, t);
    expect(rows.map((row) => [row.title, row.state, row.sub])).toEqual([['From the plan', 'waiting', 'Waiting']]);
  });
});

describe('withoutPartsChapter', () => {
  it('drops the Parts chapter and nothing else', () => {
    const body = '## Goal\n\nDo it.\n\n### Parts\n\n- One\n- Two\n\n### Risks\n\nNone.\n\n## Parts\n\n- Three\n';
    expect(withoutPartsChapter(body)).toBe('## Goal\n\nDo it.\n\n### Risks\n\nNone.');
  });
});
