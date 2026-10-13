import { statusError, type SearchHit, type SearchProvider } from './types';

const ENDPOINT = 'https://html.duckduckgo.com/html/';
// The page is served to browsers only.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The page a result link leads to: DuckDuckGo wraps it in a redirect. */
function targetUrl(href: string): string | null {
  const raw = decodeEntities(href.trim());
  let url: URL;
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, ENDPOINT);
  } catch {
    return null;
  }
  if (url.hostname.endsWith('duckduckgo.com')) {
    const wrapped = url.pathname === '/l/' ? url.searchParams.get('uddg') : null;
    // Anything else on its own host is an ad or a navigation link.
    return wrapped !== null && /^https?:\/\//i.test(wrapped) ? wrapped : null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/**
 * The results of DuckDuckGo's HTML page; `null` when the page holds no
 * result list at all (a challenge page, a changed layout).
 */
export function parseDuckDuckGoHtml(html: string): SearchHit[] | null {
  const links = [...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
  if (links.length === 0) {
    return /class="[^"]*\bno-results\b/i.test(html) ? [] : null;
  }
  const hits: SearchHit[] = [];
  links.forEach((link, index) => {
    const href = /\bhref="([^"]*)"/i.exec(link[0])?.[1];
    const url = href === undefined ? null : targetUrl(href);
    if (url === null) {
      return;
    }
    const start = (link.index ?? 0) + link[0].length;
    const rest = html.slice(start, links[index + 1]?.index ?? html.length);
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(rest)?.[1];
    hits.push({ title: plainText(link[1] ?? ''), url, snippet: plainText(snippet ?? '') });
  });
  return hits;
}

/**
 * DuckDuckGo without a key: its HTML result page is read. It works at
 * once, but the page is not an interface — it may change, and automated
 * requests are limited.
 */
export const duckDuckGoSearch: SearchProvider = {
  label: 'DuckDuckGo',
  async search({ query, count, fetch, signal }) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    const response = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      signal,
    });
    if (!response.ok) {
      throw statusError(this.label, response);
    }
    const hits = parseDuckDuckGoHtml(await response.text());
    if (hits === null) {
      throw new Error(
        'DuckDuckGo sent no result list — it limits automated requests, or its page changed. Try again later, or pick another search provider in Settings → Assistant tools.',
      );
    }
    return hits.slice(0, count);
  },
};
