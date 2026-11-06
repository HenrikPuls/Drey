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
  it('shows On with a green dot for run, Off for halted, nothing without a chain', () => {
    expect(autopilotSlotOf('run', t)).toEqual({ text: 'Autopilot · On', tooltip: 'Autopilot: On (Mod+Alt+P)', dot: 'positive' });
    expect(autopilotSlotOf('halted', t)).toEqual({ text: 'Autopilot · Off', tooltip: 'Autopilot: Off (Mod+Alt+P)' });
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
        return { update: (patch: Partial<StatusItemSpec>) => void own.push(patch), dispose };
      },
    };
    const slots = createStatusSlots(host, 'tickets.showBoard', t);
    expect(specs.map((s) => s.commandId)).toEqual([undefined, 'tickets.showBoard', undefined]);
    slots.update({ cost: 4.1, budget: 15, needsYou: 3, master: 'run', inNotesView: false });
    expect(updates.map((u) => u[0]!.text)).toEqual(['$4.10 of $15 today', '3 need you', 'Autopilot · On']);
    slots.dispose();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});
