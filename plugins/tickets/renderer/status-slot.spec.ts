import { describe, expect, it, vi } from 'vitest';
import type { StatusItemSpec } from '../../../shared/plugin-api/renderer';
import { autopilotSlotOf, costSlotOf, createStatusSlots, needsSlotOf } from './status-slot';

describe('the cost item', () => {
  it('reads "$4.10 of $15 today", neutral, titled "so far"', () => {
    expect(costSlotOf(4.1, 15)).toEqual({ text: '$4.10 of $15 today', tooltip: 'so far' });
    expect(costSlotOf(4.1, null).text).toBe('$4.10 today');
    expect(costSlotOf(4.1, 15).dot).toBeUndefined();
  });
  it('hides without a cost', () => {
    expect(costSlotOf(null, 15).text).toBe('');
  });
});

describe('the needs-you item', () => {
  it('has the orange dot and says where while in Notes', () => {
    expect(needsSlotOf(3, false)).toMatchObject({ text: '3 need you', dot: 'attention' });
    expect(needsSlotOf(3, true).text).toBe('3 need you in Work');
    expect(needsSlotOf(1, false).text).toBe('1 needs you');
  });
  it('hides at zero', () => {
    expect(needsSlotOf(0, true).text).toBe('');
  });
});

describe('the Autopilot item', () => {
  it('shows On with a green dot for run, Off for halted, nothing without a chain', () => {
    expect(autopilotSlotOf('run')).toEqual({ text: 'Autopilot · On', tooltip: 'Autopilot: On (Mod+Alt+P)', dot: 'positive' });
    expect(autopilotSlotOf('halted')).toEqual({ text: 'Autopilot · Off', tooltip: 'Autopilot: Off (Mod+Alt+P)' });
    expect(autopilotSlotOf(null).text).toBe('');
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
    const slots = createStatusSlots(host, 'tickets.showBoard');
    expect(specs.map((s) => s.commandId)).toEqual([undefined, 'tickets.showBoard', undefined]);
    slots.update({ cost: 4.1, budget: 15, needsYou: 3, master: 'run', inNotesView: false });
    expect(updates.map((u) => u[0]!.text)).toEqual(['$4.10 of $15 today', '3 need you', 'Autopilot · On']);
    slots.dispose();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});
