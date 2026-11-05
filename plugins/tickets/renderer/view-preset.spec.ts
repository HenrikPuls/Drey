import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi, PluginDocKindContrib } from '../../../shared/plugin-api/renderer';
import { registerFlowKind } from './flow/register';
import { WORK_VIEW_ID, createWorkPreset, registerWorkView } from './view-preset';
import type { DeskDeps } from './desk-deps';

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

describe('selecting a ticket never changes the active view (D-6)', () => {
  it('registerWorkView registers the preset only -- no home rule that pulls ticket files into Work', () => {
    const offPreset = vi.fn();
    const registerHomeViewRule = vi.fn(() => vi.fn());
    const api = {
      ui: { registerViewPreset: vi.fn(() => offPreset) },
      documents: { registerHomeViewRule },
    } as unknown as DreyPluginApi;
    const off = registerWorkView(api);
    expect(api.ui.registerViewPreset).toHaveBeenCalledTimes(1);
    expect(registerHomeViewRule).not.toHaveBeenCalled();
    off();
    expect(offPreset).toHaveBeenCalled();
  });

  it('the Flow tab (opened from a selected ticket) names no home view', () => {
    let kind: PluginDocKindContrib | null = null;
    const api = {
      ui: {
        registerDocKind: vi.fn((k: PluginDocKindContrib) => {
          kind = k;
          return () => undefined;
        }),
      },
    } as unknown as DreyPluginApi;
    registerFlowKind(api, {} as DeskDeps);
    expect(kind).not.toBeNull();
    expect((kind as unknown as PluginDocKindContrib).homeView).toBeUndefined();
  });
});
