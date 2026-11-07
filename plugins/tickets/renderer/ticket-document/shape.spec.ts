import { describe, expect, it } from 'vitest';
import type { BoardSnapshot } from '../../shared/tickets';
import { agoWords, isPlanStatus, markGroupsOf, planHeadingEnd, shapeMarksOf, shapeTargetOf, type PlanStatusLike } from './shape';

const NOW = new Date('2026-11-04T12:00:00Z');

const snapshot = {
  vaultId: 'v1',
  pipeline: [
    { id: 'ideas', title: 'Ideas', handover: 'manual' },
    { id: 'build', title: 'Build', handover: 'agent build-default' },
    { id: 'done', title: 'Done', handover: 'manual' },
  ],
  columns: [
    { phase: { id: 'ideas' }, tickets: [{ id: 'T-0130', path: 'tickets/ideas/T-0130.md', phase: 'ideas' }] },
    { phase: { id: 'build' }, tickets: [{ id: 'T-0131', path: 'tickets/build/T-0131.md', phase: 'build' }] },
  ],
} as unknown as BoardSnapshot;

describe('shapeTargetOf', () => {
  const idle = (): boolean => false;

  it('names a ticket of an Ideas phase', () => {
    expect(shapeTargetOf(snapshot, { path: 'tickets/ideas/T-0130.md', vaultId: 'v1' }, idle)).toEqual({
      id: 'T-0130',
      path: 'tickets/ideas/T-0130.md',
      label: 'T-0130.md',
    });
  });

  it('is null for a ticket past the Ideas phase, another vault, another file or a live run', () => {
    expect(shapeTargetOf(snapshot, { path: 'tickets/build/T-0131.md', vaultId: 'v1' }, idle)).toBeNull();
    expect(shapeTargetOf(snapshot, { path: 'tickets/ideas/T-0130.md', vaultId: 'other' }, idle)).toBeNull();
    expect(shapeTargetOf(snapshot, { path: 'notes/a.md', vaultId: 'v1' }, idle)).toBeNull();
    expect(shapeTargetOf(snapshot, { path: 'tickets/ideas/T-0130.md', vaultId: 'v1' }, () => true)).toBeNull();
    expect(shapeTargetOf(null, { path: 'tickets/ideas/T-0130.md', vaultId: 'v1' }, idle)).toBeNull();
  });
});

describe('shapeTargetOf on a store document (D-23)', () => {
  const idle = (): boolean => false;

  it('names the open document, not the card stand-in path, from the checkout vault', () => {
    expect(shapeTargetOf(snapshot, { path: 'tickets/t/0000/t-130/ticket.md', vaultId: 'checkout' }, idle)).toEqual({
      id: 'T-0130',
      path: 'tickets/t/0000/t-130/ticket.md',
      label: 'T-0130.md',
    });
  });

  it('is null past the Ideas phase and for a ticket the board does not list', () => {
    expect(shapeTargetOf(snapshot, { path: 'tickets/t/0000/t-131/ticket.md', vaultId: 'checkout' }, idle)).toBeNull();
    expect(shapeTargetOf(snapshot, { path: 'tickets/t/0000/t-999/ticket.md', vaultId: 'checkout' }, idle)).toBeNull();
  });
});

describe('agoWords', () => {
  it('counts minutes, hours and days', () => {
    expect(agoWords('2026-11-04T11:59:40Z', NOW)).toBe('just now');
    expect(agoWords('2026-11-04T11:58:00Z', NOW)).toBe('2 min ago');
    expect(agoWords('2026-11-04T09:00:00Z', NOW)).toBe('3 h ago');
    expect(agoWords('2026-11-01T12:00:00Z', NOW)).toBe('3 days ago');
    expect(agoWords('nonsense', NOW)).toBe('just now');
    expect(agoWords('2026-11-04T12:30:00Z', NOW)).toBe('just now');
  });
});

describe('shapeMarksOf', () => {
  const status = (patch: Partial<PlanStatusLike>): PlanStatusLike => ({
    ok: true,
    version: 2,
    modelAt: '2026-11-04T11:58:00Z',
    edits: 0,
    summary: null,
    marks: [{ no: 3, text: '- by Paul', by: 'model' }],
    ...patch,
  });

  it("marks Paul's last edit with its age", () => {
    expect(shapeMarksOf(status({}), NOW)).toMatchObject({ paul: 'Paul edited this · 2 min ago', you: null, youDetail: null });
  });

  it('marks the owner’s edits that ride along with the next message', () => {
    const marks = shapeMarksOf(
      status({ edits: 1, summary: '1 edit · +1 −0', marks: [{ no: 1, text: 'Goal!', by: 'you' }] }),
      NOW,
    );
    expect(marks).toEqual({
      paul: null,
      you: 'You edited this · rides along with your next message',
      youDetail: '1 edit · +1 −0',
      lines: [{ no: 1, text: 'Goal!', by: 'you' }],
    });
  });

  it('shows both when both apply, and Paul without an age for a shadow without a stamp', () => {
    const both = shapeMarksOf(status({ edits: 2, summary: '2 edits', modelAt: null }), NOW);
    expect(both?.paul).toBe('Paul edited this');
    expect(both?.you).toContain('You edited this');
  });

  it('says nothing before Paul worked on the plan or when his lines no longer stand', () => {
    expect(shapeMarksOf(null, NOW)).toBeNull();
    expect(shapeMarksOf(status({ version: null, marks: [] }), NOW)).toBeNull();
    expect(shapeMarksOf(status({ marks: [] }), NOW)).toBeNull();
  });
});

describe('isPlanStatus', () => {
  it('accepts the engine’s ok answer and refuses a refusal or junk', () => {
    expect(isPlanStatus({ ok: true, version: null, edits: 0, summary: null, marks: [] })).toBe(true);
    expect(isPlanStatus({ ok: false, error: 'x' })).toBe(false);
    expect(isPlanStatus(null)).toBe(false);
    expect(isPlanStatus({ ok: true, edits: 'a', marks: [] })).toBe(false);
  });
});

describe('planHeadingEnd', () => {
  it('finds the end of the Plan heading line, skipping code fences', () => {
    const text = '---\nid: T-0130\n---\n```\n## Plan\n```\n## Plan\nGoal\n';
    expect(planHeadingEnd(text)).toBe(text.lastIndexOf('## Plan') + '## Plan'.length);
    expect(planHeadingEnd('## Description\nx\n')).toBeNull();
  });

  it('handles CRLF files', () => {
    const text = '## Description\r\nx\r\n## Plan\r\nGoal\r\n';
    expect(planHeadingEnd(text)).toBe(text.indexOf('## Plan') + '## Plan'.length);
  });
});

describe('markGroupsOf', () => {
  const text = '## Plan\n\n### Decisions\n\n- one\n- two\n- three\n\n## Log\n';
  const at = (needle: string): number => text.indexOf(needle);

  it('places a run of lines by one hand, the note under its last line', () => {
    const groups = markGroupsOf(text, {
      lines: [
        { no: 4, text: '- one', by: 'model' },
        { no: 5, text: '- two', by: 'model' },
        { no: 6, text: '- three', by: 'you' },
      ],
    });
    expect(groups).toEqual([
      { by: 'model', lines: [at('- one'), at('- two')], end: at('- two') + 5 },
      { by: 'you', lines: [at('- three')], end: at('- three') + 7 },
    ]);
  });

  it('takes blank lines into a block, one note for all of it', () => {
    const plan = '## Plan\n\n### Goal\n\nA.\n';
    const groups = markGroupsOf(plan, { lines: [{ no: 2, text: '### Goal', by: 'model' }, { no: 4, text: 'A.', by: 'model' }] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.end).toBe(plan.indexOf('A.') + 2);
  });

  it('finds a line that moved by its text and drops one that is gone', () => {
    expect(markGroupsOf(text, { lines: [{ no: 1, text: '- two', by: 'you' }] })[0]?.lines).toEqual([at('- two')]);
    expect(markGroupsOf(text, { lines: [{ no: 4, text: '- gone', by: 'you' }] })).toEqual([]);
  });

  it('has nothing to place without a Plan', () => {
    expect(markGroupsOf('## Log\n', { lines: [{ no: 1, text: 'x', by: 'you' }] })).toEqual([]);
  });
});
