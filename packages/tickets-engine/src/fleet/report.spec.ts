import { describe, expect, it } from 'vitest';
import { personaCostReport, tokenReport, UNASSIGNED_PERSONA, type ReportRun } from './report';

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

describe('personaCostReport (E3)', () => {
  it('groups by persona and sums tokens, runs and cost', () => {
    const groups = personaCostReport([
      run({ persona: 'architect', costUsd: 0.5 }),
      run({ persona: 'architect', costUsd: null }),
      run({
        persona: 'fixer',
        usage: { input: 500, cacheRead: null, cacheCreation: null, output: 100 },
        tokensBeforeFirstWrite: 500,
        costUsd: 0.25,
      }),
      run({ persona: null, costUsd: 0.1 }),
      run({ costUsd: undefined }),
    ]);
    expect(groups).toHaveLength(3);
    const architect = groups.find((g) => g.persona === 'architect')!;
    expect(architect.runs).toBe(2);
    expect(architect.total).toBe(2 * (1_000 + 10_000 + 2_000 + 500));
    expect(architect.input).toBe(2_000);
    expect(architect.cacheRead).toBe(20_000);
    expect(architect.cacheCreation).toBe(4_000);
    expect(architect.output).toBe(1_000);
    expect(architect.costUsd).toBe(0.5);
    const fixer = groups.find((g) => g.persona === 'fixer')!;
    expect(fixer.runs).toBe(1);
    expect(fixer.total).toBe(600);
    expect(fixer.costUsd).toBe(0.25);
  });

  it('null, undefined and absent personas aggregate under "unassigned"', () => {
    const groups = personaCostReport([
      run({ persona: null, usage: { input: 100, cacheRead: null, cacheCreation: null, output: 10 } }),
      run({ persona: undefined, usage: { input: 200, cacheRead: null, cacheCreation: null, output: 20 } }),
      run({ usage: { input: 400, cacheRead: null, cacheCreation: null, output: 40 } }),
      run({ persona: 'architect', usage: { input: 800, cacheRead: null, cacheCreation: null, output: 80 } }),
    ]);
    expect(groups).toHaveLength(2);
    const unassigned = groups.find((g) => g.persona === UNASSIGNED_PERSONA)!;
    expect(unassigned.runs).toBe(3);
    expect(unassigned.total).toBe(770);
    expect(unassigned.costUsd).toBeNull();
  });

  it('costUsd sums what is reported and stays null when nothing was', () => {
    const none = personaCostReport([run({ costUsd: null }), run({})]);
    expect(none[0]!.costUsd).toBeNull();
    const some = personaCostReport([run({ costUsd: 0.1 }), run({ costUsd: null }), run({ costUsd: 0.2 })]);
    expect(some[0]!.costUsd).toBeCloseTo(0.3);
  });

  it('a pre-T-0048 record falls back to its cumulative tokensIn/tokensOut', () => {
    const groups = personaCostReport([run({ persona: 'architect', usage: null, tokensIn: 4_000, tokensOut: 1_000 })]);
    expect(groups[0]!.total).toBe(5_000);
  });

  it('sorts by total, descending, persona id as the tie-break', () => {
    const groups = personaCostReport([
      run({ persona: 'zed', usage: { input: 10, cacheRead: null, cacheCreation: null, output: 0 } }),
      run({ persona: 'alpha', usage: { input: 10, cacheRead: null, cacheCreation: null, output: 0 } }),
      run({ persona: 'architect' }),
    ]);
    expect(groups.map((g) => g.persona)).toEqual(['architect', 'alpha', 'zed']);
  });

  it('does not disturb the ticket/phase/model grouping (backward compatibility)', () => {
    // The E3 persona fields are additive: tokenReport still keys on
    // (ticket, phase, model) alone and the pre-E3 ReportRun shape (no
    // persona/costUsd) still typechecks and reports.
    const runs: ReportRun[] = [
      run({ persona: 'architect' }),
      run({ persona: 'fixer', usage: { input: 500, cacheRead: null, cacheCreation: null, output: 100 } }),
    ];
    const groups = tokenReport(runs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs).toBe(2);
  });

  it('the empty report is empty', () => {
    expect(personaCostReport([])).toEqual([]);
  });
});
