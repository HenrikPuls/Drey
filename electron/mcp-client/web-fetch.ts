import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import TurndownService from 'turndown';
import type { ToolSpec } from '../../shared/llm';

export const WEB_FETCH_TOOL_NAME = 'web_fetch';

export const WEB_FETCH_SPEC: ToolSpec = {
  name: WEB_FETCH_TOOL_NAME,
  description:
    'Fetch one web page or text resource by URL (http or https) and return its content as ' +
    'Markdown. Use it to read a page a search result or the user pointed at. It does not ' +
    'search; it reads exactly the URL given. It refuses addresses of the local network ' +
    'and the machine itself.',
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

/** A manual redirect loop follows at most this many hops before giving up. */
const MAX_REDIRECTS = 5;

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

/*
 * The private-address guard (ADR-0063): the model must never probe the
 * machine or its LAN through web_fetch. A URL is checked per hop (the
 * redirect loop is manual, so every Location is guarded before it is
 * followed): literal IPs against the ranges below, `localhost` /
 * `*.localhost` / `*.local` / `*.internal` without a lookup, and every
 * other name through a DNS lookup that refuses when ANY resolved
 * address is private (`all: true`, so a CNAME chain is covered).
 */

/** What one name lookup answers: every address the name resolves to. */
export type AddressLookup = (host: string) => Promise<{ address: string }[]>;

/** `dns.lookup(host, { all: true })` — every A/AAAA record of the name. */
export const defaultLookup: AddressLookup = (host) => dnsLookup(host, { all: true });

/** Brackets off an IPv6 hostname (`URL.hostname` keeps them). */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Whether a literal IPv4 address is in a range the model must not reach. */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) {
    return true; // 0/8, 10/8, 127/8
  }
  if (a === 169 && b === 254) {
    return true; // 169.254/16 (link-local)
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true; // 172.16/12
  }
  if (a === 192 && b === 168) {
    return true; // 192.168/16
  }
  if (a === 100 && b >= 64 && b <= 79) {
    return true; // 100.64/10 (CGNAT)
  }
  return a === 255 && b === 255 && octets[2] === 255 && octets[3] === 255;
}

/** Eight hextets of an IPv6 address, or `null` when it does not parse. */
function parseIpv6(host: string): number[] | null {
  let text = stripBrackets(host.toLowerCase());
  // An embedded IPv4 tail stands for its two hextets.
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) {
    return null;
  }
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parseSide = (side: string): number[] | null => {
    if (side === '' || side === ':') {
      return [];
    }
    const out: number[] = [];
    for (const piece of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) {
        return null;
      }
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const sides = text.split('::');
  if (sides.length === 2) {
    const left = parseSide(sides[0]!);
    const right = parseSide(sides[1]!);
    if (left === null || right === null || left.length + right.length > 7) {
      return null;
    }
    return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  }
  if (sides.length > 2) {
    return null;
  }
  const full = parseSide(text);
  return full !== null && full.length === 8 ? full : null;
}

/** Whether a literal IPv6 address is in a range the model must not reach. */
export function isPrivateIpv6(host: string): boolean {
  const h = parseIpv6(host);
  if (h === null) {
    return false;
  }
  const [a] = h as [number, ...number[]];
  if (h.every((piece) => piece === 0)) {
    return true; // ::
  }
  if (h.every((piece, i) => (i === 7 ? piece === 1 : piece === 0))) {
    return true; // ::1
  }
  if ((a! & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 (ULA)
  }
  if ((a! & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 (link-local)
  }
  if (a === 0x2002) {
    return true; // 2002::/16 (6to4)
  }
  return a === 0x0064 && h[1] === 0xff9b && h.slice(2, 6).every((piece) => piece === 0); // 64:ff9b::/96 (NAT64)
}

/** The dotted form of a mapped tail like `7f00:1`, or null when it is not one. */
function hextetPairToV4(pair: string): string | null {
  const pieces = pair.split(':');
  if (pieces.length !== 2 || pieces.some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) {
    return null;
  }
  const [a, b] = pieces.map((piece) => parseInt(piece, 16)) as [number, number];
  return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
}

/** Whether a literal IP address is private — an IPv4-mapped v6 normalized to its v4 check. */
export function isPrivateAddress(host: string): boolean {
  const bare = stripBrackets(host.toLowerCase());
  if (isIP(bare) === 4) {
    return isPrivateIpv4(bare);
  }
  if (isIP(bare) === 6) {
    const mapped = /^::ffff:(.+)$/.exec(bare);
    if (mapped) {
      const tail = mapped[1]!;
      if (isIP(tail) === 4) {
        return isPrivateIpv4(tail);
      }
      const dotted = hextetPairToV4(tail);
      if (dotted !== null) {
        return isPrivateIpv4(dotted);
      }
    }
    return isPrivateIpv6(bare);
  }
  return false;
}

/** Whether a NAME is refused without a lookup: the machine's own names. */
export function isLocalName(host: string): boolean {
  const bare = stripBrackets(host.toLowerCase());
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare.endsWith('.local') ||
    bare.endsWith('.internal')
  );
}

/** Why the URL may not be fetched, or `null` when it may. Throws only when the lookup fails. */
async function refuseAddress(url: URL, lookup: AddressLookup): Promise<string | null> {
  const host = stripBrackets(url.hostname.toLowerCase());
  if (isPrivateAddress(host)) {
    return `${url.href} is an address of the machine itself or its local network — web_fetch does not reach it.`;
  }
  if (isLocalName(host)) {
    return `${url.href} is a local name — web_fetch does not reach it.`;
  }
  if (isIP(host) === 0) {
    const records = await lookup(host);
    if (records.some((record) => isPrivateAddress(record.address))) {
      return `${url.href} resolves to an address of the local network — web_fetch does not reach it.`;
    }
  }
  return null;
}

/**
 * The built-in `web_fetch` tool (milestone 63, ADR-0063). Failures come
 * back as text so the model can say what went wrong; only an abort throws.
 * Redirects are followed manually (≤ 5 hops) so every hop's address is
 * guarded before anything is fetched from it.
 */
export async function runWebFetch(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
  lookup: AddressLookup = defaultLookup,
): Promise<string> {
  const url = parseFetchUrl(args['url']);
  if (!(url instanceof URL)) {
    return `Error: ${url.error}`;
  }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const deadline = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const refused = await refuseAddress(current, lookup);
      if (refused !== null) {
        return `Error: ${refused}`;
      }
      const response = await fetchFn(current, {
        redirect: 'manual',
        headers: {
          Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
          'User-Agent': 'Drey',
        },
        signal: deadline,
      });
      const location =
        response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (location !== null) {
        if (redirects >= MAX_REDIRECTS) {
          return `Error: too many redirects from ${url.href}.`;
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return `Error: ${current.href} redirected to an invalid URL.`;
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return `Error: the redirect to ${location} is not an http(s) URL — nothing was fetched.`;
        }
        current = next;
        continue;
      }
      if (!response.ok) {
        return `Error: ${current.href} answered ${response.status} ${response.statusText}`.trim();
      }
      const text = renderFetched(
        response.headers.get('content-type') ?? '',
        await readCapped(response),
      );
      if (text === null) {
        return `Error: ${current.href} is not a text resource (${response.headers.get('content-type')}).`;
      }
      return capText(text === '' ? '(empty page)' : text, args['maxChars']);
    }
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    return `Error: could not fetch ${url.href}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
