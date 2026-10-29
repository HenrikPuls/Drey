/**
 * Run token telemetry (T-0048): one fold over the run's normalized
 * stream events, fed by the supervisor's `onEvent`, that turns per-turn
 * usage reports into the numbers the owner decides handover questions
 * with. The providers' cumulative aggregates (`result.usage`, the
 * opencode session tokens) are deliberately NOT inputs here — only the
 * per-model-call `turnUsage` events are, so a cumulative number can
 * never pose as a context size.
 *
 * Absent-never-zero: a counter the provider never reported stays `null`
 * through every sum (0 is a measurement, absence is not).
 */
import type { RunUsage } from './protocol';
import type { NormalizedEvent } from './providers';

/** Tool names that read (claude-code spells `Read`, opencode `read`) — compared lowercase. */
export const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'glob']);

/** Tool names that write — the first one ends the exploration window. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

export interface RunTelemetry {
  /** Summed over the run's turns; null = never reported. */
  readonly usage: RunUsage;
  /** The LAST turn's input+cacheRead+cacheCreation — the real context size. */
  readonly lastTurnContext: number | null;
  /** Model calls that reported usage (the cost-relevant turn). */
  readonly turns: number;
  /** Read/grep/glob tool calls. */
  readonly readCalls: number;
  /**
   * Input-side tokens over the turns completed before the first
   * write/edit tool call; the full input side when no write came;
   * null when no usage was reported at all.
   */
  readonly tokensBeforeFirstWrite: number | null;
}

/** Sums one counter: both absent stays absent, one number wins over absence. */
function sumCounter(a: number | null, b: number | null): number | null {
  if (a === null && b === null) {
    return null;
  }
  return (a ?? 0) + (b ?? 0);
}

/** The turn's input side: input + cacheRead + cacheCreation (absent counts 0). */
function inputSide(usage: RunUsage): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheCreation ?? 0);
}

/**
 * The folding state — one instance per run, applied in event order
 * (tool-call notes of a turn arrive before that turn's usage event, so
 * the first write correctly excludes its own turn's input).
 *
 * `initial` restores a run the runner re-adopted after a restart: the
 * persisted counters come back, and `wrote` is derived from the
 * before-first-write split (strictly less than the input total means a
 * write happened).
 */
export class TelemetryFold {
  private input: number | null = null;
  private cacheRead: number | null = null;
  private cacheCreation: number | null = null;
  private output: number | null = null;
  private turns = 0;
  private readCalls = 0;
  private lastTurnContext: number | null = null;
  private wrote = false;
  private inputBeforeWrite = 0;
  private inputTotal = 0;

  constructor(initial?: RunTelemetry) {
    if (initial !== undefined) {
      this.input = initial.usage.input;
      this.cacheRead = initial.usage.cacheRead;
      this.cacheCreation = initial.usage.cacheCreation;
      this.output = initial.usage.output;
      this.turns = initial.turns;
      this.readCalls = initial.readCalls;
      this.lastTurnContext = initial.lastTurnContext;
      this.inputTotal = inputSide(initial.usage);
      this.inputBeforeWrite = initial.tokensBeforeFirstWrite ?? 0;
      this.wrote = initial.tokensBeforeFirstWrite !== null && initial.tokensBeforeFirstWrite < this.inputTotal;
    }
  }

  apply(event: NormalizedEvent): void {
    if (event.tool !== undefined && event.tool !== '') {
      const tool = event.tool.toLowerCase();
      if (READ_TOOLS.has(tool)) {
        this.readCalls++;
      }
      if (WRITE_TOOLS.has(tool)) {
        this.wrote = true;
      }
    }
    const usage = event.turnUsage;
    if (usage === undefined) {
      return;
    }
    this.input = sumCounter(this.input, usage.input);
    this.cacheRead = sumCounter(this.cacheRead, usage.cacheRead);
    this.cacheCreation = sumCounter(this.cacheCreation, usage.cacheCreation);
    this.output = sumCounter(this.output, usage.output);
    this.turns++;
    const turnInput = inputSide(usage);
    this.lastTurnContext = turnInput;
    this.inputTotal += turnInput;
    if (!this.wrote) {
      this.inputBeforeWrite += turnInput;
    }
  }

  get(): RunTelemetry {
    return {
      usage: {
        input: this.input,
        cacheRead: this.cacheRead,
        cacheCreation: this.cacheCreation,
        output: this.output,
      },
      lastTurnContext: this.lastTurnContext,
      turns: this.turns,
      readCalls: this.readCalls,
      tokensBeforeFirstWrite: this.turns === 0 ? null : this.wrote ? this.inputBeforeWrite : this.inputTotal,
    };
  }
}

/** Folds a whole event list — the specs' fixture entry point. */
export function telemetryFromEvents(events: readonly NormalizedEvent[]): RunTelemetry {
  const fold = new TelemetryFold();
  for (const event of events) {
    fold.apply(event);
  }
  return fold.get();
}
