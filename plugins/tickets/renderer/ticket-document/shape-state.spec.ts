import { describe, expect, it, vi } from 'vitest';
import { createPlanStatusStore } from './shape-state';

const OK = { ok: true, version: 1, modelAt: null, edits: 0, summary: null, marks: [] };

describe('the plan status store', () => {
  it('asks once per buffer text, with the text, and tells listeners when the answer changed', async () => {
    const invoke = vi.fn(async () => OK);
    const store = createPlanStatusStore({ invoke, delayMs: 0 });
    const heard = vi.fn();
    store.subscribe(heard);

    store.want('T-0130', 'text one');
    store.want('T-0130', 'text one');
    await vi.waitFor(() => expect(store.get('T-0130')).toEqual(OK));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('mcPlanStatus', { ticket: 'T-0130', text: 'text one' });
    expect(heard).toHaveBeenCalledTimes(1);

    store.want('T-0130', 'text one');
    store.want('T-0130', 'text two');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    // The same answer again is not news.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('refresh asks at once, even for a text it has asked about', async () => {
    const invoke = vi.fn(async () => OK);
    const store = createPlanStatusStore({ invoke, delayMs: 10_000 });
    store.want('T-0130', 'a');
    store.refresh('T-0130');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    store.refresh('T-0130');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it('keeps nothing from a refusal or a failed call', async () => {
    const invoke = vi
      .fn<(method: string, payload?: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, error: 'no plan' })
      .mockRejectedValueOnce(new Error('offline'));
    const store = createPlanStatusStore({ invoke, delayMs: 0 });
    store.refresh('T-0130');
    store.refresh('T-0130');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.get('T-0130')).toBeNull();
  });
});
