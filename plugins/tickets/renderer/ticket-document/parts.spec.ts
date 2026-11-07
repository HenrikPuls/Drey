// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a spec builds the real catalog; the plugin itself gets it as `api.i18n`
import { i18n } from '../../../../shared/i18n';
import type { PlanPartCard, PlanPartsReply } from '../../../../packages/tickets-engine/src/contracts/plan-approval';
import type { RunEstimate } from '../../../../packages/tickets-engine/src/core/estimate';
import { createPartsStore, partsNode, type PartsNodeDeps } from './parts';
import { hasOpenParts, partsRange, partsViewOf } from './parts-model';

const card = (index: number, over: Partial<PlanPartCard> = {}): PlanPartCard => ({
  index,
  title: `Part ${index + 1}`,
  reason: index === 0 ? 'Mod+Alt+T, focus handling' : null,
  persona: 'ben',
  chain: [],
  flow: [],
  ticket: null,
  state: 'new',
  phase: null,
  locked: false,
  start: index === 0 ? 'Runs now' : `After part ${index}`,
  ...over,
});

const reply = (parts: readonly PlanPartCard[]): Extract<PlanPartsReply, { ok: true }> => ({
  ok: true,
  ticket: 'T-0130',
  title: 'Voice capture',
  parts,
  gate: 'build',
  defaultPersona: 'ben',
  personas: [
    { id: 'ben', title: 'Ben', role: 'builder', color: '#6fa58f', model: 'sonnet' },
    { id: 'tessa', title: 'Tessa', role: 'tester', color: '#c0706a', model: 'sonnet' },
  ],
  warnings: [],
});

const estimate = (costLow: number, costHigh: number): RunEstimate => ({ gate: 'build', persona: 'ben', model: 'sonnet', runs: 3, cost: costLow, costLow, costHigh, minutes: null, tokens: null }) as unknown as RunEstimate;

describe('partsRange', () => {
  it('takes the chapter from its heading to the next heading', () => {
    const text = '## Plan\n\n### Goal\n\nA.\n\n### Parts\n\n- [ ] One\n  persona: ben\n- [ ] Two\n\n### Open questions\n\n- Q\n';
    const range = partsRange(text)!;
    expect(text.slice(range.from, range.to)).toBe('### Parts\n\n- [ ] One\n  persona: ben\n- [ ] Two');
    expect(hasOpenParts(text)).toBe(true);
  });

  it('ignores a heading in a code fence and reads no open part when all are ticked', () => {
    expect(partsRange('```\n### Parts\n```\n')).toBeNull();
    expect(hasOpenParts('### Parts\n\n- [x] One\n')).toBe(false);
    expect(hasOpenParts('## Plan\n')).toBe(false);
  });
});

describe('partsViewOf', () => {
  it('words a part as board 7c does, and sums what is known', () => {
    const view = partsViewOf(i18n, reply([card(0), card(1), card(2, { persona: 'tessa' })]), (_gate, persona) => (persona === 'ben' ? estimate(1.1, 1.8) : null));
    expect(view.count).toBe('3 parts');
    expect(view.total).toBe('$2.20–3.60');
    expect(view.parts.map((part) => part.label)).toEqual(['P1', 'P2', 'P3']);
    expect(view.parts[0]).toMatchObject({ line: 'starts first · Mod+Alt+T, focus handling', stateLabel: 'Waiting', stateGlyph: '○', personaName: 'Ben', estimate: '$1.10–1.80', basis: 'from 3 runs' });
    expect(view.parts[1]!.line).toBe('after P1');
    expect(view.parts[2]).toMatchObject({ personaName: 'Tessa', estimate: '', basis: 'no estimate yet (first run)' });
  });

  it('names a released part by its ticket and locks it', () => {
    const view = partsViewOf(i18n, reply([card(0, { state: 'running', ticket: 'T-0141', start: 'Released as T-0141', locked: true })]), () => null);
    expect(view.parts[0]).toMatchObject({ line: 'Released as T-0141 · Mod+Alt+T, focus handling', stateLabel: 'Running', stateGlyph: '●', locked: true });
    expect(view.total).toBe('');
  });

  it('says when the flow is not the standard one', () => {
    expect(partsViewOf(i18n, reply([card(0)]), () => null).edited).toBe(false);
    expect(partsViewOf(i18n, reply([card(0, { chain: ['skip qa'] })]), () => null).edited).toBe(true);
  });
});

describe('partsNode', () => {
  afterEach(() => document.body.replaceChildren());

  const icon = (): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const deps = (over: Partial<PartsNodeDeps> = {}): PartsNodeDeps => ({
    i18n,
    icon,
    edit: vi.fn(),
    onFlow: vi.fn(),
    onAsk: vi.fn(),
    decide: true,
    flowSteps: ['Plan', 'Build', 'Review', 'Test'],
    ...over,
  });
  const view = (parts: readonly PlanPartCard[]) => partsViewOf(i18n, reply(parts), () => estimate(1.1, 1.8));
  const menuItem = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('.tickets-parts-menu button')].find((b) => b.textContent === label)!;

  it('draws the head, one row per part, the foot and the rule, and no Accept', () => {
    const node = partsNode(deps(), view([card(0), card(1)]));
    expect(node.querySelector('.tickets-parts-title')?.textContent).toBe('Plan to accept');
    expect(node.querySelector('.tickets-parts-count')?.textContent).toBe('2 parts');
    expect(node.querySelectorAll('.tickets-part')).toHaveLength(2);
    expect(node.querySelector('.tickets-parts-flow')?.textContent).toBe('Flow: standard · Plan, Build, Review, Test');
    expect(node.querySelector('.tickets-doc-decision-link')).not.toBeNull();
    expect(node.textContent).not.toContain('Accept plan');
    expect(node.querySelector('.tickets-parts-rule')?.textContent).toContain('A part that is running cannot be moved.');
  });

  it('picks a persona through the engine edit', () => {
    const d = deps();
    const node = partsNode(d, view([card(0)]));
    document.body.append(node);
    node.querySelector<HTMLButtonElement>('.tickets-part-persona')!.click();
    menuItem('Tessa').click();
    expect(d.edit).toHaveBeenCalledWith({ op: 'persona', index: 0, persona: 'tessa' });
    expect(document.querySelector('.tickets-parts-menu')).toBeNull();
  });

  it('moves a part from its menu, and deletes it on the second press only', () => {
    const d = deps();
    const node = partsNode(d, view([card(0), card(1)]));
    document.body.append(node);
    const more = node.querySelectorAll<HTMLButtonElement>('.tickets-part-more')[1]!;
    more.click();
    expect(menuItem('Move down').disabled).toBe(true);
    menuItem('Move up').click();
    expect(d.edit).toHaveBeenLastCalledWith({ op: 'move', from: 1, to: 0 });

    more.click();
    menuItem('Delete part').click();
    expect(d.edit).toHaveBeenCalledTimes(1);
    menuItem('Press again to delete').click();
    expect(d.edit).toHaveBeenLastCalledWith({ op: 'delete', index: 1 });
  });

  it('locks a part that is a ticket', () => {
    const node = partsNode(deps(), view([card(0, { state: 'running', locked: true })]));
    document.body.append(node);
    const row = node.querySelector<HTMLElement>('.tickets-part')!;
    expect(row.draggable).toBe(false);
    expect(row.querySelector<HTMLButtonElement>('.tickets-part-grip')!.disabled).toBe(true);
    expect(row.querySelector<HTMLButtonElement>('.tickets-part-persona')!.disabled).toBe(true);
    row.querySelector<HTMLButtonElement>('.tickets-part-more')!.click();
    expect(menuItem('Delete part').disabled).toBe(true);
    expect(menuItem('Change flow').disabled).toBe(false);
  });

  it('runs the flow link and the question to Mission Control', () => {
    const d = deps();
    const node = partsNode(d, view([card(0)]));
    node.querySelector<HTMLAnchorElement>('.tickets-parts-link')!.click();
    expect(d.onFlow).toHaveBeenCalledWith(null);
    node.querySelector<HTMLButtonElement>('.tickets-doc-btn')!.click();
    expect(d.onAsk).toHaveBeenCalledTimes(1);
  });
});

describe('createPartsStore', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  it('asks once per chapter text, and again after an edit', async () => {
    const calls: string[] = [];
    const changed = vi.fn();
    const store = createPartsStore({
      i18n,
      changed,
      invoke: async (method) => {
        calls.push(method);
        return method === 'planParts' ? reply([card(0)]) : method === 'planPartsEdit' ? { ok: true } : { estimate: null };
      },
    });
    expect(store.view('T-0130')).toBeNull();
    store.want('T-0130', 'a');
    store.want('T-0130', 'a');
    await flush();
    expect(calls.filter((c) => c === 'planParts')).toHaveLength(1);
    expect(store.view('T-0130')?.parts).toHaveLength(1);
    expect(changed).toHaveBeenCalled();
    expect(await store.edit('T-0130', { op: 'delete', index: 0 })).toBeNull();
    await flush();
    expect(calls.filter((c) => c === 'planParts')).toHaveLength(2);
  });

  it('hands back a refusal and shows no block for a ticket the engine refuses', async () => {
    const store = createPartsStore({
      i18n,
      changed: vi.fn(),
      invoke: async (method) => (method === 'planPartsEdit' ? { ok: false, error: 'part 1 is locked' } : { ok: false, error: 'no plan' }),
    });
    store.want('T-0130', 'a');
    await flush();
    expect(store.view('T-0130')).toBeNull();
    expect(await store.edit('T-0130', { op: 'delete', index: 0 })).toBe('part 1 is locked');
  });
});
