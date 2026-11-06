import { describe, expect, it, vi } from 'vitest';
import type { ChainStatus } from '../../../packages/tickets-engine/src/fleet/protocol';
import { chainAutopilotOf } from './autopilot-ipc';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const status = { configured: true, master: 'run', autopilot: { state: 'on' } } as unknown as ChainStatus;

describe('chainAutopilotOf', () => {
  it('passes a parsed record to the runner and wraps the status', async () => {
    const set = vi.fn(async () => status);
    expect(await chainAutopilotOf({ state: 'on' }, NOW, set)).toEqual({ ok: true, status });
    expect(set).toHaveBeenCalledWith({ state: 'on' });
  });

  it('normalises a resume time and refuses one in the past without asking the runner', async () => {
    const set = vi.fn(async () => status);
    await chainAutopilotOf({ state: 'paused', resumeAt: '2026-11-06T18:00:00Z' }, NOW, set);
    expect(set).toHaveBeenCalledWith({ state: 'paused', resumeAt: '2026-11-06T18:00:00.000Z' });
    set.mockClear();
    expect(await chainAutopilotOf({ state: 'paused', resumeAt: '2026-11-06T09:00:00Z' }, NOW, set)).toMatchObject({ ok: false, code: 'bad_resume_at' });
    expect(set).not.toHaveBeenCalled();
  });

  it('refuses an unknown state', async () => {
    expect(await chainAutopilotOf({ state: 'maybe' }, NOW, vi.fn())).toMatchObject({ ok: false, code: 'bad_state' });
  });

  it('says runner_down when no runner answers, and passes the runner\'s own refusal through', async () => {
    expect(await chainAutopilotOf({ state: 'off' }, NOW, async () => null)).toEqual({ ok: false, error: 'runner_down', code: 'runner_down' });
    const refusal = { ok: false, error: 'bad_state', code: 'bad_state' } as const;
    expect(await chainAutopilotOf({ state: 'off' }, NOW, async () => refusal)).toEqual(refusal);
  });
});
