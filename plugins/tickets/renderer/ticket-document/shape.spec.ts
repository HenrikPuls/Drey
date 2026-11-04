import { describe, expect, it } from 'vitest';
import type { BoardSnapshot } from '../../shared/tickets';
import { agoWords, isPlanStatus, planHeadingEnd, shapeMarksOf, shapeTargetOf, type PlanStatusLike } from './shape';

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
    expect(shapeMarksOf(status({}), NOW)).toEqual({ paul: 'Paul edited this · 2 min ago', you: null, youDetail: null });
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
