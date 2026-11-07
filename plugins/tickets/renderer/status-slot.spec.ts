import { describe, expect, it, vi } from 'vitest';
import type { StatusItemSpec } from '../../../shared/plugin-api/renderer';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the spec stands in for the host, which owns the catalog at runtime
import { i18n } from '../../../shared/i18n';
import { autopilotSlotOf, costSlotOf, createStatusSlots, needsSlotOf } from './status-slot';

const t = i18n.t.bind(i18n);

describe('the cost item', () => {
  it('reads "$4.10 of $15 today", neutral, titled "so far"', () => {
    expect(costSlotOf(4.1, 15, t)).toEqual({ text: '$4.10 of $15 today', tooltip: 'so far' });
    expect(costSlotOf(4.1, null, t).text).toBe('$4.10 today');
    expect(costSlotOf(4.1, 15, t).dot).toBeUndefined();
  });
  it('hides without a cost', () => {
    expect(costSlotOf(null, 15, t).text).toBe('');
  });
});

describe('the needs-you item', () => {
  it('has the orange dot and says where while in Notes', () => {
    expect(needsSlotOf(3, false, t)).toMatchObject({ text: '3 need you', dot: 'attention' });
    expect(needsSlotOf(3, true, t).text).toBe('3 need you in Work');
    expect(needsSlotOf(1, false, t).text).toBe('1 needs you');
  });
  it('hides at zero', () => {
    expect(needsSlotOf(0, true, t).text).toBe('');
  });
});

describe('the Autopilot item', () => {
  it('shows On with a green dot, Paused and Off without one, nothing without a chain', () => {
    expect(autopilotSlotOf('paused', t)).toEqual({ text: 'Autopilot · Paused', tooltip: 'Autopilot: Paused (Mod+Alt+P)', dot: 'attention' });
    expect(autopilotSlotOf('on', t)).toEqual({ text: 'Autopilot · On', tooltip: 'Autopilot: On (Mod+Alt+P)', dot: 'positive' });
    expect(autopilotSlotOf('off', t)).toEqual({ text: 'Autopilot · Off', tooltip: 'Autopilot: Off (Mod+Alt+P)' });
    expect(autopilotSlotOf(null, t).text).toBe('');
  });
});

describe('createStatusSlots', () => {
  it('creates three items and feeds them', () => {
    const specs: StatusItemSpec[] = [];
    const updates: Partial<StatusItemSpec>[][] = [];
    const dispose = vi.fn();
    const host = {
      createStatusItem: (spec: StatusItemSpec) => {
        specs.push(spec);
        const own: Partial<StatusItemSpec>[] = [];
        updates.push(own);
        return { update: (patch: Partial<StatusItemSpec>) => void own.push(patch), element: () => (spec.expanded === undefined ? null : anchor), dispose };
      },
    };
    const anchor = {} as HTMLElement;
    const slots = createStatusSlots(host, 'tickets.showBoard', t);
    // The Autopilot item sits left of the cost item (higher priority = further left).
    expect(Math.max(...specs.map((s) => s.priority ?? 0))).toBe(specs[2]!.priority);
    expect(specs.map((s) => s.commandId)).toEqual([undefined, 'tickets.showBoard', 'tickets.autopilot']);
    slots.update({ cost: 4.1, budget: 15, needsYou: 3, autopilot: 'on', inNotesView: false });
    expect(updates.map((u) => u[0]!.text)).toEqual(['$4.10 of $15 today', '3 need you', 'Autopilot · On']);
    expect(slots.autopilotElement()).toBe(anchor);
    slots.setAutopilotExpanded(true);
    expect(updates[2]!.at(-1)).toEqual({ expanded: true });
    slots.dispose();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});
