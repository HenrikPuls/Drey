import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { WORK_VIEW_ID, createTicketHomeRule, createWorkPreset, registerWorkView } from './view-preset';

describe('the Work preset', () => {
  it('arranges Tickets left, the Assistant right and the Capacity band below', () => {
    const preset = createWorkPreset();
    expect(preset.id).toBe(WORK_VIEW_ID);
    expect(preset.label).toBe('Work');
    expect(preset.layout).toEqual({ left: ['tickets'], right: ['assistant'], bottom: ['tickets-capacity'] });
  });

  it('names no Assistant target until E13-5 gives it one', () => {
    expect(createWorkPreset().assistantTarget).toBeUndefined();
  });
});

describe('the ticket home rule', () => {
  const rule = (vault: string | null) => createTicketHomeRule(() => vault);

  it('sends a ticket file of the board vault to Work', () => {
    const r = rule('v1');
    expect(r.homeView).toBe(WORK_VIEW_ID);
    expect(r.matches('tickets/50-build/T-0042.md', 'v1')).toBe(true);
    expect(r.matches('tickets/inbox/T-10000.md', 'v1')).toBe(true);
  });

  it('leaves notes, other vaults and ticket-like names elsewhere alone', () => {
    const r = rule('v1');
    expect(r.matches('notes/T-0042.md', 'v1')).toBe(false);
    expect(r.matches('tickets/50-build/T-0042.md', 'v2')).toBe(false);
    expect(r.matches('tickets/50-build/T-0042.md', null)).toBe(false);
  });

  it('matches nothing while no tickets repository is set up', () => {
    expect(rule(null).matches('tickets/50-build/T-0042.md', null)).toBe(false);
  });

  it('follows the board vault when it changes', () => {
    let vault: string | null = 'v1';
    const r = createTicketHomeRule(() => vault);
    vault = 'v2';
    expect(r.matches('tickets/50-build/T-0042.md', 'v1')).toBe(false);
    expect(r.matches('tickets/50-build/T-0042.md', 'v2')).toBe(true);
  });
});

describe('registerWorkView', () => {
  it('registers both and unregisters both', () => {
    const offPreset = vi.fn();
    const offRule = vi.fn();
    const api = {
      ui: { registerViewPreset: vi.fn(() => offPreset) },
      documents: { registerHomeViewRule: vi.fn(() => offRule) },
    } as unknown as DreyPluginApi;
    const off = registerWorkView(api, () => null);
    expect(api.ui.registerViewPreset).toHaveBeenCalledTimes(1);
    expect(api.documents.registerHomeViewRule).toHaveBeenCalledTimes(1);
    off();
    expect(offPreset).toHaveBeenCalled();
    expect(offRule).toHaveBeenCalled();
  });
});
