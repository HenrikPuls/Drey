import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { parsePlanApproval, type McEstimate, type McPartCard, type McPlanApproval } from '../api/dto';
import { PlanApprove } from './approve';
import {
  MC_APPROVE_STATE,
  builderOf,
  dollarsOf,
  estimateLineOf,
  flowNoteOf,
  flowSegmentsOf,
  gateLineOf,
  moveRoomOf,
  partBadgeOf,
  proposalOf,
  totalLineOf,
  type McApproveReply,
  type McApproveState,
  type McPartsEdit,
} from './approve.model';

const card = (index: number, extra: Partial<McPartCard> = {}): McPartCard => ({
  index,
  title: `Part title ${index + 1}`,
  reason: null,
  persona: null,
  chain: [],
  flow: [
    { phase: 'build', title: 'Build', persona: 'ben', inserted: false, skipped: false, notify: false },
    { phase: 'commit', title: 'Commit', persona: null, inserted: false, skipped: false, notify: false },
  ],
  ticket: null,
  state: 'new',
  phase: null,
  locked: false,
  start: index === 0 ? 'Runs now' : `After part ${index}`,
  ...extra,
});

const approval = (parts: readonly McPartCard[]): McPlanApproval => ({
  ticket: 'T-0130',
  title: 'Voice capture for tickets',
  parts,
  gate: 'build',
  defaultPersona: 'ben',
  personas: [
    { id: 'paul', title: 'Paul', role: 'planner', color: '#a78bfa', model: 'opus' },
    { id: 'ben', title: 'Ben', role: 'builder', color: '#f0a58a', model: 'sonnet' },
    { id: 'ralf', title: 'Ralf', role: 'reviewer', color: '#8ecbef', model: 'opus' },
  ],
  warnings: [],
});

const estimate = (cost: number, runs = 6, minutes: number | null = 9): McEstimate => ({
  gate: 'build',
  persona: 'ben',
  model: 'sonnet',
  runs,
  cost,
  minutes,
  tokens: null,
});

describe('reading the parts answer', () => {
  it('reads cards, flows and personas tolerantly', () => {
    const read = parsePlanApproval({
      ok: true,
      ticket: 'T-0130',
      title: 'Voice capture',
      gate: 'build',
      defaultPersona: 'ben',
      warnings: ['x'],
      personas: [{ id: 'ben', title: 'Ben', role: 'builder', color: '#fff', model: 'sonnet' }, { nope: 1 }],
      parts: [
        {
          index: 0,
          title: 'Capture',
          persona: 'ben',
          state: 'running',
          ticket: 'T-0131',
          locked: true,
          start: 'Released as T-0131',
          flow: [{ phase: 'build', title: 'Build', persona: 'ben', inserted: false, skipped: false, notify: true }, 7],
          chain: ['notify build', 4],
        },
        { index: 1, title: 'Tidy', state: 'bogus' },
        { title: 'no index' },
      ],
    });
    expect(read?.parts.map((p) => [p.title, p.state, p.locked, p.ticket])).toEqual([
      ['Capture', 'running', true, 'T-0131'],
      ['Tidy', 'new', false, null],
    ]);
    expect(read?.parts[0]!.flow).toHaveLength(1);
    expect(read?.parts[0]!.chain).toEqual(['notify build']);
    expect(read?.personas.map((p) => p.id)).toEqual(['ben']);
    expect(read?.warnings).toEqual(['x']);
  });

  it('reads a refusal or junk as nothing', () => {
    expect(parsePlanApproval({ ok: false, error: 'x' })).toBeNull();
    expect(parsePlanApproval(null)).toBeNull();
    expect(parsePlanApproval({ ok: true })).toBeNull();
  });
});

describe('the card helpers', () => {
  it('names the builder: the pin, else the default builder', () => {
    const a = approval([card(0, { persona: 'ralf' }), card(1)]);
    expect(builderOf(a.parts[0]!, a)?.title).toBe('Ralf');
    expect(builderOf(a.parts[1]!, a)?.title).toBe('Ben');
    expect(builderOf(card(0), { ...a, defaultPersona: null })).toBeNull();
    expect(builderOf(card(0, { persona: 'ghost' }), a)?.title).toBe('ghost');
  });

  it('writes the state badge of a released part and none for a new one', () => {
    expect(partBadgeOf(card(0))).toBe('');
    expect(partBadgeOf(card(0, { state: 'running', locked: true }))).toBe('● running · locked');
    expect(partBadgeOf(card(0, { state: 'queued', locked: true }))).toBe('● queued · locked');
    expect(partBadgeOf(card(0, { state: 'active', phase: 'commit', locked: true }))).toBe('● commit · locked');
    expect(partBadgeOf(card(0, { state: 'done', locked: true }))).toBe('✓ done · locked');
  });

  it('writes the flow row and its note', () => {
    const a = approval([card(0), card(1, { chain: ['skip commit', 'notify build'] })]);
    expect(flowSegmentsOf(a.parts[0]!, a).map((s) => s.text)).toEqual(['Build · Ben', 'Commit']);
    const withDelta = card(1, {
      chain: ['skip commit', 'notify build'],
      flow: [
        { phase: 'build', title: 'Build', persona: 'ben', inserted: false, skipped: false, notify: true },
        { phase: 'security', title: 'Security', persona: 'ralf', inserted: true, skipped: false, notify: false },
        { phase: 'commit', title: 'Commit', persona: null, inserted: false, skipped: true, notify: false },
      ],
    });
    expect(flowSegmentsOf(withDelta, a)).toEqual([
      { text: 'Build · Ben (tell me)', inserted: false, skipped: false },
      { text: 'Security · Ralf', inserted: true, skipped: false },
      { text: 'Commit', inserted: false, skipped: true },
    ]);
    expect(flowNoteOf(a.parts[0]!)).toBe('standard');
    expect(flowNoteOf(withDelta)).toBe('standard + 2 changes');
    expect(flowNoteOf(card(0, { chain: ['skip commit'] }))).toBe('standard + 1 change');
  });

  it('says what lets the next part start; the last part has no gate line', () => {
    expect(gateLineOf(0, 3)).toBe('Part 2 starts when this one is done.');
    expect(gateLineOf(1, 3)).toBe('Part 3 starts when this one is done.');
    expect(gateLineOf(2, 3)).toBeNull();
  });

  it('lets a part move only where the desk allows: never a released one, never above one', () => {
    const cards = [card(0, { locked: true, state: 'running' }), card(1), card(2)];
    expect(moveRoomOf(cards, 0)).toEqual({ up: false, down: false });
    expect(moveRoomOf(cards, 1)).toEqual({ up: false, down: true });
    expect(moveRoomOf(cards, 2)).toEqual({ up: true, down: false });
    expect(moveRoomOf(cards, 9)).toEqual({ up: false, down: false });
  });
});

describe('the estimate (D9)', () => {
  it('shows a figure with its basis only when there is one', () => {
    expect(estimateLineOf(estimate(0.3))).toEqual({ value: '$0.30 · 9 min', note: 'median of 6 similar runs' });
    expect(estimateLineOf(estimate(0.3, 3, null))).toEqual({ value: '$0.30', note: 'median of 3 similar runs' });
    expect(estimateLineOf(null)).toEqual({ value: 'not yet', note: 'fewer than 3 similar runs so far' });
  });

  it('sums the parts that have a basis and says how many that is', () => {
    expect(totalLineOf([estimate(0.3), estimate(0.45), estimate(0.15)])).toEqual({ value: '$0.90', note: '' });
    expect(totalLineOf([estimate(0.3), null, estimate(0.15)])).toEqual({ value: '$0.45', note: ' for 2 of 3 parts' });
    expect(totalLineOf([null, null])).toEqual({ value: 'no estimate yet', note: '' });
    expect(totalLineOf([])).toEqual({ value: 'no estimate yet', note: '' });
    expect(dollarsOf(1.8)).toBe('$1.80');
  });
});

describe("Mission Control's proposal", () => {
  it('proposes all parts, the first running now, with a choice to run only the first', () => {
    const p = proposalOf([card(0), card(1), card(2)]);
    expect(p.text).toBe(
      'Mission Control proposes to accept all 3 parts. Part 1 runs now; each part after it starts when the one before it is done.',
    );
    expect(p.approveLabel).toBe('Accept and run');
    expect(p.firstLabel).toBe('Run part 1 only');
  });

  it('proposes the rest behind a released part', () => {
    const p = proposalOf([card(0, { locked: true, state: 'running' }), card(1), card(2)]);
    expect(p.text).toContain('release the remaining 2 parts');
    expect(p.text).toContain('Part 2 starts when part 1 is done');
    expect(p.firstLabel).toBe('Run part 2 only');
    const last = proposalOf([card(0, { locked: true, state: 'queued' }), card(1)]);
    expect(last.text).toContain('release the last part');
    expect(last.firstLabel).toBeNull();
  });

  it('proposes nothing when everything is released or there are no parts', () => {
    const all = proposalOf([card(0, { locked: true, state: 'queued' }), card(1, { locked: true, state: 'queued' })]);
    expect(all).toEqual({ text: 'Every part is released. Follow them on Work.', approveLabel: null, firstLabel: null });
    expect(proposalOf([]).approveLabel).toBeNull();
  });
});

// --- the screen -------------------------------------------------------------------

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mount(
  initial: McPlanApproval | null,
  options: { readOnly?: boolean; estimates?: Record<string, McEstimate | null>; edit?: McApproveState['edit']; release?: McApproveState['release'] } = {},
): { el: HTMLElement; calls: McPartsEdit[]; released: string[]; state: McApproveState; click: (selector: string, index?: number) => void; settle: () => Promise<void> } {
  const calls: McPartsEdit[] = [];
  const released: string[] = [];
  const state: McApproveState = {
    open: () => (initial === null ? null : initial.ticket),
    approval: () => initial,
    error: () => null,
    readOnly: () => options.readOnly ?? false,
    estimate: (_gate, persona) => options.estimates?.[persona] ?? null,
    edit:
      options.edit ??
      (async (edit): Promise<McApproveReply> => {
        calls.push(edit);
        return { ok: true };
      }),
    release:
      options.release ??
      (async (scope): Promise<McApproveReply> => {
        released.push(scope);
        return { ok: true };
      }),
    changeFlow: vi.fn(),
    changeSplit: vi.fn(),
    close: vi.fn(),
    openTicket: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: MC_APPROVE_STATE, useValue: state }] });
  const fixture = TestBed.createComponent(PlanApprove);
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
  return { el, calls, released, state, click, settle };
}

const text = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('PlanApprove', () => {
  it('shows one card per part with builder, reason, flow, start rule, estimate and gate line', () => {
    const { el } = mount(approval([card(0, { reason: 'small and isolated', persona: 'ben' }), card(1), card(2)]), {
      estimates: { ben: estimate(0.3) },
    });
    const body = text(el);
    expect(body).toContain('Plan to accept · 3 parts');
    expect(body).toContain('Voice capture for tickets');
    expect(el.querySelectorAll('.pa-card')).toHaveLength(3);
    expect(body).toContain('Part title 1');
    expect(body).toContain('Part title 3');
    expect(body).toContain('small and isolated');
    expect(el.querySelector('.pa-flow')?.textContent).toContain('Build · Ben');
    expect(el.querySelector('.pa-flow')?.textContent).toContain('Commit');
    expect(el.querySelector('.pa-flow-note')?.textContent).toBe('standard');
    expect(body).toContain('Change flow ›');
    expect(body).toContain('Runs now');
    expect(body).toContain('After part 2');
    expect(body).toContain('Estimate $0.30 · 9 min · median of 6 similar runs');
    expect(el.querySelector('.pa-gate')?.textContent).toContain('Part 2 starts when this one is done.');
    expect(body).toContain('Change the split: edit the plan or ask Mission Control');
  });

  it('writes "not yet" for a part without a basis and a total for the parts that have one', () => {
    const { el } = mount(approval([card(0), card(1, { persona: 'paul' })]), { estimates: { ben: estimate(0.3) } });
    const body = text(el);
    expect(body).toContain('Estimate not yet · fewer than 3 similar runs so far');
    expect(body).toContain('Typically $0.30 for 1 of 2 parts');
  });

  it('Change flow opens the flow editor on that part; a released part has no link', () => {
    const { el, state, click } = mount(approval([card(0), card(1, { locked: true, state: 'queued', ticket: 'T-0141' })]));
    expect(el.querySelectorAll('.pa-flow-link')).toHaveLength(1);
    click('.pa-flow-link', 0);
    expect(state.changeFlow).toHaveBeenCalledWith(0);
  });

  it('shows no touches, overlap or routing anywhere (D5)', () => {
    const { el } = mount(approval([card(0), card(1)]));
    expect(text(el).toLowerCase()).not.toMatch(/overlap|touches|routing|shares src/);
  });

  it('picks a builder through the card’s persona chips', async () => {
    const { el, calls, click } = mount(approval([card(0), card(1)]));
    click('.pa-who', 1);
    expect(el.querySelectorAll('.pa-pick .chip')).toHaveLength(3);
    click('.pa-pick .chip', 2);
    await flush();
    expect(calls).toEqual([{ op: 'persona', index: 1, persona: 'ralf' }]);
  });

  it('moves a part from its actions, which a tap on the card opens', async () => {
    const { el, calls, click } = mount(approval([card(0), card(1), card(2)]));
    expect(el.querySelector('.pa-actions')).toBeNull();
    click('.pa-open', 1);
    const buttons = Array.from(el.querySelectorAll('.pa-actions .pa-btn')) as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['↑ Move up', '↓ Move down', 'Delete part']);
    buttons[0]!.click();
    await flush();
    expect(calls).toEqual([{ op: 'move', from: 1, to: 0 }]);
  });

  it('deletes only on the second press', async () => {
    const { el, calls, click } = mount(approval([card(0), card(1), card(2)]));
    click('.pa-open', 2);
    click('.pa-btn.danger');
    expect(calls).toEqual([]);
    expect(text(el)).toContain('Press again to delete');
    click('.pa-btn.danger');
    await flush();
    expect(calls).toEqual([{ op: 'delete', index: 2 }]);
  });

  it('forgets the first press when another card opens', () => {
    const { el, calls, click } = mount(approval([card(0), card(1)]));
    click('.pa-open', 0);
    click('.pa-btn.danger');
    click('.pa-open', 1);
    click('.pa-btn.danger');
    expect(calls).toEqual([]);
    expect(text(el)).toContain('Press again to delete');
  });

  it('locks a released part: no actions, no picker, a way to its ticket', () => {
    const { el, state, click } = mount(
      approval([card(0, { locked: true, state: 'running', ticket: 'T-0131', start: 'Released as T-0131' }), card(1)]),
    );
    expect(text(el)).toContain('● running · locked');
    expect((el.querySelectorAll('.pa-who')[0] as HTMLButtonElement).disabled).toBe(true);
    click('.pa-open', 0);
    expect(el.querySelector('.pa-actions .pa-btn')).toBeNull();
    expect(text(el)).toContain('Running: this part cannot be moved or deleted, and no part can be moved above it.');
    click('.pa-actions .link');
    expect(state.openTicket).toHaveBeenCalledWith('T-0131');
    // The new part under it cannot move above it.
    click('.pa-open', 1);
    const up = el.querySelectorAll('.pa-actions .pa-btn')[0] as HTMLButtonElement;
    expect(up.disabled).toBe(true);
  });

  it('approves everything, or only the first part', async () => {
    const { el, released, click, settle } = mount(approval([card(0), card(1), card(2)]));
    const buttons = Array.from(el.querySelectorAll('.pa-buttons .pa-btn')) as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['Run part 1 only', 'Accept and run']);
    click('.pa-buttons .pa-btn', 0);
    await settle();
    click('.pa-buttons .pa-btn', 1);
    await settle();
    expect(released).toEqual(['first', 'all']);
  });

  it('shows the desk’s refusal and keeps the screen', async () => {
    const { el, click, settle } = mount(approval([card(0), card(1)]), {
      release: async () => ({ ok: false, error: 'Part 2: persona "ghost" does not exist' }),
    });
    click('.pa-buttons .pa-btn', 1);
    await settle();
    expect(el.querySelector('.pa-error')?.textContent).toContain('persona "ghost" does not exist');
  });

  it('offers no approval once every part is released, and none on a read-only device', () => {
    const done = mount(approval([card(0, { locked: true, state: 'queued' }), card(1, { locked: true, state: 'queued' })]));
    expect(done.el.querySelector('.pa-buttons')).toBeNull();
    expect(text(done.el)).toContain('Every part is released.');
    TestBed.resetTestingModule();
    const ro = mount(approval([card(0), card(1)]), { readOnly: true });
    expect((ro.el.querySelectorAll('.pa-buttons .pa-btn')[1] as HTMLButtonElement).disabled).toBe(true);
    ro.click('.pa-open', 0);
    expect(ro.el.querySelector('.pa-actions')).toBeNull();
  });

  it('goes back to the shape dialog for the split and closes', () => {
    const { state, click } = mount(approval([card(0), card(1)]));
    click('.pa-split');
    expect(state.changeSplit).toHaveBeenCalled();
    click('.pa-back');
    expect(state.close).toHaveBeenCalled();
  });

  it('waits while the cards load', () => {
    const { el } = mount(null);
    expect(text(el)).toContain('Loading…');
    expect(el.querySelector('.pa-foot')).toBeNull();
  });
});
