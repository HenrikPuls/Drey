import { describe, expect, it } from 'vitest';
import type { ChatBridge } from '../contracts/chat';
import type { FrictionLine, ImprovementDraft } from '../core/improvements';
import {
  ImprovementsService,
  extractJsonArray,
  type PersonaImprovementInput,
  type PersonaImprovementsPort,
} from './improvements-service';

/**
 * The improvement aggregator (E6, concept §4.8): a sweep per persona when
 * runs settle — friction ≥ 3 triggers the first aggregation, then 5 more
 * settled runs before the next. The turn's reply parses as one JSON
 * array, every draft passes core/improvements' strict validateDraft
 * (invalid ones drop, counted), and the survivors reach the board's
 * applyAggregation once — which moves lastAggregation forward, so the
 * next sweep finds nothing to do. Fakes prove the thresholds, the
 * validation, the no-double-run guard and the boot sweep's idempotence.
 */

const NOW = new Date('2026-11-02T12:00:00Z');

/** One flush past every pending microtask — the fakes resolve synchronously. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function friction(count: number, text = (i: number) => `finding ${i + 1}`): readonly FrictionLine[] {
  return Array.from({ length: count }, (_, i) => ({
    at: `2026-10-${String((i % 27) + 1).padStart(2, '0')}`,
    ticket: i % 2 === 0 ? `T-${String(100 + i)}` : null,
    text: text(i),
  }));
}

function input(overrides: Partial<PersonaImprovementInput> = {}): PersonaImprovementInput {
  return { friction: friction(3), lastAggregation: null, settledRuns: 0, ...overrides };
}

interface RecordedApply {
  readonly personaId: string;
  readonly drafts: readonly ImprovementDraft[];
  readonly now: Date;
}

/** The board fake: scripted inputs, and an apply that moves the marker forward like the real board. */
function fakeBoard(initial: Record<string, PersonaImprovementInput>) {
  const state = new Map<string, PersonaImprovementInput>(Object.entries(initial));
  const applies: RecordedApply[] = [];
  const failingReads = new Set<string>();
  const board: PersonaImprovementsPort & {
    state: Map<string, PersonaImprovementInput>;
    applies: RecordedApply[];
    failReadsFor(id: string): void;
  } = {
    state,
    applies,
    failReadsFor: (id) => failingReads.add(id),
    async listPersonaIds() {
      return [...state.keys()].sort();
    },
    async improvementInput(personaId) {
      if (failingReads.has(personaId)) {
        throw new Error('disk gone');
      }
      const found = state.get(personaId);
      if (found === undefined) {
        throw new Error(`no persona ${personaId}`);
      }
      return found;
    },
    async applyAggregation(personaId, drafts, now) {
      applies.push({ personaId, drafts, now });
      const current = state.get(personaId);
      if (current !== undefined) {
        state.set(personaId, { ...current, lastAggregation: now.toISOString(), settledRuns: 0 });
      }
      return { ok: true };
    },
  };
  return board;
}

type TurnInput = Parameters<ChatBridge['runTurn']>[0];

/** The bridge fake: scripted replies, one call at a time. */
function fakeBridge(replies: string[]) {
  const calls: TurnInput[] = [];
  const bridge: ChatBridge & { calls: TurnInput[] } = {
    calls,
    async runTurn(call) {
      calls.push(call);
      return { say: replies.shift() ?? '[]', thought: null, commands: [] };
    },
  };
  return bridge;
}

/** The settle seam fake: the engine's fleet-changes wiring stands in as a manual fire. */
function fakeRunsSettled() {
  const listeners = new Set<() => void>();
  return {
    onRunsSettled: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fire: (): void => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

interface LogLine {
  readonly message: string;
  readonly level?: 'info' | 'warn' | 'error';
}

function setup(initial: Record<string, PersonaImprovementInput>, replies: string[] = []) {
  const board = fakeBoard(initial);
  const bridge = fakeBridge(replies);
  const settled = fakeRunsSettled();
  const logs: LogLine[] = [];
  const service = new ImprovementsService({
    board,
    bridge,
    onRunsSettled: settled.onRunsSettled,
    log: (message, level) => logs.push({ message, level }),
    now: () => NOW,
  });
  return { board, bridge, settled, logs, service };
}

describe('ImprovementsService', () => {
  it('aggregates a persona whose friction log crosses the threshold — first run needs no settled runs', async () => {
    const { board, bridge, logs, service } = setup({
      pia: input({ friction: friction(3, (i) => `guessed shape ${i}`) }),
    });

    await service.start();

    expect(bridge.calls).toHaveLength(1);
    const turn = bridge.calls[0]!;
    expect(turn.history).toEqual([]);
    expect(turn.emit({ kind: 'done' })).toBeUndefined();
    expect(turn.text).toContain('- 2026-10-01 · T-100 · guessed shape 0');
    expect(turn.text).toContain('- 2026-10-02 · guessed shape 1');
    expect(turn.text).toContain('0 run(s) settled since the last aggregation');
    expect(turn.board).toContain('persona: pia');
    expect(turn.board).toContain('friction findings: 3');
    expect(board.applies).toHaveLength(1);
    expect(board.applies[0]!.personaId).toBe('pia');
    expect(board.applies[0]!.now).toBe(NOW);
    expect(logs.some((l) => l.level === 'error')).toBe(false);
  });

  it('stays silent below the threshold', async () => {
    const { board, bridge, service } = setup({ pia: input({ friction: friction(2) }) });

    await service.start();

    expect(bridge.calls).toHaveLength(0);
    expect(board.applies).toHaveLength(0);
  });

  it('waits for 5 settled runs after an aggregation before the next one', async () => {
    const { bridge, service } = setup({
      pia: input({ friction: friction(4), lastAggregation: '2026-11-01T00:00:00Z', settledRuns: 4 }),
    });

    await service.start();
    expect(bridge.calls).toHaveLength(0);
  });

  it('re-checks the cadence gate on every settle', async () => {
    const board = fakeBoard({
      pia: input({ friction: friction(4), lastAggregation: '2026-11-01T00:00:00Z', settledRuns: 4 }),
    });
    const bridge = fakeBridge([]);
    const settled = fakeRunsSettled();
    const service = new ImprovementsService({ board, bridge, onRunsSettled: settled.onRunsSettled, now: () => NOW });

    await service.start();
    expect(bridge.calls).toHaveLength(0);

    board.state.set('pia', { ...board.state.get('pia')!, settledRuns: 5 });
    settled.fire();
    await flush();

    expect(bridge.calls).toHaveLength(1);
  });

  it('caps the prompt at the 20 most recent friction lines', async () => {
    const { bridge, service } = setup({ pia: input({ friction: friction(25) }) });

    await service.start();

    const text = bridge.calls[0]!.text;
    expect(text).toContain('finding 25');
    expect(text).not.toContain('- 2026-10-01 · T-100 · finding 1');
    expect(text).toContain('- 2026-10-06 · finding 6');
    expect(text.match(/^- 2026-/gm)).toHaveLength(20);
    expect(bridge.calls[0]!.board).toContain('friction findings: 25');
  });

  it('validates every draft and drops the invalid ones, counted', async () => {
    const reply = JSON.stringify([
      { target: 'prompt.md', title: 'Order the pack', evidence: ['2026-10-01 · T-100 · finding 1'], content: 'Read the pack first.', lesson: 'Keep the recipe explicit.' },
      { target: 'worker', title: 'bogus target', content: 'x' },
      { target: 'prompt.md', title: '', content: 'x' },
    ]);
    const { board, logs, service } = setup({ pia: input() }, [reply]);

    await service.start();

    expect(board.applies).toHaveLength(1);
    expect(board.applies[0]!.drafts).toHaveLength(1);
    expect(board.applies[0]!.drafts[0]).toEqual({
      target: 'prompt.md',
      title: 'Order the pack',
      evidence: ['2026-10-01 · T-100 · finding 1'],
      content: 'Read the pack first.',
      lesson: 'Keep the recipe explicit.',
    });
    expect(logs.some((l) => l.message.includes('2 draft(s) failed validation'))).toBe(true);
  });

  it('applies an empty array — the marker moves forward and nothing is proposed', async () => {
    const { board, service } = setup({ pia: input() }, ['[]']);

    await service.start();

    expect(board.applies).toHaveLength(1);
    expect(board.applies[0]!.drafts).toEqual([]);
  });

  it('extracts the first JSON array slice even from a reply wrapped in prose', async () => {
    const reply = `Here are the drafts:\n[{"target":"memory","title":"Remember the pack","evidence":[],"content":"Read the pack before writing.","lesson":null}]\nDone.`;
    const { board, service } = setup({ pia: input() }, [reply]);

    await service.start();

    expect(board.applies).toHaveLength(1);
    expect(board.applies[0]!.drafts[0]!.target).toBe('memory');
  });

  it('keeps a bracket inside a quoted evidence line from cutting the slice short', () => {
    const slice = extractJsonArray('[{"evidence":["T-0100] slipped"]}]');
    expect(JSON.parse(slice!)).toEqual([{ evidence: ['T-0100] slipped'] }]);
  });

  it('skips the apply and logs when the reply holds no parseable JSON array — and retries on the next sweep', async () => {
    const { board, bridge, logs, service } = setup({ pia: input() }, ['plain prose, no array', '[{"target":"memory","title":"T","evidence":[],"content":"lesson line"}]']);

    await service.start();
    expect(board.applies).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('no JSON array'))).toBe(true);

    await service.start(); // the friction is untouched, the threshold still holds
    expect(board.applies).toHaveLength(1);
    expect(bridge.calls).toHaveLength(2);
  });

  it('logs and clears the in-flight guard when the bridge rejects — a later sweep retries', async () => {
    const calls: TurnInput[] = [];
    let fail = true;
    const bridge: ChatBridge = {
      async runTurn(call) {
        calls.push(call);
        if (fail) {
          throw new Error('provider down');
        }
        return { say: '[]', thought: null, commands: [] };
      },
    };
    const board = fakeBoard({ pia: input() });
    const logs: LogLine[] = [];
    const service = new ImprovementsService({
      board,
      bridge,
      onRunsSettled: () => () => undefined,
      log: (message, level) => logs.push({ message, level }),
      now: () => NOW,
    });

    await service.start();
    expect(board.applies).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('provider down'))).toBe(true);

    fail = false;
    await service.start();
    expect(calls).toHaveLength(2);
    expect(board.applies).toHaveLength(1);
  });

  it('logs a failed input read and moves on to the next persona', async () => {
    const board = fakeBoard({ pia: input(), remy: input() });
    board.failReadsFor('pia');
    const bridge = fakeBridge([]);
    const logs: LogLine[] = [];
    const service = new ImprovementsService({
      board,
      bridge,
      onRunsSettled: () => () => undefined,
      log: (message, level) => logs.push({ message, level }),
      now: () => NOW,
    });

    await service.start();

    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]!.board).toContain('persona: remy');
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('pia') && l.message.includes('disk gone'))).toBe(true);
  });

  it('never runs two aggregations for one persona — a settle during an in-flight turn is a no-op', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: TurnInput[] = [];
    const bridge: ChatBridge = {
      async runTurn(call) {
        calls.push(call);
        await gate;
        return { say: '[]', thought: null, commands: [] };
      },
    };
    const board = fakeBoard({ pia: input() });
    const settled = fakeRunsSettled();
    const service = new ImprovementsService({ board, bridge, onRunsSettled: settled.onRunsSettled, now: () => NOW });

    const boot = service.start();
    await flush();
    expect(calls).toHaveLength(1);

    settled.fire(); // mid-turn: the sweep must skip pia, not queue a second turn
    await flush();
    expect(calls).toHaveLength(1);

    release();
    await boot;
    expect(board.applies).toHaveLength(1);
  });

  it('makes the boot sweep idempotent — the apply moved the marker, so the next sweep does nothing', async () => {
    const { bridge, settled, service } = setup({ pia: input() });

    await service.start();
    expect(bridge.calls).toHaveLength(1);

    settled.fire();
    await flush();
    expect(bridge.calls).toHaveLength(1);
  });

  it('stops listening after dispose', async () => {
    const { bridge, settled, service } = setup({ pia: input() });

    await service.start();
    service.dispose();
    settled.fire();
    await flush();

    expect(bridge.calls).toHaveLength(1);
  });
});
