/**
 * The watch view's formatter (T-0051): a run's normalized stream
 * (`stream.jsonl`, one event per line — the same shape for every
 * provider) as a transcript view model. Pure, DOM-free: the takeover
 * tab renders it through the host's Markdown view
 * (`transcript.ts` delegates here), anything else can render the blocks
 * directly.
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
import type { NormalizedEvent } from '../main/fleet/providers';

/** The owner's own prompts ride the stream as notes with this lead-in. */
export const YOU_PREFIX = 'you › ';

/** The worker's thinking rides the stream as notes with this lead-in (mirrors providers.ts). */
export const THINK_PREFIX = 'thinking › ';

/** A tool's outcome rides the stream with this lead-in (mirrors providers.ts). */
export const RESULT_PREFIX = 'result › ';

/** One rendered block of the transcript. */
export interface WatchBlock {
  readonly kind: 'text' | 'step' | 'thinking' | 'you' | 'setup' | 'result' | 'error';
  /** The block's Markdown; step blocks are `● **Read** \`src/a.ts\`` lines. */
  readonly markdown: string;
  /** True while the block still streams (an unsealed text-delta run, a running tool call). */
  readonly live?: boolean;
  /** A step's tool name (settling outcomes find their call by it). */
  readonly tool?: string;
  /** A step that already carries its outcome. */
  readonly settled?: boolean;
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

/** Run-setup notes the worker adapters write (not a tool call). */
const SETUP_NOTE = /^(run R-|opencode serve|re-attached|worktree links:)/i;

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

/** `read src/a.ts` becomes `● **Read** \`src/a.ts\`` — a tool call as Claude Code shows it. */
const toolLine = (text: string): string => {
  const [verb = '', ...rest] = flat(text).split(' ');
  const name = verb.charAt(0).toUpperCase() + verb.slice(1);
  const target = rest.join(' ');
  return target === '' ? `● **${name}**` : `● **${name}** \`${target}\``;
};

/** `result › 42 lines` (or the same line on a `tool` event) as the `⎿` line under its call. */
const outcomeLine = (raw: string, failed: boolean): string =>
  `&nbsp;&nbsp;⎿ _${failed ? 'failed: ' : ''}${flat(raw)}_`;

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
  let firstTs: number | null = null;
  let lastTs = 0;

  /** Seals the live text tail (if any) so the next delta starts a new block. */
  const sealLive = (): void => {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.kind === 'text' && last.live === true) {
      blocks[blocks.length - 1] = { ...last, live: false };
    }
  };

  /** The last unsettled step of `tool`, if any — where its outcome hangs. */
  const openStepOf = (tool: string): number => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!;
      if (block.kind === 'step' && block.tool === tool && block.settled !== true) {
        return i;
      }
    }
    return -1;
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
            blocks[blocks.length - 1] = { kind: 'text', markdown: text };
          } else {
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
          blocks.push({ kind: 'thinking', markdown: thinkingBlock(text.slice(THINK_PREFIX.length)) });
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
            blocks[at] = {
              ...blocks[at]!,
              kind: 'step',
              markdown: `${blocks[at]!.markdown}  \n${outcomeLine(text.slice(RESULT_PREFIX.length), false)}`,
              settled: true,
            };
          }
        } else if (text.startsWith(YOU_PREFIX)) {
          blocks.push({ kind: 'you', markdown: `> **›** ${text.slice(YOU_PREFIX.length).replace(/\n/g, '\n> ')}` });
        } else if (SETUP_NOTE.test(text)) {
          blocks.push({ kind: 'setup', markdown: `<sub>${flat(text)}</sub>` });
        } else {
          blocks.push({ kind: 'step', markdown: toolLine(text), tool: text.split(' ')[0] });
        }
        break;
      }
      case 'tool': {
        const text = (event.text ?? '').trim();
        const tool = event.tool ?? 'tool';
        sealLive();
        if (event.detail === 'running') {
          blocks.push({ kind: 'step', markdown: `${toolLine(tool)}${RUNNING_SUFFIX}`, live: true, tool });
        } else if (text.startsWith(RESULT_PREFIX)) {
          // The call settling: the outcome hangs under its own step (matched
          // by tool name — the stream carries no call ids).
          const at = openStepOf(tool);
          if (at >= 0) {
            blocks[at] = {
              ...blocks[at]!,
              kind: 'step',
              markdown: `${blocks[at]!.markdown}  \n${outcomeLine(text.slice(RESULT_PREFIX.length), event.detail === 'failed')}`,
              settled: true,
              live: false,
            };
          }
        } else if (text !== '') {
          // The call with its input — replaces the bare running step of the
          // same tool directly above it (same call, now enriched).
          const last = blocks[blocks.length - 1];
          if (last !== undefined && last.kind === 'step' && last.live === true && last.tool === tool) {
            blocks[blocks.length - 1] = { kind: 'step', markdown: toolLine(text), tool };
          } else {
            blocks.push({ kind: 'step', markdown: toolLine(text), tool });
          }
        }
        break;
      }
      case 'result': {
        const text = (event.text ?? '').trim();
        sealLive();
        blocks.push({
          kind: 'result',
          markdown: text === '' || text === lastText ? '---\n\n**✓ Turn finished**' : `---\n\n**✓ Turn finished**\n\n${text}`,
        });
        break;
      }
      case 'error': {
        const text = (event.text ?? '').trim();
        sealLive();
        if (text !== '') {
          blocks.push({ kind: 'error', markdown: `**✗ Error** — ${text}` });
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
