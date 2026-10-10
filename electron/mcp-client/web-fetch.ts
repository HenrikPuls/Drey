import TurndownService from 'turndown';
import type { ToolSpec } from '../../shared/llm';

export const WEB_FETCH_TOOL_NAME = 'web_fetch';

export const WEB_FETCH_SPEC: ToolSpec = {
  name: WEB_FETCH_TOOL_NAME,
  description:
    'Fetch one web page or text resource by URL (http or https) and return its content as ' +
    'Markdown. Use it to read a page a search result or the user pointed at. It does not ' +
    'search; it reads exactly the URL given.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL.' },
      maxChars: {
        type: 'number',
        description: 'Cap on returned characters (default 12000, max 20000).',
      },
    },
    required: ['url'],
  },
};

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 12_000;
const HARD_MAX_CHARS = 20_000;

/** The URL a call may fetch, or the reason it may not. */
export function parseFetchUrl(raw: unknown): URL | { error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: 'url is required' };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `not a valid URL: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'only http and https URLs can be fetched' };
  }
  return url;
}

/** HTML to Markdown: scripts, styles and page chrome dropped first. */
export function htmlToMarkdown(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, '');
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  turndown.remove(['script', 'style', 'noscript']);
  const markdown = turndown
    .turndown(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title !== '' && !markdown.startsWith('# ') ? `# ${title}\n\n${markdown}` : markdown;
}

/** A fetched body as the text the model reads; `null` for a type it cannot use. */
export function renderFetched(contentType: string, body: string): string | null {
  const type = contentType.toLowerCase();
  if (type.includes('html') || (type === '' && /<html[\s>]/i.test(body.slice(0, 2000)))) {
    return htmlToMarkdown(body);
  }
  if (type === '' || type.startsWith('text/') || /json|xml|javascript|yaml|csv/.test(type)) {
    return body.trim();
  }
  return null;
}

export function capText(text: string, maxChars: unknown): string {
  const limit =
    typeof maxChars === 'number' && maxChars > 0
      ? Math.min(HARD_MAX_CHARS, Math.floor(maxChars))
      : DEFAULT_MAX_CHARS;
  return text.length > limit
    ? `${text.slice(0, limit)}\n[truncated, ${text.length - limit} more characters]`
    : text;
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || value === undefined) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  void reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8');
}

/**
 * The built-in `web_fetch` tool (milestone 63, ADR-0063). Failures come
 * back as text so the model can say what went wrong; only an abort throws.
 */
export async function runWebFetch(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const url = parseFetchUrl(args['url']);
  if (!(url instanceof URL)) {
    return `Error: ${url.error}`;
  }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, {
      redirect: 'follow',
      headers: { Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'User-Agent': 'Drey' },
      signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      return `Error: ${url.href} answered ${response.status} ${response.statusText}`.trim();
    }
    const text = renderFetched(response.headers.get('content-type') ?? '', await readCapped(response));
    if (text === null) {
      return `Error: ${url.href} is not a text resource (${response.headers.get('content-type')}).`;
    }
    return capText(text === '' ? '(empty page)' : text, args['maxChars']);
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    return `Error: could not fetch ${url.href}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
