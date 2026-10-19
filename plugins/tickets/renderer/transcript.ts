/**
 * The takeover tab's transcript: a run's normalized stream (`stream.jsonl`,
 * one JSON event per line — the same shape for every provider) rendered
 * once as Markdown for the host's Markdown view. Pure: no DOM.
 */

/** The owner's own prompts ride the stream as notes with this lead-in. */
export const YOU_PREFIX = 'you › ';

/** The worker's thinking rides the stream as notes with this lead-in (mirrors providers.ts). */
export const THINK_PREFIX = 'thinking › ';

/** A tool's outcome (mirrors providers.ts). */
export const RESULT_PREFIX = 'result › ';

interface StreamEvent {
  readonly kind?: string;
  readonly text?: string;
}

const parseLine = (line: string): StreamEvent | null => {
  try {
    const event: unknown = JSON.parse(line);
    return typeof event === 'object' && event !== null ? (event as StreamEvent) : null;
  } catch {
    return null;
  }
};

/** Run-setup notes the worker adapters write (not a tool call). */
const SETUP_NOTE = /^(run R-|opencode serve|re-attached)/i;

/** How much of a thought its folded title previews. */
const THINK_PREVIEW = 100;

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

/** Collapses a note into one line (no backticks, no line breaks). */
const flat = (text: string): string => text.replace(/`/g, "'").replace(/\s+/g, ' ').trim();

/** `read src/a.ts` becomes `● **Read** \`src/a.ts\`` — a tool call as Claude Code shows it. */
const toolLine = (text: string): string => {
  const [verb = '', ...rest] = flat(text).split(' ');
  const name = verb.charAt(0).toUpperCase() + verb.slice(1);
  const target = rest.join(' ');
  return target === '' ? `● **${name}**` : `● **${name}** \`${target}\``;
};

/**
 * Markdown for the stream, laid out like Claude Code's own transcript: the
 * worker's replies as paragraphs, every tool call one `● Tool target` step
 * (a run of steps stays together), thinking as a folded callout, run
 * setup folded into a single muted line, the owner's prompts as `›`
 * quotes, and the closing result / errors set off by a rule. The result
 * body is dropped when the last reply already said it; usage events are
 * numbers the status line carries, not transcript.
 */
export function transcriptMarkdown(ndjson: string): string {
  const blocks: string[] = [];
  let steps: string[] = [];
  let lastText = '';
  const flush = (): void => {
    if (steps.length > 0) {
      blocks.push(steps.join('  \n'));
      steps = [];
    }
  };
  for (const raw of ndjson.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    const event = parseLine(line);
    const text = event?.text?.trim() ?? '';
    if (event === null || text === '') {
      continue;
    }
    switch (event.kind) {
      case 'text':
        flush();
        blocks.push(text);
        lastText = text;
        break;
      case 'note':
        if (text.startsWith(THINK_PREFIX)) {
          flush();
          blocks.push(thinkingBlock(text.slice(THINK_PREFIX.length)));
        } else if (text.startsWith(RESULT_PREFIX)) {
          const outcome = flat(text.slice(RESULT_PREFIX.length));
          if (steps.length > 0 && outcome !== '') {
            steps.push(`&nbsp;&nbsp;⎿ _${outcome}_`);
          }
        } else if (text.startsWith(YOU_PREFIX)) {
          flush();
          blocks.push(`> **›** ${text.slice(YOU_PREFIX.length).replace(/\n/g, '\n> ')}`);
        } else if (SETUP_NOTE.test(text)) {
          flush();
          blocks.push(`<sub>${flat(text)}</sub>`);
        } else {
          steps.push(toolLine(text));
        }
        break;
      case 'result':
        flush();
        blocks.push(text === lastText ? '---\n\n**✓ Turn finished**' : `---\n\n**✓ Turn finished**\n\n${text}`);
        break;
      case 'error':
        flush();
        blocks.push(`**✗ Error** — ${text}`);
        break;
      default:
        break;
    }
  }
  flush();
  return blocks.join('\n\n');
}
