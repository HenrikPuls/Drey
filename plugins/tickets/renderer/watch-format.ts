/**
 * The watch view's formatter (T-0051): a run's normalized stream
 * (`stream.jsonl`, one event per line — the same shape for every
 * provider) as a transcript view model. Pure, DOM-free: the takeover
 * tab draws the blocks as its own DOM (`transcript-view.ts`, req-58,
 * from the `step` / `thought` data), `transcript.ts` keeps the whole
 * view as one Markdown document.
 *
 * Layout like Claude Code's own transcript: replies as paragraphs, every
 * tool call one `● Tool target` step (a run of steps stays together),
 * thinking as a folded callout, run setup folded into a muted line, the
 * owner's prompts as `›` quotes, the closing result / errors set off by
 * a rule. Live turns read continuously: `text-delta` events grow a
 * block that the sealing delta (`detail: 'end'`, carrying the whole
 * part) replaces, and `tool` events mark a call running before its input
 * is known.
 */
import type { NormalizedEvent } from '../../../packages/tickets-engine/src/fleet/providers';

/** The owner's own prompts ride the stream as notes with this lead-in. */
export const YOU_PREFIX = 'you › ';

/** The worker's thinking rides the stream as notes with this lead-in (mirrors providers.ts). */
export const THINK_PREFIX = 'thinking › ';

/** A tool's outcome rides the stream with this lead-in (mirrors providers.ts). */
export const RESULT_PREFIX = 'result › ';

/** A tool call as data (req-58): the DOM view draws it without parsing Markdown. */
export interface WatchStep {
  /** The tool's display name, capitalized (`Read`). */
  readonly name: string;
  /** What it was called on (`src/a.ts`); empty while the input is unknown. */
  readonly target: string;
  /** The one-line outcome, once the call settled. */
  readonly outcome?: string;
  /** The call settled as failed. */
  readonly failed?: boolean;
  /** An edit or write: the lines it adds and removes. */
  readonly changes?: { readonly added: number; readonly removed: number };
}

/** One rendered block of the transcript. */
export interface WatchBlock {
  readonly kind: 'text' | 'step' | 'thinking' | 'you' | 'setup' | 'system' | 'diagnostic' | 'result' | 'error';
  /** The block's Markdown; step blocks are `● **Read** \`src/a.ts\`` lines. */
  readonly markdown: string;
  /** A step block's call as data. */
  readonly step?: WatchStep;
  /** A thinking block's whole thought, the worker's line breaks kept. */
  readonly thought?: string;
  /** The plain text of a `you`, `setup` or `error` block, or a result's own body. */
  readonly text?: string;
  /** A text delta run another event cut off before its seal; the seal replaces it. */
  readonly fragment?: boolean;
  /** True while the block still streams (an unsealed text-delta run, a running tool call). */
  readonly live?: boolean;
  /** A step's tool name (settling outcomes find their call by it). */
  readonly tool?: string;
  /** A step that already carries its outcome. */
  readonly settled?: boolean;
  /** The event's own timestamp (ISO) — steps and system notes show it as a clock time. */
  readonly at?: string;
  /** A system note's weight: plain information, a warning, or a failure. */
  readonly tone?: 'info' | 'warn' | 'error';
  /** A result that only closes an interrupted turn: the run is paused, not finished. */
  readonly paused?: boolean;
}

/** The run's own usage as the last usage event reported it. */
export interface WatchUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd?: number;
}

/** The watch view model: blocks plus the numbers the footer line shows. */
export interface WatchView {
  readonly blocks: readonly WatchBlock[];
  readonly lastUsage?: WatchUsage;
  /** First event to last event; 0 for an empty or unstamped stream. */
  readonly elapsedMs: number;
}

/** Parses one stream file (NDJSON), skipping blank and unparseable lines. */
export function parseStreamEvents(ndjson: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const raw of ndjson.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    try {
      const event = JSON.parse(line) as NormalizedEvent;
      if (typeof event === 'object' && event !== null) {
        events.push(event);
      }
    } catch {
      // a torn tail line — the next pull brings it whole
    }
  }
  return events;
}

/** Run lifecycle notes the runner and worker adapters write: setup, gate checks, the end (not a tool call). */
const SETUP_NOTE = /^(run R-|run finished|gate: |opencode serve|re-attached|worktree links:)/i;

/**
 * The runner's own lines in streams written before they carried
 * `detail: 'runner'` — the owner's controls, the reaper, the gate, the
 * watchdog. Newer streams mark them; this keeps old runs readable.
 */
const RUNNER_NOTE =
  /^(turn interrupted|taken over|handed back|steer \(|answered by|approved |rejected by|lease reaper|worker ended|machine gate|the gate passed|second opinion|interactive dialog|reopened session|session reopened|looks stuck|run limit|hung:|the resume failed|handover |context window|context cap|stopped by)/i;

/** The runner lines that report a failure. */
const RUNNER_ERROR = /^(lease reaper|worker ended|machine gate failed|the gate passed but|run limit|hung:|the resume failed)/i;

/** The runner lines that report something unusual but not a failure. */
const RUNNER_WARN = /^(looks stuck|turn interrupted|taken over|stopped by)/i;

/** The runner line that says the owner paused the turn. */
const INTERRUPT_NOTE = /^turn interrupted/i;

/** A clock time (`HH:MM`, local) from an event's ISO stamp, or '' when unstamped. */
export function clockTime(ts: string | undefined): string {
  const ms = ts === undefined ? Number.NaN : Date.parse(ts);
  if (Number.isNaN(ms)) {
    return '';
  }
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** How much of a thought its folded title previews. */
const THINK_PREVIEW = 100;

/** Collapses a text to the one-line preview (no backticks, no line breaks). */
const flat = (text: string): string => text.replace(/`/g, "'").replace(/\s+/g, ' ').trim();

/**
 * A thought as a folded callout (req-54): the title previews its opening,
 * a click unfolds the whole thought. The body keeps the worker's line
 * breaks, each line quoted into the callout.
 */
const thinkingBlock = (raw: string): string => {
  const preview = flat(raw);
  const title = preview.length > THINK_PREVIEW ? `${preview.slice(0, THINK_PREVIEW).trimEnd()}…` : preview;
  const body = raw
    .trim()
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
    .join('\n');
  return `> [!QUOTE]- Thinking — ${title}\n${body}`;
};

/** `read src/a.ts` as `{ name: 'Read', target: 'src/a.ts' }`. */
const toolParts = (text: string): WatchStep => {
  const [verb = '', ...rest] = flat(text).split(' ');
  return { name: verb.charAt(0).toUpperCase() + verb.slice(1), target: rest.join(' ') };
};

/** `read src/a.ts` becomes `● **Read** \`src/a.ts\`` — a tool call as Claude Code shows it. */
const toolLine = (step: WatchStep): string =>
  step.target === '' ? `● **${step.name}**` : `● **${step.name}** \`${step.target}\``;

/** `result › 42 lines` (or the same line on a `tool` event) as the `⎿` line under its call. */
const outcomeLine = (outcome: string, failed: boolean): string => `⎿ _${failed ? 'failed: ' : ''}${outcome}_`;

/** A step settled with its outcome: the data and the Markdown line together. */
const settle = (block: WatchBlock, raw: string, failed: boolean): WatchBlock => {
  const outcome = flat(raw);
  const base = block.step ?? { name: '', target: '' };
  return {
    ...block,
    kind: 'step',
    markdown: `${block.markdown}  \n${outcomeLine(outcome, failed)}`,
    step: { ...base, outcome, ...(failed ? { failed: true } : {}) },
    settled: true,
    live: false,
  };
};

/** The running marker of a call whose input is not known yet. */
const RUNNING_SUFFIX = ' _…_';

/**
 * Formats the stream into the watch view model. Unknown event kinds
 * (older streams know fewer, newer may add some) are ignored — a block
 * the formatter does not understand never breaks the transcript.
 */
export function formatWatch(events: readonly NormalizedEvent[]): WatchView {
  const blocks: WatchBlock[] = [];
  let lastUsage: WatchUsage | undefined;
  let lastText = '';
  /** The owner paused the turn: the result that follows closes the pause, not the step. */
  let interrupted = false;
  let firstTs: number | null = null;
  let lastTs = 0;

  /** Seals the live text tail (if any) so the next delta starts a new block. */
  const sealLive = (): void => {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.kind === 'text' && last.live === true) {
      blocks[blocks.length - 1] = { ...last, live: false, fragment: true };
    }
  };

  /**
   * A seal whose deltas were cut up by other events (a worker's reply
   * part interleaved with its tool calls): the whole part takes the place
   * of its first fragment, the other fragments go. False when no fragment
   * belongs to it.
   */
  const sealFragments = (text: string): boolean => {
    const whole = text.replace(/\s+/g, ' ');
    let first = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!;
      const piece = block.markdown.replace(/\s+/g, ' ').trim();
      if (block.kind === 'text' && block.fragment === true && piece !== '' && whole.includes(piece)) {
        if (first >= 0) {
          blocks.splice(first, 1);
        }
        first = i;
      }
    }
    if (first < 0) {
      return false;
    }
    blocks[first] = { kind: 'text', markdown: text };
    return true;
  };

  /** Where the trailing run of steps starts (`blocks.length` when the tail is no step). */
  const tailRunStart = (): number => {
    let i = blocks.length;
    while (i > 0 && blocks[i - 1]!.kind === 'step') {
      i -= 1;
    }
    return i;
  };

  /** A running call whose input is not known yet. */
  const isPlaceholder = (block: WatchBlock): boolean => block.live === true && block.step?.target === '';

  /** The earliest step of `tool` in the trailing run that `match` accepts — parallel calls settle in call order. */
  const firstInTailRun = (tool: string, match: (block: WatchBlock) => boolean): number => {
    for (let i = tailRunStart(); i < blocks.length; i++) {
      if (blocks[i]!.tool === tool && match(blocks[i]!)) {
        return i;
      }
    }
    return -1;
  };

  /**
   * The unsettled step of `tool` its outcome hangs under: the call whose
   * target the outcome names (parallel calls finish in any order), else
   * call order, else the last one anywhere.
   */
  const openStepOf = (tool: string, outcome: string): number => {
    const unsettled = (block: WatchBlock): boolean => block.settled !== true;
    const said = flat(outcome).toLowerCase();
    // The longest named target wins (`src/main` over `src`).
    let at = -1;
    for (let i = tailRunStart(); i < blocks.length; i++) {
      const target = blocks[i]!.step?.target.toLowerCase() ?? '';
      if (blocks[i]!.tool === tool && unsettled(blocks[i]!) && target !== '' && said.includes(target) && (at < 0 || target.length > blocks[at]!.step!.target.length)) {
        at = i;
      }
    }
    if (at < 0) {
      at = firstInTailRun(tool, (block) => unsettled(block) && !isPlaceholder(block));
    }
    if (at < 0) {
      at = firstInTailRun(tool, unsettled);
    }
    for (let i = blocks.length - 1; i >= 0 && at < 0; i--) {
      const block = blocks[i]!;
      if (block.kind === 'step' && block.tool === tool && unsettled(block)) {
        at = i;
      }
    }
    return at;
  };

  for (const event of events) {
    const ts = Date.parse(event.ts);
    if (!Number.isNaN(ts)) {
      firstTs ??= ts;
      lastTs = ts;
    }
    switch (event.kind) {
      case 'text': {
        const text = (event.text ?? '').trim();
        if (text === '') {
          break;
        }
        sealLive();
        blocks.push({ kind: 'text', markdown: text });
        lastText = text;
        break;
      }
      case 'text-delta': {
        const text = event.text ?? '';
        const last = blocks[blocks.length - 1];
        if (event.detail === 'end') {
          // The seal carries the WHOLE part — it replaces whatever the
          // (throttled) deltas assembled.
          if (last !== undefined && last.kind === 'text' && last.live === true) {
            blocks.pop();
          }
          if (!sealFragments(text)) {
            blocks.push({ kind: 'text', markdown: text });
          }
          if (text.trim() !== '') {
            lastText = text;
          }
        } else if (text !== '') {
          if (last !== undefined && last.kind === 'text' && last.live === true) {
            blocks[blocks.length - 1] = { kind: 'text', markdown: last.markdown + text, live: true };
          } else {
            sealLive();
            blocks.push({ kind: 'text', markdown: text, live: true });
          }
        }
        break;
      }
      case 'note': {
        const text = (event.text ?? '').trim();
        if (text === '') {
          break;
        }
        sealLive();
        if (text.startsWith(THINK_PREFIX)) {
          const thought = text.slice(THINK_PREFIX.length).trim();
          blocks.push({ kind: 'thinking', markdown: thinkingBlock(thought), thought });
        } else if (text.startsWith(RESULT_PREFIX)) {
          // A tool outcome (the claude-code stream language): it hangs under
          // the newest step that is still waiting for one.
          let at = -1;
          for (let i = blocks.length - 1; i >= 0 && at < 0; i--) {
            const block = blocks[i]!;
            if (block.kind === 'step' && block.settled !== true) {
              at = i;
            }
          }
          if (at >= 0) {
            blocks[at] = settle(blocks[at]!, text.slice(RESULT_PREFIX.length), false);
          }
        } else if (text.startsWith(YOU_PREFIX)) {
          const said = text.slice(YOU_PREFIX.length);
          interrupted = false;
          blocks.push({ kind: 'you', markdown: `> **›** ${said.replace(/\n/g, '\n> ')}`, text: said });
        } else if (SETUP_NOTE.test(text)) {
          blocks.push({ kind: 'setup', markdown: `<sub>${flat(text)}</sub>`, text: flat(text) });
        } else if (event.detail === 'runner' || RUNNER_NOTE.test(text)) {
          // The runner talking (owner controls, reaper, gate, watchdog) — a
          // system line, never a fake tool call.
          const line = flat(text);
          if (INTERRUPT_NOTE.test(line)) {
            interrupted = true;
          }
          blocks.push({
            kind: 'system',
            markdown: `_${line}_`,
            text: line,
            tone: RUNNER_ERROR.test(line) ? 'error' : RUNNER_WARN.test(line) ? 'warn' : 'info',
            at: event.ts,
          });
        } else if (event.detail === 'stderr') {
          // The provider's own stderr or an unparseable line: kept, folded.
          blocks.push({ kind: 'diagnostic', markdown: flat(text), text: flat(text), at: event.ts });
        } else {
          const step: WatchStep = { ...toolParts(text), ...(event.changes !== undefined ? { changes: event.changes } : {}) };
          blocks.push({ kind: 'step', markdown: toolLine(step), step, tool: text.split(' ')[0], at: event.ts });
        }
        break;
      }
      case 'tool': {
        const text = (event.text ?? '').trim();
        const tool = event.tool ?? 'tool';
        sealLive();
        if (event.detail === 'running') {
          const step = toolParts(tool);
          blocks.push({ kind: 'step', markdown: `${toolLine(step)}${RUNNING_SUFFIX}`, step, live: true, tool, at: event.ts });
        } else if (text.startsWith(RESULT_PREFIX)) {
          // The call settling: the outcome hangs under its own step (matched
          // by tool name — the stream carries no call ids).
          const at = openStepOf(tool, text.slice(RESULT_PREFIX.length));
          if (at >= 0) {
            blocks[at] = settle(blocks[at]!, text.slice(RESULT_PREFIX.length), event.detail === 'failed');
          }
        } else if (text !== '') {
          // The call with its input — replaces the earliest bare running step
          // of the same tool in the run of steps above (same call, now
          // enriched; parallel calls announce in order).
          const step = toolParts(text);
          const at = firstInTailRun(tool, isPlaceholder);
          if (at >= 0) {
            blocks[at] = { kind: 'step', markdown: toolLine(step), step, tool, at: blocks[at]!.at ?? event.ts };
          } else {
            blocks.push({ kind: 'step', markdown: toolLine(step), step, tool, at: event.ts });
          }
        }
        break;
      }
      case 'result': {
        const text = (event.text ?? '').trim();
        sealLive();
        // The turn is over: nothing runs any more. A call that never told
        // its input carries nothing worth showing.
        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i]!;
          if (block.kind === 'step' && block.live === true) {
            if (isPlaceholder(block) && block.settled !== true) {
              blocks.splice(i, 1);
            } else {
              blocks[i] = { ...block, live: false };
            }
          }
        }
        if (interrupted) {
          // The interrupt's own result: the worker stands, the run is paused.
          interrupted = false;
          blocks.push({ kind: 'result', markdown: '---\n\n**⏸ Paused**', paused: true, at: event.ts });
          break;
        }
        blocks.push({
          kind: 'result',
          markdown: text === '' || text === lastText ? '---\n\n**✓ Turn finished**' : `---\n\n**✓ Turn finished**\n\n${text}`,
          ...(text === '' || text === lastText ? {} : { text }),
          at: event.ts,
        });
        break;
      }
      case 'error': {
        const text = (event.text ?? '').trim();
        sealLive();
        if (text !== '') {
          blocks.push({ kind: 'error', markdown: `**✗ Error** — ${text}`, text });
        }
        break;
      }
      case 'usage': {
        if (event.tokensIn !== undefined && event.tokensOut !== undefined) {
          lastUsage = {
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          };
        }
        break;
      }
      default:
        break;
    }
  }
  return {
    blocks,
    ...(lastUsage !== undefined ? { lastUsage } : {}),
    elapsedMs: firstTs === null ? 0 : Math.max(0, lastTs - firstTs),
  };
}

/**
 * The view model as one Markdown document (the takeover tab's transcript
 * is this, rendered by the host's Markdown view): blocks separated by a
 * blank line, a run of tool steps kept together on shared lines.
 */
export function renderWatchMarkdown(view: WatchView): string {
  let out = '';
  let afterStep = false;
  for (const block of view.blocks) {
    if (out === '') {
      out = block.markdown;
    } else {
      out += (afterStep && block.kind === 'step' ? '  \n' : '\n\n') + block.markdown;
    }
    afterStep = block.kind === 'step';
  }
  return out;
}
