import { describe, expect, it } from 'vitest';
import type { FlowStepView } from '../../../../packages/tickets-engine/src/contracts/flow';
import {
  addablePhasesOf,
  changedIndicesOf,
  changesLabelOf,
  eyebrowOf,
  flowKeyOf,
  flowTargetOfKey,
  flowTitleOf,
  isDirty,
  marksOf,
  moveRoomOf,
  personasFor,
  runsAfterOf,
  whoOf,
  type FlowDraft,
} from './flow-model';

const step = (index: number, phase: string, extra: Partial<FlowStepView> = {}): FlowStepView => ({
  index,
  phase,
  title: phase.charAt(0).toUpperCase() + phase.slice(1),
  state: 'future',
  inserted: false,
  skipped: false,
  moved: false,
  notify: false,
  persona: null,
  pinned: false,
  model: null,
  owner: false,
  locked: false,
  ...extra,
});

const flow = (extra: Partial<FlowDraft> = {}): FlowDraft => ({
  ok: true,
  ticket: 'T-0130',
  title: 'Voice capture',
  scope: { kind: 'ticket' },
  chain: [],
  saved: [],
  steps: [
    step(1, 'build', { state: 'current', persona: 'ben', model: 'sonnet', locked: true }),
    step(2, 'review', { persona: 'ralf', model: 'opus' }),
    step(3, 'verify', { persona: 'tessa' }),
    step(4, 'approve', { owner: true }),
  ],
  phases: [
    { id: 'build', title: 'Build' },
    { id: 'review', title: 'Review' },
    { id: 'verify', title: 'Verify' },
    { id: 'approve', title: 'Approve' },
    { id: 'security', title: 'Security' },
    { id: 'manual', title: 'Manual step' },
  ],
  personas: [
    { id: 'ben', kind: 'agent', title: 'Ben', color: '#6aa', model: 'sonnet' },
    { id: 'ralf', kind: 'agent', title: 'Ralf', color: '#a6a', model: 'opus' },
    { id: 'you', kind: 'human', title: 'You', color: '#aaa', model: '' },
  ],
  readOnly: null,
  ...extra,
});

describe('flow model', () => {
  it('words the chip and the eyebrow', () => {
    expect(changesLabelOf([])).toBe('Standard flow');
    expect(changesLabelOf(['insert security after review'])).toBe('Standard flow + 1 change');
    expect(changesLabelOf(['a', 'b'])).toBe('Standard flow + 2 changes');
    expect(eyebrowOf(flow())).toBe('Flow');
    expect(eyebrowOf(flow({ scope: { kind: 'part', index: 1, title: 'Backend' } }))).toBe('Flow · Part 2');
  });

  it('is dirty only when the chain differs from the saved one', () => {
    expect(isDirty(flow(), flow())).toBe(false);
    expect(isDirty(flow({ chain: ['x'] }), flow())).toBe(true);
    expect(isDirty(null, flow())).toBe(false);
  });

  it('marks the gates the draft changed against the saved flow', () => {
    const draft = flow({ steps: [...flow().steps, step(5, 'security', { inserted: true })] });
    expect([...changedIndicesOf(draft, flow())]).toEqual([5]);
    expect(changedIndicesOf(draft, null).size).toBe(0);
    const pinned = flow({ steps: flow().steps.map((s) => (s.index === 3 ? { ...s, pinned: true, persona: 'ralf' } : s)) });
    expect([...changedIndicesOf(pinned, flow())]).toEqual([3]);
  });

  it('names who works a gate', () => {
    const f = flow();
    expect(whoOf(f.steps[0]!, f)).toBe('Ben');
    expect(whoOf(f.steps[3]!, f)).toBe('You');
    expect(whoOf(step(9, 'x'), f)).toBe('Automatic');
  });

  it('lists the marks of a gate', () => {
    expect(marksOf(step(1, 'x', { inserted: true, notify: true }))).toEqual(['Added', 'Tell me']);
    expect(marksOf(step(1, 'x', { skipped: true, moved: true }))).toEqual(['Moved', 'Struck']);
  });

  it('finds the gate before and the room to move', () => {
    const f = flow();
    expect(runsAfterOf(f, f.steps[0]!)).toBeNull();
    expect(runsAfterOf(f, f.steps[2]!)?.phase).toBe('review');
    expect(moveRoomOf(f, f.steps[0]!)).toEqual({ earlier: false, later: false });
    expect(moveRoomOf(f, f.steps[1]!)).toEqual({ earlier: false, later: true });
    expect(moveRoomOf(f, f.steps[2]!)).toEqual({ earlier: true, later: true });
    expect(moveRoomOf(f, f.steps[3]!)).toEqual({ earlier: true, later: false });
  });

  it('offers the phases that can still be added, the manual step always', () => {
    const f = flow();
    expect(addablePhasesOf(f).map((p) => p.id)).toEqual(['review', 'verify', 'approve', 'manual']);
    const added = flow({ steps: [...f.steps, step(5, 'manual', { inserted: true })] });
    expect(addablePhasesOf(added).map((p) => p.id)).not.toContain('manual');
  });

  it('gives a manual step only human personas', () => {
    const f = flow();
    expect(personasFor(f, step(5, 'manual', { inserted: true })).map((p) => p.id)).toEqual(['you']);
    expect(personasFor(f, f.steps[1]!).map((p) => p.id)).toEqual(['ben', 'ralf', 'you']);
  });

  it('round-trips the tab key', () => {
    expect(flowKeyOf({ ticketId: 'T-0130', part: null })).toBe('flow://T-0130');
    expect(flowKeyOf({ ticketId: 'T-0130', part: 2 })).toBe('flow://T-0130/2');
    expect(flowTargetOfKey('flow://T-0130/2')).toEqual({ ticketId: 'T-0130', part: 2 });
    expect(flowTargetOfKey('flow://T-0130')).toEqual({ ticketId: 'T-0130', part: null });
    expect(flowTargetOfKey('review://T-0130')).toBeNull();
    expect(flowTitleOf({ ticketId: 'T-0130', part: 0 })).toBe('Flow · T-0130 · Part 1');
  });
});
