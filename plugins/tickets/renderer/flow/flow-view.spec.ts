// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { FlowStepView } from '../../../../packages/tickets-engine/src/contracts/flow';
import type { FlowDraft } from './flow-model';
import { mountFlow, type FlowDeps } from './flow-view';

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

const base: FlowDraft = {
  ok: true,
  ticket: 'T-0130',
  title: 'Voice capture',
  scope: { kind: 'ticket' },
  chain: [],
  saved: [],
  steps: [step(1, 'build', { state: 'current', persona: 'ben', locked: true }), step(2, 'review', { persona: 'ralf' })],
  phases: [
    { id: 'build', title: 'Build' },
    { id: 'review', title: 'Review' },
    { id: 'manual', title: 'Manual step' },
  ],
  personas: [{ id: 'ben', kind: 'agent', title: 'Ben', color: '#6aa', model: 'sonnet' }],
  readOnly: null,
};
const edited: FlowDraft = { ...base, chain: ['insert manual after review'], steps: [...base.steps, step(3, 'manual', { inserted: true })] };

function setup(replies: Record<string, unknown>): { host: HTMLElement; invoke: ReturnType<typeof vi.fn>; dispose: () => void } {
  const invoke = vi.fn((method: string) => Promise.resolve(replies[method]));
  const deps: FlowDeps = { invoke, subscribe: () => () => undefined, titleOf: () => null };
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = mountFlow(deps, host, { ticketId: 'T-0130', part: null });
  return { host, invoke, dispose };
}

const buttonNamed = (host: HTMLElement, name: string): HTMLButtonElement =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

describe('Flow tab', () => {
  it('lists the gates the engine answers, with the standard-flow chip', async () => {
    const { host, invoke } = setup({ flow: base });
    await settle();
    expect(invoke).toHaveBeenCalledWith('flow', { id: 'T-0130', part: null });
    expect([...host.querySelectorAll('.flow-gate-title')].map((n) => n.textContent)).toEqual(['Build', 'Review']);
    expect(host.querySelector('.flow-chip')?.textContent).toBe('Standard flow');
    expect(buttonNamed(host, 'Save flow').disabled).toBe(true);
  });

  it('adds a gate through the engine and saves the resulting chain', async () => {
    const { host, invoke } = setup({ flow: base, flowEdit: edited, flowSave: { ok: true } });
    await settle();
    (host.querySelectorAll('.flow-plus')[1] as HTMLButtonElement).click();
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.flow-add .flow-chipbtn')];
    chips.find((c) => c.textContent === 'Manual step')!.click();
    await settle();
    expect(invoke).toHaveBeenCalledWith('flowEdit', { id: 'T-0130', part: null, chain: [], edit: { op: 'insert', phase: 'manual', after: 2 } });
    expect(host.querySelector('.flow-chip')?.textContent).toBe('Standard flow + 1 change · not saved');
    const save = buttonNamed(host, 'Save flow');
    expect(save.disabled).toBe(false);
    save.click();
    await settle();
    expect(invoke).toHaveBeenCalledWith('flowSave', { id: 'T-0130', part: null, chain: ['insert manual after review'] });
  });

  it('shows a refusal under the list and keeps the draft', async () => {
    const { host } = setup({ flow: base, flowEdit: { ok: false, error: 'Review is in this flow already' } });
    await settle();
    (host.querySelectorAll('.flow-plus')[0] as HTMLButtonElement).click();
    buttonNamed(host, 'Manual step').click();
    await settle();
    expect(host.querySelector('.flow-message')?.textContent).toBe('Review is in this flow already');
    expect(host.querySelector('.flow-chip')?.textContent).toBe('Standard flow');
  });

  it("applies Paul's draft with his reason, and undo goes back", async () => {
    const { host } = setup({ flow: base, flowDraft: { ...edited, reason: 'It touches auth.' } });
    await settle();
    (host.querySelector('.flow-input') as HTMLInputElement).value = 'add a security check';
    buttonNamed(host, 'Ask Paul').click();
    await settle();
    expect(host.querySelector('.flow-paul-t')?.textContent).toBe('It touches auth.');
    expect(host.querySelectorAll('.flow-gate').length).toBe(3);
    buttonNamed(host, 'Undo draft').click();
    expect(host.querySelectorAll('.flow-gate').length).toBe(2);
  });

  it('reports a read-only flow and a failed load', async () => {
    const ro = setup({ flow: { ...base, readOnly: 'A run is live on this ticket' } });
    await settle();
    expect(ro.host.textContent).toContain('A run is live on this ticket');
    expect((ro.host.querySelector('.flow-plus') as HTMLButtonElement).disabled).toBe(true);
    const failed = setup({ flow: { ok: false, error: 'no such ticket' } });
    await settle();
    expect(failed.host.querySelector('.flow-note')?.textContent).toBe('no such ticket');
  });
});
