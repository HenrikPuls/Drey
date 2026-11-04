import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { parseFlow, type McFlow, type McFlowStep } from '../api/dto';
import { FlowEditor } from './flow';
import {
  MC_FLOW_STATE,
  addablePhasesOf,
  changedIndicesOf,
  changesLabelOf,
  eyebrowOf,
  isDirty,
  marksOf,
  moveRoomOf,
  runsAfterOf,
  whoOf,
  type McFlowOp,
  type McFlowReply,
  type McFlowState,
} from './flow.model';

const step = (index: number, phase: string, extra: Partial<McFlowStep> = {}): McFlowStep => ({
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

const BASE_STEPS: McFlowStep[] = [
  step(1, 'build', { state: 'current', persona: 'ben', model: 'sonnet', locked: true }),
  step(2, 'review', { persona: 'ralf', model: 'opus' }),
  step(3, 'verify', { persona: 'tessa', model: 'sonnet' }),
  step(4, 'approve', { owner: true }),
];

const flow = (extra: Partial<McFlow> = {}): McFlow => ({
  ticket: 'T-0130',
  title: 'Voice capture for tickets',
  scope: { kind: 'ticket' },
  chain: [],
  saved: [],
  steps: BASE_STEPS,
  phases: [
    { id: 'build', title: 'Build' },
    { id: 'review', title: 'Review' },
    { id: 'verify', title: 'Verify' },
    { id: 'approve', title: 'Approve' },
    { id: 'security', title: 'Security' },
  ],
  personas: [
    { id: 'ben', kind: 'agent', title: 'Ben', color: '#6aa', model: 'sonnet' },
    { id: 'ralf', kind: 'agent', title: 'Ralf', color: '#a6a', model: 'opus' },
    { id: 'tessa', kind: 'agent', title: 'Tessa', color: '#aa6', model: 'sonnet' },
    { id: 'you', kind: 'human', title: 'You', color: '#38bdf8', model: '' },
  ],
  readOnly: null,
  reason: null,
  ...extra,
});

describe('parseFlow', () => {
  it('reads the desk answer tolerantly', () => {
    const read = parseFlow({
      ok: true,
      ticket: 'T-0130',
      title: 'x',
      scope: { kind: 'part', index: 1, title: 'Dictation' },
      chain: ['skip verify', 7],
      saved: [],
      steps: [{ index: 2, phase: 'verify', title: 'Verify', state: 'future', skipped: true, persona: 'tessa', pinned: true }, { phase: 'broken' }],
      phases: [{ id: 'build', title: 'Build' }, {}],
      personas: [{ id: 'ben', title: 'Ben', color: '#fff', model: 'sonnet' }],
      readOnly: null,
      reason: 'because',
    })!;
    expect(read.scope).toEqual({ kind: 'part', index: 1, title: 'Dictation' });
    expect(read.chain).toEqual(['skip verify']);
    expect(read.steps).toHaveLength(1);
    expect(read.steps[0]).toMatchObject({ phase: 'verify', skipped: true, pinned: true, persona: 'tessa', inserted: false, locked: false });
    expect(read.phases).toEqual([{ id: 'build', title: 'Build' }]);
    expect(read.reason).toBe('because');
    expect(parseFlow({ ok: false, error: 'no' })).toBeNull();
    expect(parseFlow(null)).toBeNull();
  });
});

describe('the helpers', () => {
  it('words the chip and the eyebrow', () => {
    expect(changesLabelOf([])).toBe('Standard flow');
    expect(changesLabelOf(['skip verify'])).toBe('Standard flow + 1 change');
    expect(changesLabelOf(['skip verify', 'notify build'])).toBe('Standard flow + 2 changes');
    expect(eyebrowOf(flow())).toBe('Flow');
    expect(eyebrowOf(flow({ scope: { kind: 'part', index: 1, title: 'x' } }))).toBe('Flow · Part 2');
  });

  it('says whether the draft differs from what is saved', () => {
    expect(isDirty(flow(), flow())).toBe(false);
    expect(isDirty(flow({ chain: ['skip verify'] }), flow())).toBe(true);
    expect(isDirty(null, flow())).toBe(false);
  });

  it('marks only the changed gates as dashed: an added gate, a moved one, a new mark', () => {
    const saved = flow();
    const added = flow({ steps: [...BASE_STEPS.slice(0, 2), step(3, 'security', { inserted: true }), step(4, 'verify', { persona: 'tessa', model: 'sonnet' }), step(5, 'approve', { owner: true })] });
    expect([...changedIndicesOf(added, saved)]).toEqual([3]);
    const moved = flow({ steps: [BASE_STEPS[0]!, BASE_STEPS[2]!, { ...BASE_STEPS[1]!, index: 3 }, { ...BASE_STEPS[1]!, index: 4 }].slice(0, 3).map((s, i) => ({ ...s, index: i + 1, moved: s.phase === 'verify' })) });
    expect([...changedIndicesOf(moved, saved)]).toEqual([2]);
    expect(changedIndicesOf(saved, null).size).toBe(0);
  });

  it('names who works a gate and lists a gate’s marks', () => {
    const f = flow();
    expect(whoOf(BASE_STEPS[1]!, f)).toBe('Ralf');
    expect(whoOf(BASE_STEPS[3]!, f)).toBe('you');
    expect(whoOf(step(9, 'x'), f)).toBe('automatic');
    expect(marksOf(step(1, 'a', { inserted: true, moved: true, skipped: true, notify: true }))).toEqual(['added', 'moved', 'struck', 'tell me']);
  });

  it('finds what a gate runs after and where it may move', () => {
    const f = flow();
    expect(runsAfterOf(f, BASE_STEPS[2]!)?.phase).toBe('review');
    expect(runsAfterOf(f, BASE_STEPS[0]!)).toBeNull();
    expect(moveRoomOf(f, BASE_STEPS[0]!)).toEqual({ earlier: false, later: false });
    expect(moveRoomOf(f, BASE_STEPS[1]!)).toEqual({ earlier: false, later: true }); // behind the running gate
    expect(moveRoomOf(f, BASE_STEPS[2]!)).toEqual({ earlier: true, later: true });
    expect(moveRoomOf(f, BASE_STEPS[3]!)).toEqual({ earlier: true, later: false });
  });

  it('offers the phases that are not added or struck yet', () => {
    const f = flow({ steps: [...BASE_STEPS, step(5, 'security', { inserted: true }), { ...step(6, 'verify'), skipped: true }] });
    expect(addablePhasesOf(f).map((p) => p.id)).toEqual(['review', 'approve']);
  });

  it('always offers the manual step, once (E10-6)', () => {
    const phases = [...flow().phases, { id: 'manual', title: 'Manual step' }];
    expect(addablePhasesOf(flow({ phases })).map((p) => p.id)).toContain('manual');
    const used = flow({ phases, steps: [...BASE_STEPS, step(5, 'manual', { inserted: true })] });
    expect(addablePhasesOf(used).map((p) => p.id)).not.toContain('manual');
  });
});

// --- the screen -------------------------------------------------------------------

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const text = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, ' ');

function mount(
  initial: McFlow | null,
  options: { saved?: McFlow; readOnly?: boolean; reason?: string; edit?: (op: McFlowOp) => Promise<McFlowReply>; draft?: McFlowState['draft']; save?: McFlowState['save'] } = {},
): { el: HTMLElement; ops: McFlowOp[]; state: McFlowState; click: (selector: string, index?: number) => void; settle: () => Promise<void> } {
  const ops: McFlowOp[] = [];
  const state: McFlowState = {
    flow: () => initial,
    saved: () => options.saved ?? initial,
    error: () => null,
    readOnly: () => options.readOnly ?? false,
    edit:
      options.edit ??
      (async (op) => {
        ops.push(op);
        return { ok: true };
      }),
    draft: options.draft ?? (async () => ({ ok: true })),
    paulReason: () => options.reason ?? null,
    undoDraft: vi.fn(),
    save: options.save ?? (async () => ({ ok: true })),
    close: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: MC_FLOW_STATE, useValue: state }] });
  const fixture = TestBed.createComponent(FlowEditor);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const click = (selector: string, index = 0): void => {
    (el.querySelectorAll(selector)[index] as HTMLElement).click();
    fixture.detectChanges();
  };
  const settle = async (): Promise<void> => {
    await flush();
    fixture.detectChanges();
  };
  return { el, ops, state, click, settle };
}

describe('FlowEditor', () => {
  it('offers only the human persona on a manual step and shows no model for the owner (E10-6)', () => {
    const steps = [...BASE_STEPS, step(5, 'manual', { title: 'Manual step', inserted: true, persona: 'you', pinned: true, owner: true })];
    const { el, click } = mount(flow({ steps }));
    click('.fe-gate', 4);
    const panel = text(el.querySelector('.fe-inspector') as HTMLElement);
    expect(panel).toContain('Manual step');
    expect(panel).toContain('You');
    expect(panel).not.toContain('Ben');
    expect(panel).not.toContain('Ralf');
    expect(panel).not.toContain('Model');
    // an agent gate still lists everyone, the human included
    click('.fe-gate', 2);
    const agent = text(el.querySelector('.fe-inspector') as HTMLElement);
    expect(agent).toContain('Ralf');
    expect(agent).toContain('You');
  });

  it('shows the gates with who works them, the running one marked, and the standard chip', () => {
    const { el } = mount(flow());
    const body = text(el);
    expect(body).toContain('Voice capture for tickets');
    expect(el.querySelectorAll('.fe-gate')).toHaveLength(4);
    expect(body).toContain('Build');
    expect(body).toContain('Ben · sonnet');
    expect(body).toContain('current');
    expect(body).toContain('you');
    expect(el.querySelector('.fe-chip')?.textContent).toContain('Standard flow');
    expect(el.querySelectorAll('.fe-plus')).toHaveLength(4);
    expect(text(el).toLowerCase()).not.toMatch(/overlap|touches|routing/);
  });

  it('titles a part’s flow and draws a changed gate dashed with the change count', () => {
    const draft = flow({
      scope: { kind: 'part', index: 1, title: 'Dictation hand-off' },
      chain: ['insert security after review'],
      steps: [...BASE_STEPS.slice(0, 2), step(3, 'security', { inserted: true }), ...BASE_STEPS.slice(2).map((s, i) => ({ ...s, index: 4 + i }))],
    });
    const { el } = mount(draft, { saved: flow({ scope: draft.scope }) });
    expect(text(el)).toContain('Flow · Part 2');
    expect(text(el)).toContain('Dictation hand-off');
    expect(el.querySelector('.fe-chip')?.textContent).toContain('Standard flow + 1 change');
    const dashed = el.querySelectorAll('.fe-gate.dashed');
    expect(dashed).toHaveLength(1);
    expect(dashed[0]!.textContent).toContain('Security');
    expect(dashed[0]!.textContent).toContain('added');
  });

  it('opens the inspector for a gate: who, model, tell me, runs after, move, add, remove', () => {
    const { el, click } = mount(flow());
    click('.fe-gate', 2);
    const panel = text(el.querySelector('.fe-inspector') as HTMLElement);
    expect(panel).toContain('Verify');
    expect(panel).toContain('Pipeline default');
    expect(panel).toContain('Ralf');
    expect(panel).toContain('sonnet');
    expect(panel).toContain('Tell me when it is done');
    expect(panel).toContain('Runs after');
    expect(panel).toContain('Review');
    expect(panel).toContain('↑ Earlier');
    expect(panel).toContain('↓ Later');
    expect(panel).toContain('Add a gate after');
    expect(panel).toContain('Remove gate');
  });

  it('turns taps into edits on the gate’s index', async () => {
    const { el, ops, click, settle } = mount(flow());
    click('.fe-gate', 2); // verify, index 3
    click('.fe-inspector .fe-chips .chip', 3); // ralf? pipeline default, ben, ralf, tessa -> index 3 = tessa
    await settle();
    click('.fe-switch');
    await settle();
    click('.fe-actions .fe-btn', 0); // earlier
    await settle();
    click('.fe-actions .fe-btn', 1); // later
    await settle();
    expect(ops).toEqual([
      { op: 'persona', step: 3, persona: 'tessa' },
      { op: 'notify', step: 3, on: true },
      { op: 'move', step: 3, dir: -1 },
      { op: 'move', step: 3, dir: 1 },
    ]);
    expect(el.querySelector('.fe-error')).toBeNull();
  });

  it('adds a gate from a connector’s picker', async () => {
    const { el, ops, click, settle } = mount(flow({ steps: [...BASE_STEPS, step(5, 'security')] }));
    click('.fe-plus', 1); // after review (index 2)
    const options = [...el.querySelectorAll('.fe-add .chip')].map((c) => c.textContent?.trim());
    expect(options).toEqual(['Review', 'Verify', 'Approve', 'Security']);
    click('.fe-add .chip', 3);
    await settle();
    expect(ops).toEqual([{ op: 'insert', phase: 'security', after: 2 }]);
  });

  it('keeps a running gate fixed and offers restore for a struck one', () => {
    const struck = flow({ steps: [...BASE_STEPS.slice(0, 2), step(3, 'verify', { skipped: true }), BASE_STEPS[3]!] });
    const { el, click } = mount(struck);
    click('.fe-gate', 0);
    expect(text(el.querySelector('.fe-inspector') as HTMLElement)).toContain('This is the current gate');
    expect((el.querySelector('.fe-switch') as HTMLButtonElement).disabled).toBe(true);
    click('.fe-gate', 2);
    expect(text(el.querySelector('.fe-inspector') as HTMLElement)).toContain('Restore gate');
  });

  it('shows a refusal inline and keeps working', async () => {
    const { el, click, settle } = mount(flow(), { edit: async () => ({ ok: false, error: 'Review is done — only gates that have not begun can change' }) });
    click('.fe-gate', 2);
    click('.fe-switch');
    await settle();
    expect(el.querySelector('.fe-error')?.textContent).toContain('only gates that have not begun can change');
  });

  it('saves only a changed draft, and asks Paul with or without words', async () => {
    const save = vi.fn(async (): Promise<McFlowReply> => ({ ok: true }));
    const draft = vi.fn(async (): Promise<McFlowReply> => ({ ok: true }));
    const clean = mount(flow(), { save, draft });
    expect((clean.el.querySelector('.fe-btn.primary') as HTMLButtonElement).disabled).toBe(true);
    const input = clean.el.querySelector('.fe-input') as HTMLInputElement;
    input.value = ' add a security pass ';
    input.dispatchEvent(new Event('input'));
    clean.click('.fe-ask .fe-btn');
    await clean.settle();
    expect(draft).toHaveBeenLastCalledWith('add a security pass');
    clean.click('.fe-ask .fe-btn');
    await clean.settle();
    expect(draft).toHaveBeenLastCalledWith(null);
  });

  it('saves a dirty draft; a read-only device can only look', async () => {
    const save = vi.fn(async (): Promise<McFlowReply> => ({ ok: true }));
    const dirty = mount(flow({ chain: ['skip verify'] }), { saved: flow(), save });
    const button = dirty.el.querySelector('.fe-btn.primary') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Save flow');
    button.click();
    await dirty.settle();
    expect(save).toHaveBeenCalledTimes(1);

    TestBed.resetTestingModule();
    const locked = mount(flow({ chain: ['skip verify'] }), { saved: flow(), readOnly: true });
    expect((locked.el.querySelector('.fe-btn.primary') as HTMLButtonElement).disabled).toBe(true);
    expect((locked.el.querySelector('.fe-plus') as HTMLButtonElement).disabled).toBe(true);
    expect((locked.el.querySelector('.fe-input') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows Paul’s reason on his draft with an undo, and resets to the standard flow', async () => {
    const { el, ops, state, click, settle } = mount(flow({ chain: ['insert security after review'] }), { reason: 'A security pass fits an auth change.' });
    expect(text(el)).toContain('Paul drafted this flow');
    expect(text(el)).toContain('A security pass fits an auth change.');
    click('.fe-paul .fe-link');
    expect(state.undoDraft).toHaveBeenCalled();
    click('.fe-buttons .fe-link');
    await settle();
    expect(ops).toEqual([{ op: 'reset' }]);
  });
});
