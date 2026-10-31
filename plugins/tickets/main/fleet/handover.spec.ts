import { describe, expect, it } from 'vitest';
import { COMPACT_CAPABILITY, compactThreshold, contextCap, HANDOVER_CANDIDATE_STATES, resolveHandover, type HandoverCandidate, type HandoverInput } from './handover';
import { DEFAULT_FLEET_HANDOVER, type FleetHandoverConfig, type RunState } from './protocol';

/**
 * The handover rules (T-0049) pinned one rule per case: the same pure
 * function serves the supervisor's start and the start dialog, so what
 * the dialog disables is exactly what resolution would refuse.
 */

const NOW = Date.parse('2026-10-30T12:00:00Z');

/** A resumable candidate: build-phase run, ended 3 min ago, ctx 143k. */
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

function input(over: Partial<HandoverInput> = {}): HandoverInput {
  return {
    requested: 'auto',
    phase: 'build',
    candidate: candidate(),
    provider: 'opencode',
    model: null,
    sessionInvalidated: false,
    sessionInUse: false,
    capability: 'native',
    config: DEFAULT_FLEET_HANDOVER,
    nowMs: NOW,
    ...over,
  };
}

describe('resolveHandover — the structural rules (every path)', () => {
  it('the review phase always starts fresh — even an explicit resume with a perfect candidate', () => {
    const decision = resolveHandover(input({ phase: 'review', requested: 'resume' }));
    expect(decision.mode).toBe('fresh');
    expect(decision.resumeRef).toBeNull();
    expect(decision.why).toContain('independent');
  });

  it('no earlier run of the ticket → fresh', () => {
    const decision = resolveHandover(input({ candidate: null }));
    expect(decision.mode).toBe('fresh');
    expect(decision.why).toContain('no earlier run');
  });

  it('a detached (or otherwise non-terminal) run is not a candidate', () => {
    for (const state of ['detached', 'running', 'stopping', 'starting'] as RunState[]) {
      const decision = resolveHandover(input({ candidate: candidate({ state }) }));
      expect(decision.mode).toBe('fresh');
    }
    expect(HANDOVER_CANDIDATE_STATES).toEqual(['done', 'stopped', 'failed']);
  });

  it('a candidate that reported no session → fresh', () => {
    const decision = resolveHandover(input({ candidate: candidate({ sessionRef: null }) }));
    expect(decision.mode).toBe('fresh');
    expect(decision.why).toContain('no session');
  });

  it('another provider or model → fresh (a null model matches a null model)', () => {
    const otherProvider = resolveHandover(input({ candidate: candidate({ provider: 'claude-code' }) }));
    expect(otherProvider.mode).toBe('fresh');
    expect(otherProvider.why).toContain('claude-code');

    const otherModel = resolveHandover(input({ candidate: candidate({ model: 'glm-5.3' }), model: 'glm-5.3-flash' }));
    expect(otherModel.mode).toBe('fresh');

    const nullMatches = resolveHandover(input({ candidate: candidate({ model: null }), model: null }));
    expect(nullMatches.mode).not.toBe('fresh');
  });

  it('a candidate of another phase (build after plan) → fresh', () => {
    const decision = resolveHandover(input({ candidate: candidate({ phase: 'plan' }) }));
    expect(decision.mode).toBe('fresh');
    expect(decision.why).toContain('plan');
  });

  it('a recreated or moved-aside worktree (T-0047 flag) → fresh', () => {
    const decision = resolveHandover(input({ sessionInvalidated: true }));
    expect(decision.mode).toBe('fresh');
    expect(decision.why).toContain('stale');
  });

  it('a session another run holds → fresh (no double resume)', () => {
    const decision = resolveHandover(input({ sessionInUse: true }));
    expect(decision.mode).toBe('fresh');
    expect(decision.why).toContain('twice');
  });
});

describe('resolveHandover — the auto path (the measured rules)', () => {
  it('a pause within the cache TTL resumes, whatever the context (spike 3)', () => {
    const warm = resolveHandover(input({ candidate: candidate({ endedAt: '2026-10-30T11:57:00Z' }) })); // 3 min
    expect(warm.mode).toBe('resume');
    expect(warm.resumeRef).toBe('ses_1');
    expect(warm.compactFirst).toBe(false);
    expect(warm.why).toContain('cache TTL');

    // Still warm at the TTL boundary (14 min of 15); a big context too.
    const bigButWarm = resolveHandover(input({ candidate: candidate({ endedAt: '2026-10-30T11:46:00Z' }) }));
    expect(bigButWarm.mode).toBe('resume');
  });

  it('a cold pause with a context below the threshold resumes as it is', () => {
    const cold = resolveHandover(input({ candidate: candidate({ endedAt: '2026-10-30T10:00:00Z', lastTurnContext: 40_000 }) }));
    expect(cold.mode).toBe('resume');
    expect(cold.compactFirst).toBe(false);
    expect(cold.why).toContain('below the compact threshold');
  });

  it('a cold pause with a context at or above the threshold compacts first — native only', () => {
    const compact = resolveHandover(
      input({ candidate: candidate({ endedAt: '2026-10-30T10:00:00Z', lastTurnContext: 143_000 }) }),
    );
    expect(compact.mode).toBe('resume-compact');
    expect(compact.resumeRef).toBe('ses_1');
    expect(compact.compactFirst).toBe(true);

    const noNative = resolveHandover(input({ candidate: candidate({ endedAt: '2026-10-30T10:00:00Z' }), capability: 'none' }));
    expect(noNative.mode).toBe('fresh');
    expect(noNative.why).toContain('no native compact');
  });

  it('a cold pause with an unknown context (a pre-T-0048 record) starts fresh', () => {
    const unknown = resolveHandover(input({ candidate: candidate({ endedAt: '2026-10-30T10:00:00Z', lastTurnContext: null }) }));
    expect(unknown.mode).toBe('fresh');
    expect(unknown.why).toContain('unmeasured');
  });

  it('a candidate without an end time counts as a cold pause', () => {
    const noEnd = resolveHandover(input({ candidate: candidate({ endedAt: null }) }));
    expect(noEnd.mode).not.toBe('resume');
  });
});

describe('resolveHandover — explicit requests', () => {
  it('an explicit fresh stays fresh even with a perfect candidate', () => {
    const decision = resolveHandover(input({ requested: 'fresh' }));
    expect(decision.mode).toBe('fresh');
  });

  it('an explicit resume is honoured when structurally legal', () => {
    const decision = resolveHandover(input({ requested: 'resume' }));
    expect(decision).toMatchObject({ mode: 'resume', resumeRef: 'ses_1', compactFirst: false });
  });

  it('an explicit resume-compact compacts when the provider can — and refuses when it cannot', () => {
    const can = resolveHandover(input({ requested: 'resume-compact' }));
    expect(can).toMatchObject({ mode: 'resume-compact', resumeRef: 'ses_1', compactFirst: true });

    const cannot = resolveHandover(input({ requested: 'resume-compact', capability: 'none' }));
    expect(cannot.mode).toBe('fresh');
    expect(cannot.why).toContain('cannot compact');
  });

  it('a structurally illegal explicit request falls back to fresh — never a silent switch to another resume mode', () => {
    const invalidated = resolveHandover(input({ requested: 'resume', sessionInvalidated: true }));
    expect(invalidated.mode).toBe('fresh');
    const inUse = resolveHandover(input({ requested: 'resume-compact', sessionInUse: true }));
    expect(inUse.mode).toBe('fresh');
  });
});

describe('COMPACT_CAPABILITY', () => {
  it('opencode compacts natively, claude-code not yet (spike 1 proved routing, not effect)', () => {
    expect(COMPACT_CAPABILITY['opencode']).toBe('native');
    expect(COMPACT_CAPABILITY['claude-code']).toBe('none');
  });
});

describe('contextCap — the mid-run cap, same precedence (req-80)', () => {
  it('model beats provider beats base; 0 means none', () => {
    const config = {
      compactAboveTokens: 60_000,
      resumePauseTtlMin: 15,
      contextCapTokens: 160_000,
      contextCapTokensOverrides: { opencode: 120_000, 'opencode/glm-5.3': 0 },
    };
    expect(contextCap(config, 'opencode', 'glm-5.3')).toBe(0);
    expect(contextCap(config, 'opencode', 'glm-5.3-flash')).toBe(120_000);
    expect(contextCap(config, 'claude-code', null)).toBe(160_000);
  });
});

describe('compactThreshold — the per-provider/model overrides', () => {
  const config = {
    compactAboveTokens: 60_000,
    compactAboveTokensOverrides: { opencode: 40_000, 'opencode/glm-5.3': 20_000, broken: -1 },
    resumePauseTtlMin: 15,
    contextCapTokens: 160_000,
  };

  it('the most-specific key wins; unknown keys and a bare base never match', () => {
    expect(compactThreshold(config, 'opencode', 'glm-5.3')).toBe(20_000);
    expect(compactThreshold(config, 'opencode', 'glm-5.3-flash')).toBe(40_000);
    expect(compactThreshold(config, 'claude-code', 'sonnet')).toBe(60_000);
    expect(compactThreshold(config, 'opencode', null)).toBe(40_000);
  });

  it('an invalid override entry is ignored (the base applies)', () => {
    expect(compactThreshold(config, 'broken', null)).toBe(60_000);
  });

  it('the auto path honours the override: a cold 30k context compacts under a 20k bar', () => {
    const cold = resolveHandover(
      input({
        candidate: candidate({ endedAt: '2026-10-30T10:00:00Z', lastTurnContext: 30_000, model: 'glm-5.3' }),
        model: 'glm-5.3',
        config,
      }),
    );
    expect(cold.mode).toBe('resume-compact');
  });
});
