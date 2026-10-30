/**
 * The takeover tab's transcript: a run's normalized stream (`stream.jsonl`,
 * one JSON event per line — the same shape for every provider) rendered
 * once as Markdown for the host's Markdown view. The formatting itself
 * lives in `watch-format.ts` (`formatWatch` — the shared view model);
 * this is the NDJSON in, Markdown out front door. Pure: no DOM.
 */
export { YOU_PREFIX, THINK_PREFIX, RESULT_PREFIX } from './watch-format';

import { formatWatch, parseStreamEvents, renderWatchMarkdown } from './watch-format';

/** The whole stream as one Markdown transcript. */
export function transcriptMarkdown(ndjson: string): string {
  return renderWatchMarkdown(formatWatch(parseStreamEvents(ndjson)));
}
