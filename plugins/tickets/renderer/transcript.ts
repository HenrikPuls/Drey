/**
 * The takeover tab's transcript: a run's normalized stream (`stream.jsonl`,
 * one JSON event per line — the same shape for every provider) rendered
 * once as Markdown for the host's Markdown view. Pure: no DOM.
 */

/** The owner's own prompts ride the stream as notes with this lead-in. */
export const YOU_PREFIX = 'you › ';

/** The worker's thinking rides the stream as notes with this lead-in (mirrors providers.ts). */
export const THINK_PREFIX = 'thinking › ';

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

/** Collapses a note into one bullet line (no backticks, no line breaks). */
const noteLine = (text: string): string => `- \`${text.replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;

/**
 * Markdown for the stream: the worker's replies as paragraphs, its tool
 * calls and the run's notes as bullet runs, the owner's prompts as quotes,
 * the final result and errors as bold lead-ins; usage events are numbers
 * the status line carries, not transcript.
 */
export function transcriptMarkdown(ndjson: string): string {
  const blocks: string[] = [];
  let bullets: string[] = [];
  const flush = (): void => {
    if (bullets.length > 0) {
      blocks.push(bullets.join('\n'));
      bullets = [];
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
        break;
      case 'note':
        if (text.startsWith(THINK_PREFIX)) {
          flush();
          blocks.push(`> _${text.slice(THINK_PREFIX.length).replace(/\s+/g, ' ')}_`);
        } else if (text.startsWith(YOU_PREFIX)) {
          flush();
          blocks.push(`> **You** — ${text.slice(YOU_PREFIX.length).replace(/\n/g, '\n> ')}`);
        } else {
          bullets.push(noteLine(text));
        }
        break;
      case 'result':
        flush();
        blocks.push(`**Turn finished**\n\n${text}`);
        break;
      case 'error':
        flush();
        blocks.push(`**Error** — ${text}`);
        break;
      default:
        break;
    }
  }
  flush();
  return blocks.join('\n\n');
}
