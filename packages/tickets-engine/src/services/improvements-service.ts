/**
 * The self-improvement loop's aggregation step (E6, concept §4.8): the
 * recurring 1:1 the concept runs per persona. The workers write friction
 * lines; this service watches for runs settling (`onRunsSettled`, wired
 * to fleet changes by the engine), and when a persona's friction log
 * crosses the threshold — 3 findings, or 3 findings plus 5 settled runs
 * since the last aggregation — it asks the LLM (through the same bridge
 * the mission chat uses, under AGGREGATOR_SYSTEM_PROMPT) for improvement
 * drafts, validates them against core/improvements' strict reader, and
 * hands the survivors to the board's applyAggregation — the board
 * service's single-writer queue owns the improvements.md write and its
 * one commit.
 *
 * The service never writes itself and never throws: a broken read, a
 * malformed reply or a refused apply each log one line and leave the
 * persona for the next sweep.
 */
import type { ChatBridge } from '../contracts/chat';
import {
  IMPROVEMENTS_THRESHOLD,
  validateDraft,
  type FrictionLine,
  type ImprovementDraft,
} from '../core/improvements';

/** A repeat aggregation waits for this many settled runs after the last one. */
const SETTLED_RUNS_THRESHOLD = 5;
/** The prompt carries at most this many friction lines (the most recent). */
const PROMPT_FRICTION_CAP = 20;

/** What the board hands the service per persona: the aggregation's input. */
export interface PersonaImprovementInput {
  readonly friction: readonly FrictionLine[];
  /** ISO stamp of the last applied aggregation; null when never. */
  readonly lastAggregation: string | null;
  /** Settled runs since the last aggregation — the run history's digest. */
  readonly settledRuns: number;
}

/** The board surface the service composes — the board service implements
 *  this port on top of its single-writer queue (one commit per apply). */
export interface PersonaImprovementsPort {
  /** Every persona id on the board, sorted. */
  listPersonaIds(): Promise<readonly string[]>;
  /** The persona's friction log, last aggregation stamp and settled-run count. */
  improvementInput(personaId: string): Promise<PersonaImprovementInput>;
  /** Persists the aggregation's drafts into improvements.md and moves lastAggregation to `now`. */
  applyAggregation(
    personaId: string,
    drafts: readonly ImprovementDraft[],
    now: Date,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>;
}

export interface ImprovementsServiceDeps {
  readonly board: PersonaImprovementsPort;
  /** The LLM seam (E5b): one turn, under the aggregator's system prompt. */
  readonly bridge: ChatBridge;
  /** Fires when fleet runs settle; returns the unsubscribe. The engine wires it to fleet changes. */
  readonly onRunsSettled: (listener: () => void) => () => void;
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** The clock; applyAggregation stamps the aggregation with it. */
  readonly now?: () => Date;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The canonical friction rendering (the parse grammar's line, round-tripped). */
function formatFrictionLine(line: FrictionLine): string {
  return line.ticket === null ? `- ${line.at} · ${line.text}` : `- ${line.at} · ${line.ticket} · ${line.text}`;
}

/** The turn's user message: the friction lines (capped, most recent last) plus the run history. */
function promptText(personaId: string, input: PersonaImprovementInput): string {
  const lines = input.friction.slice(-PROMPT_FRICTION_CAP).map(formatFrictionLine);
  return [
    `Persona: ${personaId}`,
    '',
    'Friction lines (date · ticket · finding), most recent last:',
    ...lines,
    '',
    'Run history:',
    `- ${input.settledRuns} run(s) settled since the last aggregation`,
  ].join('\n');
}

/** The digest the system prompt embeds below itself — the input's shape, not its bulk. */
function inputDigest(personaId: string, input: PersonaImprovementInput): string {
  return [
    `persona: ${personaId}`,
    `friction findings: ${input.friction.length}`,
    `last aggregation: ${input.lastAggregation ?? 'never'}`,
    `settled runs: ${input.settledRuns}`,
  ].join('\n');
}

/**
 * The first balanced `[`…`]` slice, string-aware (a `]` inside a quoted
 * evidence line must not cut the array short); null when the reply holds
 * no complete array.
 */
export function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export class ImprovementsService {
  private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  private readonly now: () => Date;
  /** The personas with an aggregation in flight — one at a time per persona. */
  private readonly inFlight = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: ImprovementsServiceDeps) {
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Subscribes to run settles (once) and runs one boot sweep over every
   * persona — the engine awaits the returned promise, so the startup IO
   * settles before it starts listening. Sweeps re-enter safely: the
   * in-flight set and the board's lastAggregation marker do the de-duping.
   */
  start(): Promise<void> {
    if (this.unsubscribe === null) {
      this.unsubscribe = this.deps.onRunsSettled(() => void this.sweepSafely());
    }
    return this.sweepSafely();
  }

  /** Stops listening; aggregations in flight finish on their own. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async sweepSafely(): Promise<void> {
    try {
      const ids = await this.deps.board.listPersonaIds();
      for (const id of ids) {
        await this.maybeAggregate(id);
      }
    } catch (error) {
      this.log(`improvements sweep failed: ${messageOf(error)}`, 'error');
    }
  }

  private async maybeAggregate(personaId: string): Promise<void> {
    if (this.inFlight.has(personaId)) {
      return;
    }
    let input: PersonaImprovementInput;
    try {
      input = await this.deps.board.improvementInput(personaId);
    } catch (error) {
      this.log(`improvements: ${personaId}: input read failed: ${messageOf(error)}`, 'warn');
      return;
    }
    if (input.friction.length < IMPROVEMENTS_THRESHOLD) {
      return;
    }
    if (input.lastAggregation !== null && input.settledRuns < SETTLED_RUNS_THRESHOLD) {
      return;
    }
    this.inFlight.add(personaId);
    try {
      await this.aggregate(personaId, input);
    } catch (error) {
      this.log(`improvements: ${personaId}: aggregation failed: ${messageOf(error)}`, 'warn');
    } finally {
      this.inFlight.delete(personaId);
    }
  }

  private async aggregate(personaId: string, input: PersonaImprovementInput): Promise<void> {
    const reply = await this.deps.bridge.runTurn({
      text: promptText(personaId, input),
      history: [],
      board: inputDigest(personaId, input),
      emit: () => undefined,
    });
    const slice = extractJsonArray(reply.say);
    if (slice === null) {
      this.log(`improvements: ${personaId}: the aggregator's reply held no JSON array — left for the next sweep`, 'warn');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(slice) as unknown;
    } catch {
      this.log(`improvements: ${personaId}: the aggregator's reply was not parseable JSON — left for the next sweep`, 'warn');
      return;
    }
    if (!Array.isArray(raw)) {
      this.log(`improvements: ${personaId}: the aggregator's reply was not a JSON array — left for the next sweep`, 'warn');
      return;
    }
    const drafts: ImprovementDraft[] = [];
    let dropped = 0;
    for (const entry of raw) {
      const draft = validateDraft(entry);
      if (draft === null) {
        dropped += 1;
      } else {
        drafts.push(draft);
      }
    }
    const applied = await this.deps.board.applyAggregation(personaId, drafts, this.now());
    if (!applied.ok) {
      this.log(`improvements: ${personaId}: apply failed: ${applied.error ?? 'unknown error'}`, 'warn');
      return;
    }
    if (dropped > 0) {
      this.log(`improvements: ${personaId}: ${dropped} draft(s) failed validation and were dropped`, 'info');
    }
    this.log(`improvements: ${personaId}: aggregated ${drafts.length} draft(s)`, 'info');
  }
}
