import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from './providers';
import { READ_TOOLS, TelemetryFold, telemetryFromEvents, WRITE_TOOLS } from './telemetry';

/**
 * Telemetry over fixture event streams shaped exactly like the two
 * adapters' outputs (T-0048): the fold must sum the per-turn usage and
 * never let a cumulative aggregate pose as a context size.
 */

const ts = '2026-10-20T12:00:00Z';
const note = (text: string, tool?: string): NormalizedEvent => ({ ts, kind: 'note', text, ...(tool !== undefined ? { tool } : {}) });
const turn = (usage: { input?: number; cacheRead?: number; cacheCreation?: number; output?: number }): NormalizedEvent => ({
  ts,
  kind: 'usage',
  turnUsage: {
    input: usage.input ?? null,
    cacheRead: usage.cacheRead ?? null,
    cacheCreation: usage.cacheCreation ?? null,
    output: usage.output ?? null,
  },
});

/** A claude-code-shaped stream: tool notes (`Read`), one usage event per turn. */
const claudeFixture: readonly NormalizedEvent[] = [
  note('Read src/a.ts', 'Read'),
  note('Grep prepareWorktree', 'Grep'),
  turn({ input: 1_000, cacheRead: 20_000, cacheCreation: 5_000, output: 300 }),
  note('Edit src/a.ts', 'Edit'),
  note('thinking › now the tests', 'Thinking'),
  turn({ input: 1_200, cacheRead: 30_000, output: 500 }),
  { ts, kind: 'result', text: 'done', tokensIn: 52_200, tokensOut: 800 }, // the CLI's CUMULATIVE result
];

/** An opencode-shaped stream: tool parts (`read`), turnUsage once per completed message. */
const opencodeFixture: readonly NormalizedEvent[] = [
  note('read src/a.ts', 'read'),
  note('glob **/*.spec.ts', 'glob'),
  turn({ input: 800, cacheRead: 0, output: 210 }),
  note('write src/b.ts', 'write'),
  turn({ input: 900, cacheRead: 12_000, cacheCreation: 900, output: 420 }),
  { ts, kind: 'usage', tokensIn: 13_700, tokensOut: 630 }, // the session's CUMULATIVE tokens
];

describe('telemetryFromEvents — per-adapter fixtures', () => {
  it('claude-code: sums equal the per-turn sums, not the cumulative result', () => {
    const t = telemetryFromEvents(claudeFixture);
    expect(t.usage).toEqual({ input: 2_200, cacheRead: 50_000, cacheCreation: 5_000, output: 800 });
    expect(t.turns).toBe(2);
    // The aggregate (52_200+800) must not leak in anywhere.
    expect(t.lastTurnContext).not.toBe(52_200);
  });

  it('claude-code: lastTurnContext is the LAST turn only — 1_200 + 30_000, no cache creation reported there', () => {
    expect(telemetryFromEvents(claudeFixture).lastTurnContext).toBe(31_200);
  });

  it('opencode: sums equal the per-message tokens, not the cumulative session usage', () => {
    const t = telemetryFromEvents(opencodeFixture);
    expect(t.usage).toEqual({ input: 1_700, cacheRead: 12_000, cacheCreation: 900, output: 630 });
    expect(t.lastTurnContext).toBe(900 + 12_000 + 900);
    expect(t.turns).toBe(2);
  });

  it('readCalls counts read/grep/glob case-insensitively across the adapters', () => {
    expect(telemetryFromEvents(claudeFixture).readCalls).toBe(2);
    expect(telemetryFromEvents(opencodeFixture).readCalls).toBe(2);
    expect([...READ_TOOLS].sort()).toEqual(['glob', 'grep', 'read']);
    expect([...WRITE_TOOLS].sort()).toEqual(['edit', 'write']);
  });

  it('tokensBeforeFirstWrite stops at the turn before the first write/edit', () => {
    // claude: the Edit note arrives before turn 2's usage → turn 2 no longer counts.
    expect(telemetryFromEvents(claudeFixture).tokensBeforeFirstWrite).toBe(26_000);
    // opencode: the write note arrives before turn 2's usage → same rule.
    expect(telemetryFromEvents(opencodeFixture).tokensBeforeFirstWrite).toBe(800);
  });

  it('no write ever came: the full input side counts', () => {
    const t = telemetryFromEvents([turn({ input: 100, cacheRead: 50 }), turn({ input: 10 })]);
    expect(t.tokensBeforeFirstWrite).toBe(160);
    expect(t.lastTurnContext).toBe(10);
  });

  it('no usage at all: nulls everywhere, but readCalls still counts', () => {
    const t = telemetryFromEvents([note('read src/a.ts', 'read'), note('grep foo', 'grep'), { ts, kind: 'text', text: 'hi' }]);
    expect(t.usage).toEqual({ input: null, cacheRead: null, cacheCreation: null, output: null });
    expect(t.lastTurnContext).toBeNull();
    expect(t.tokensBeforeFirstWrite).toBeNull();
    expect(t.turns).toBe(0);
    expect(t.readCalls).toBe(2);
  });

  it('a counter reported by no turn stays null; one that appears late is summed from then on', () => {
    const t = telemetryFromEvents([turn({ input: 10, output: 5 }), turn({ input: 5, cacheRead: 7 })]);
    expect(t.usage).toEqual({ input: 15, cacheRead: 7, cacheCreation: null, output: 5 });
  });

  it('zero is a measurement and survives; the empty stream reports nothing', () => {
    const t = telemetryFromEvents([turn({ input: 0, output: 0 })]);
    expect(t.usage).toEqual({ input: 0, cacheRead: null, cacheCreation: null, output: 0 });
    expect(telemetryFromEvents([])).toEqual({
      usage: { input: null, cacheRead: null, cacheCreation: null, output: null },
      lastTurnContext: null,
      turns: 0,
      readCalls: 0,
      tokensBeforeFirstWrite: null,
    });
  });

  it('a restored fold (an adopted run) continues the persisted numbers', () => {
    const before = telemetryFromEvents(claudeFixture);
    const fold = new TelemetryFold(before);
    fold.apply(turn({ input: 50, output: 10 }));
    const after = fold.get();
    expect(after.turns).toBe(3);
    expect(after.usage.input).toBe(2_250);
    // The fixture's first write already happened: later turns count into the total, not beforeFirstWrite.
    expect(after.tokensBeforeFirstWrite).toBe(26_000);
    expect(after.lastTurnContext).toBe(50);
    // A no-write state restores as one: the next turn still counts as exploration.
    const exploring = new TelemetryFold(telemetryFromEvents([turn({ input: 100 })]));
    exploring.apply(turn({ input: 20 }));
    expect(exploring.get().tokensBeforeFirstWrite).toBe(120);
  });
});
