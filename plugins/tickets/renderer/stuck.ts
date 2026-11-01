/**
 * The stuck verdict (req-75 W4b): whether a busy worker makes progress,
 * read from its own stream — the same normalized events the transcript
 * shows. Pure: the Workers tab and the ticket thread's header word both
 * draw it, the spec pins it. A verdict is a hint, never an action — the
 * owner picks Nudge, Hand over or Stop.
 */
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import type { NormalizedEvent } from '../../../packages/tickets-engine/src/fleet/providers';
import { READ_TOOLS, WRITE_TOOLS } from '../../../packages/tickets-engine/src/fleet/telemetry';
import { RESULT_PREFIX, THINK_PREFIX, YOU_PREFIX } from './watch-format';

/** No write/edit tool call for this many minutes means stuck. */
export const STUCK_NO_EDIT_MIN = 8;

/** One path read this many times among the last 20 tool calls means stuck. */
export const STUCK_REPEATS = 4;

/** How many trailing tool calls the repeated-reads rule looks at. */
const RECENT_CALLS = 20;

export interface StuckVerdict {
  readonly stuck: boolean;
  /** Whole minutes since the last write/edit call (else the run start); null when the run cannot be stuck. */
  readonly minutesWithoutEdit: number | null;
  /** How often one path was read after the last edit, within the recent window. */
  readonly repeatedReads: number;
}

/** Run lifecycle notes (mirrors watch-format's SETUP_NOTE): never a tool call. */
const SETUP_NOTE = /^(run R-|run finished|gate: |opencode serve|re-attached|worktree links:)/i;

/** The states whose runs the verdict judges (a detached run has no stream to read). */
const JUDGED_STATES: ReadonlySet<string> = new Set(['starting', 'running', 'stopping']);

/** One tool call with its input, as the stream announces it. */
interface ToolCall {
  /** The tool's name, lowercase (the counters' vocabulary). */
  readonly tool: string;
  /** What it was called on — the activity line minus the tool's name. */
  readonly target: string;
  /** The whole activity line (`read src/a.ts`) — a command action's own text. */
  readonly line: string;
  readonly ts: number;
  /** The call's outcome, once a `result ›` line settled it. */
  outcome: string | null;
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The tool calls of a stream, in order: `tool` events that carry their
 * input (opencode) and tool-call notes (claude-code) — the same events
 * the transcript draws as steps. A `result ›` line settles the newest
 * unsettled call (the stream carries no call ids).
 */
function toolCallsOf(events: readonly NormalizedEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) {
    if (event.kind !== 'tool' && event.kind !== 'note') {
      continue;
    }
    const text = flat(event.text ?? '');
    if (text === '') {
      continue;
    }
    if (text.startsWith(RESULT_PREFIX)) {
      const outcome = text.slice(RESULT_PREFIX.length).trim();
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i]!.outcome === null) {
          calls[i]!.outcome = outcome;
          break;
        }
      }
      continue;
    }
    if (event.kind === 'tool' && event.detail === 'running') {
      // The call before its input is known — the input event is the call.
      continue;
    }
    if (event.kind === 'note' && (text.startsWith(YOU_PREFIX) || text.startsWith(THINK_PREFIX) || SETUP_NOTE.test(text))) {
      continue;
    }
    const [first = '', ...rest] = text.split(' ');
    const tool = (event.tool !== undefined && event.tool !== '' ? event.tool : first).toLowerCase();
    calls.push({ tool, target: rest.join(' '), line: text, ts: Date.parse(event.ts), outcome: null });
  }
  return calls;
}

/**
 * A busy, not waiting run is stuck when no write/edit tool call happened
 * for {@link STUCK_NO_EDIT_MIN} minutes (counted from the last edit, else
 * the run start), or one path was read {@link STUCK_REPEATS} times among
 * the last {@link RECENT_CALLS} tool calls without an edit after it.
 * Waiting, idle, detached and ended runs are never stuck.
 */
export function stuckOf(run: RunInfo, events: readonly NormalizedEvent[], nowMs: number): StuckVerdict {
  const none: StuckVerdict = { stuck: false, minutesWithoutEdit: null, repeatedReads: 0 };
  if (!JUDGED_STATES.has(run.state) || run.waiting != null || run.turn === 'idle') {
    return none;
  }
  const calls = toolCallsOf(events);
  let lastEditTs: number | null = null;
  let lastEditIndex = -1;
  calls.forEach((call, index) => {
    if (WRITE_TOOLS.has(call.tool)) {
      lastEditIndex = index;
      if (!Number.isNaN(call.ts)) {
        lastEditTs = call.ts;
      }
    }
  });
  const from = lastEditTs ?? Date.parse(run.startedAt);
  const minutes = Number.isNaN(from) ? null : Math.max(0, Math.floor((nowMs - from) / 60_000));
  // One path read again and again, after the last edit, inside the window.
  const window = calls.slice(-RECENT_CALLS);
  const windowBase = calls.length - window.length;
  const readsAfterEdit = new Map<string, number>();
  window.forEach((call, index) => {
    if (call.tool === 'read' && windowBase + index > lastEditIndex && call.target !== '') {
      readsAfterEdit.set(call.target, (readsAfterEdit.get(call.target) ?? 0) + 1);
    }
  });
  let repeatedReads = 0;
  for (const count of readsAfterEdit.values()) {
    repeatedReads = Math.max(repeatedReads, count);
  }
  return {
    stuck: (minutes !== null && minutes >= STUCK_NO_EDIT_MIN) || repeatedReads >= STUCK_REPEATS,
    minutesWithoutEdit: minutes,
    repeatedReads,
  };
}

/**
 * The last `n` tool calls as short lines: `read <path>`, `edit <path>`
 * for file tools, `<command>   <result>` for the rest — the result once
 * the call settled, the bare command while it runs.
 */
export function recentActions(events: readonly NormalizedEvent[], n: number): readonly string[] {
  if (n <= 0) {
    return [];
  }
  const calls = toolCallsOf(events);
  const lines: string[] = [];
  for (const call of calls.slice(-n)) {
    if (READ_TOOLS.has(call.tool) || WRITE_TOOLS.has(call.tool)) {
      lines.push(call.line);
      continue;
    }
    const command = call.target !== '' ? call.target : call.line;
    lines.push(call.outcome === null ? command : `${command}   ${call.outcome}`);
  }
  return lines;
}
