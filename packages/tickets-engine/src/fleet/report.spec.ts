import { describe, expect, it } from 'vitest';
import { tokenReport, type ReportRun } from './report';

/**
 * The token report (T-0048): grouping by (ticket, phase, model), the
 * pre-T-0048 fallback, absent-never-zero, sorted by total desc.
 */

const run = (over: Partial<ReportRun> = {}): ReportRun => ({
  ticketId: 'T-0001',
  phase: 'build',
  model: 'zai-coding-plan/glm-5.3-flash',
  provider: 'opencode',
  usage: { input: 1_000, cacheRead: 10_000, cacheCreation: 2_000, output: 500 },
  tokensIn: 0,
  tokensOut: 0,
  tokensBeforeFirstWrite: 6_000,
  ...over,
});

describe('tokenReport', () => {
  it('groups by ticket, phase and model and sums every counter', () => {
    const groups = tokenReport([
      run(),
      run({ usage: { input: 500, cacheRead: null, cacheCreation: null, output: 100 }, tokensBeforeFirstWrite: 500 }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g).toMatchObject({ ticket: 'T-0001', phase: 'build', model: 'zai-coding-plan/glm-5.3-flash', runs: 2 });
    expect(g.total).toBe(1_000 + 10_000 + 2_000 + 500 + 500 + 100);
    expect(g.input).toBe(1_500);
    expect(g.cacheRead).toBe(10_000);
    expect(g.cacheCreation).toBe(2_000);
    expect(g.output).toBe(600);
    expect(g.beforeFirstWrite).toBe(6_500);
    expect(g.beforeFirstWriteShare).toBe(6_500 / 13_500);
  });

  it('the same ticket in another phase or model is its own group', () => {
    const groups = tokenReport([
      run(),
      run({ phase: 'review' }),
      run({ model: null }),
    ]);
    // Equal totals: the deterministic tie-break is ticket, phase, model.
    expect(groups.map((g) => `${g.phase}/${g.model}`)).toEqual([
      'build/null',
      'build/zai-coding-plan/glm-5.3-flash',
      'review/zai-coding-plan/glm-5.3-flash',
    ]);
  });

  it('sorts by total, descending', () => {
    const groups = tokenReport([
      run({ ticketId: 'T-0002', usage: { input: 10, cacheRead: null, cacheCreation: null, output: 5 } }),
      run({ ticketId: 'T-0001', usage: { input: 10_000, cacheRead: null, cacheCreation: null, output: 5 } }),
    ]);
    expect(groups.map((g) => g.total)).toEqual([10_005, 15]);
  });

  it('a pre-T-0048 record falls back to its cumulative tokensIn/tokensOut', () => {
    const groups = tokenReport([run({ usage: null, tokensIn: 4_000, tokensOut: 1_000, tokensBeforeFirstWrite: null })]);
    expect(groups[0]!.total).toBe(5_000);
    expect(groups[0]!.beforeFirstWrite).toBeNull();
    expect(groups[0]!.beforeFirstWriteShare).toBeNull();
  });

  it('absent counters count 0 into the sums (never masked as measured)', () => {
    const groups = tokenReport([run({ usage: { input: 700, cacheRead: null, cacheCreation: null, output: null } })]);
    expect(groups[0]!.cacheRead).toBe(0);
    expect(groups[0]!.output).toBe(0);
    expect(groups[0]!.total).toBe(700);
  });

  it('beforeFirstWriteShare is the share of the group input side', () => {
    // Input side 1_000+10_000+2_000 = 13_000; before first write 6_500 → 0.5.
    const groups = tokenReport([run({ tokensBeforeFirstWrite: 6_500 })]);
    expect(groups[0]!.beforeFirstWriteShare).toBe(0.5);
    // Not computable without an input side.
    expect(tokenReport([run({ usage: { input: 0, cacheRead: null, cacheCreation: null, output: 0 } })])[0]!.beforeFirstWriteShare).toBeNull();
  });

  it('the empty report is empty', () => {
    expect(tokenReport([])).toEqual([]);
  });
});
