import { describe, expect, it } from 'vitest';
import type { HandoverCandidate } from '../main/fleet/handover';
import { DEFAULT_FLEET_HANDOVER } from '../main/fleet/protocol';
import { handoverDialogState, type HandoverDialogInput } from './handover-ui';

/**
 * The start dialog's handover field (T-0049): the options mirror the
 * resolution rules — an option is enabled exactly when an explicit ask
 * for it would be honoured, so the dialog disables what the supervisor
 * would refuse instead of silently switching modes.
 */

const NOW = Date.parse('2026-10-30T12:00:00Z');

function candidate(over: Partial<HandoverCandidate> = {}): HandoverCandidate {
  return {
    phase: 'build',
    provider: 'opencode',
    model: null,
    state: 'failed',
    sessionRef: 'ses_1',
    lastTurnContext: 143_000,
    endedAt: '2026-10-30T11:57:00Z',
    ...over,
  };
}

function input(over: Partial<HandoverDialogInput> = {}): HandoverDialogInput {
  return {
    phase: 'build',
    candidate: candidate(),
    provider: 'opencode',
    model: null,
    config: DEFAULT_FLEET_HANDOVER,
    nowMs: NOW,
    ...over,
  };
}

const enabledOf = (state: ReturnType<typeof handoverDialogState>): Record<string, boolean> =>
  Object.fromEntries(state.options.map((o) => [o.mode, !o.disabled]));

describe('handoverDialogState — the options', () => {
  it('a warm retry preselects resume and offers all three on a native-compacting provider', () => {
    const state = handoverDialogState(input());
    expect(state.defaultMode).toBe('resume');
    expect(enabledOf(state)).toEqual({ fresh: true, resume: true, 'resume-compact': true });
    expect(state.statusLine).toContain('last: build · failed · ctx 143k · 3 min ago');
    expect(state.statusLine).toContain('resume last session');
  });

  it('a cold pause with a big context preselects resume-compact (native) — or fresh when the provider cannot', () => {
    const native = handoverDialogState(input({ candidate: candidate({ endedAt: '2026-10-30T10:00:00Z' }) }));
    expect(native.defaultMode).toBe('resume-compact');

    const claude = handoverDialogState(
      input({ provider: 'claude-code', candidate: candidate({ provider: 'claude-code', endedAt: '2026-10-30T10:00:00Z' }) }),
    );
    expect(claude.defaultMode).toBe('fresh');
    expect(enabledOf(claude)).toEqual({ fresh: true, resume: true, 'resume-compact': false });
    // Disabled carries the reason, never a silent switch.
    const compact = claude.options.find((o) => o.mode === 'resume-compact')!;
    expect(compact.why).toContain('cannot compact natively');
  });

  it('a provider change disables resume — the last session ran another worker', () => {
    const state = handoverDialogState(input({ provider: 'claude-code' }));
    expect(enabledOf(state)).toEqual({ fresh: true, resume: false, 'resume-compact': false });
    expect(state.options.find((o) => o.mode === 'resume')!.why).toContain('the last session ran');
  });

  it('the review phase offers fresh only — an independent worker judges the step', () => {
    const state = handoverDialogState(input({ phase: 'review' }));
    expect(state.defaultMode).toBe('fresh');
    expect(enabledOf(state)).toEqual({ fresh: true, resume: false, 'resume-compact': false });
  });

  it('no earlier run leaves fresh the only option, with an honest status line', () => {
    const state = handoverDialogState(input({ candidate: null }));
    expect(state.defaultMode).toBe('fresh');
    expect(enabledOf(state)).toEqual({ fresh: true, resume: false, 'resume-compact': false });
    expect(state.statusLine).toBe('No earlier run of this ticket — a fresh session.');
  });

  it('an unknown context (a pre-T-0048 record) shows as such in the status line', () => {
    const state = handoverDialogState(input({ candidate: candidate({ lastTurnContext: null }) }));
    expect(state.statusLine).toContain('ctx unknown');
  });
});
