import { describe, expect, it } from 'vitest';
import { changedLinesOf, diffLines, editsSummary, planDelta, planDeltaForModel, planSectionOf } from './plan-delta';

describe('planSectionOf', () => {
  it('returns the Plan body without heading, edges trimmed', () => {
    const text = '---\nid: T-1\n---\n\n## Description\n\nx\n\n## Plan\n\nGoal\n\n- a\n\n## Log\n\n- one\n';
    expect(planSectionOf(text)).toBe('Goal\n\n- a');
  });

  it('is empty without a Plan, reads CRLF and a Plan at the end', () => {
    expect(planSectionOf('## Description\n\nx\n')).toBe('');
    expect(planSectionOf('## Plan\r\n\r\nGoal\r\n')).toBe('Goal');
  });
});

describe('diffLines', () => {
  it('numbers kept, added and removed lines on both sides', () => {
    const ops = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(ops.map((o) => `${o.kind}:${o.text}:${o.oldNo ?? '-'}:${o.newNo ?? '-'}`)).toEqual([
      'same:a:1:1',
      'del:b:2:-',
      'add:B:-:2',
      'same:c:3:3',
      'add:d:-:4',
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'x').map((o) => o.kind)).toEqual(['add']);
    expect(diffLines('x', '').map((o) => o.kind)).toEqual(['del']);
    expect(diffLines('', '')).toEqual([]);
  });
});

describe('planDelta', () => {
  it('is null for identical plans', () => {
    expect(planDelta('a\nb', 'a\nb')).toBeNull();
  });

  it('counts contiguous groups, lists the rewritten lines of the current plan and renders the diff', () => {
    const delta = planDelta('Goal\n1. One\n2. Two\n3. Three', 'Goal\n1. One\n2. Second\n3. Three\n4. Four')!;
    expect(delta.edits).toBe(2);
    expect(delta.added).toBe(2);
    expect(delta.removed).toBe(1);
    expect(delta.lines).toEqual([3, 5]);
    expect(delta.summary).toBe('2 edits · +2 −1');
    expect(delta.diff).toBe('@@ line 3\n- 2. Two\n+ 2. Second\n@@ line 5\n+ 4. Four');
  });

  it('places a pure deletion at the line that follows it', () => {
    const delta = planDelta('a\nb\nc', 'a\nc')!;
    expect(delta.edits).toBe(1);
    expect(delta.lines).toEqual([]);
    expect(delta.diff).toBe('@@ line 2\n- b');
    expect(delta.summary).toBe('1 edit · +0 −1');
  });

  it('wraps for the model and keeps the model’s own changes out of it', () => {
    const delta = planDelta('a', 'a\nb')!;
    expect(planDeltaForModel(delta)).toContain('The owner edited the plan since your last turn (1 edit · +1 −0)');
    expect(planDeltaForModel(delta)).toContain('+ b');
  });

  it('marks the lines the model changed in its own turn', () => {
    expect(changedLinesOf('Goal\n- a', 'Goal\n- a\n- b')).toEqual([3]);
    expect(changedLinesOf('x', 'x')).toEqual([]);
    expect(editsSummary(1, 2, 3)).toBe('1 edit · +2 −3');
  });
});
