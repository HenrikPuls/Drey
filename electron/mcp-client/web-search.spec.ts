import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, type WebSearchConfig } from '../../shared/app-config';
import { parseDuckDuckGoHtml } from './search-providers/duckduckgo';
import { searxngSearchUrl } from './search-providers/searxng';
import { formatSearchHits, runWebSearch } from './web-search';

/**
 * The built-in `web_search` tool (milestone 79): the request each provider
 * sends, what it reads out of the answer, and how a failure reaches the
 * model. No network: every call goes to a scripted `fetch`.
 */

function search(patch: Partial<WebSearchConfig>): WebSearchConfig {
  return { ...DEFAULT_APP_CONFIG.tools.webSearch, enabled: true, ...patch };
}

interface Sent {
  url: URL;
  init: RequestInit;
}

function scripted(answer: () => Response): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: new URL(input instanceof Request ? input.url : input), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const header = (sent: Sent, name: string): string | undefined =>
  (sent.init.headers as Record<string, string> | undefined)?.[name];

const DDG_PAGE = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fharbour%3Fa%3D1&amp;rut=abc">Harbour <b>fees</b> &amp; berths</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fharbour">The fee is <b>12 euros</b> per&nbsp;night.</a>
</div>
<div class="result result--ad">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example">Buy a boat</a>
  <a class="result__snippet" href="#">An advertisement.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://plain.example/page">Plain link</a>
</div>`;

describe('formatSearchHits', () => {
  it('numbers the results with address and excerpt, and says so when there are none', () => {
    expect(
      formatSearchHits('harbour fee', [
        { title: 'Harbour', url: 'https://a.example', snippet: 'Twelve euros.' },
        { title: '', url: 'https://b.example', snippet: '' },
        { title: 'No address', url: '', snippet: 'dropped' },
      ]),
    ).toBe(
      [
        'Results for "harbour fee":',
        '',
        '1. Harbour',
        '   https://a.example',
        '   Twelve euros.',
        '',
        '2. https://b.example',
        '   https://b.example',
      ].join('\n'),
    );
    expect(formatSearchHits('nothing', [])).toBe('No results for "nothing".');
  });

  it('cuts a long excerpt', () => {
    const text = formatSearchHits('q', [{ title: 'T', url: 'https://a.example', snippet: 'x'.repeat(400) }]);
    expect(text).toContain(`${'x'.repeat(300)}…`);
    expect(text).not.toContain('x'.repeat(301));
  });
});

describe('runWebSearch', () => {
  it('refuses an empty and an overlong query without asking anyone', async () => {
    const http = scripted(() => json({}));
    expect(await runWebSearch({}, search({}), undefined, http.fetch)).toMatch(/^Error: query is required/);
    expect(await runWebSearch({ query: 'x'.repeat(401) }, search({}), undefined, http.fetch)).toMatch(
      /^Error: the query is too long/,
    );
    expect(http.sent).toEqual([]);
  });

  it('Brave: the key as subscription token, results from web.results', async () => {
    const http = scripted(() =>
      json({ web: { results: [{ title: 'Harbour', url: 'https://a.example', description: 'Twelve  euros.' }] } }),
    );
    const text = await runWebSearch(
      { query: ' harbour   fee ', max_results: 3 },
      search({ provider: 'brave', apiKey: 'bsa-1' }),
      undefined,
      http.fetch,
    );
    expect(http.sent[0]!.url.origin + http.sent[0]!.url.pathname).toBe(
      'https://api.search.brave.com/res/v1/web/search',
    );
    expect(http.sent[0]!.url.searchParams.get('q')).toBe('harbour fee');
    expect(http.sent[0]!.url.searchParams.get('count')).toBe('3');
    expect(header(http.sent[0]!, 'X-Subscription-Token')).toBe('bsa-1');
    expect(text).toContain('1. Harbour\n   https://a.example\n   Twelve euros.');
  });

  it('Tavily: a bearer key and a JSON body, results from results[].content', async () => {
    const http = scripted(() =>
      json({ results: [{ title: 'Harbour', url: 'https://a.example', content: 'Twelve euros.' }] }),
    );
    const text = await runWebSearch(
      { query: 'harbour fee' },
      search({ provider: 'tavily', apiKey: 'tvly-1' }),
      undefined,
      http.fetch,
    );
    expect(http.sent[0]!.url.href).toBe('https://api.tavily.com/search');
    expect(http.sent[0]!.init.method).toBe('POST');
    expect(header(http.sent[0]!, 'Authorization')).toBe('Bearer tvly-1');
    expect(JSON.parse(String(http.sent[0]!.init.body))).toEqual({ query: 'harbour fee', max_results: 5 });
    expect(text).toContain('Twelve euros.');
  });

  it('SearXNG: asks the instance for JSON and keeps to the requested count', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `Hit ${i + 1}`,
      url: `https://a.example/${i + 1}`,
      content: 'text',
    }));
    const http = scripted(() => json({ results }));
    const text = await runWebSearch(
      { query: 'harbour', max_results: 2 },
      search({ provider: 'searxng', baseUrl: 'http://127.0.0.1:8080/' }),
      undefined,
      http.fetch,
    );
    expect(http.sent[0]!.url.href).toBe('http://127.0.0.1:8080/search?q=harbour&format=json');
    expect(text).toContain('2. Hit 2');
    expect(text).not.toContain('Hit 3');
  });

  it('SearXNG: the search address is built from the root or taken as given', () => {
    expect(searxngSearchUrl('https://s.example').href).toBe('https://s.example/search');
    expect(searxngSearchUrl('https://s.example/searx/').href).toBe('https://s.example/searx/search');
    expect(searxngSearchUrl('https://s.example/search').href).toBe('https://s.example/search');
    expect(() => searxngSearchUrl('not an address')).toThrow(/not a valid address/);
    expect(() => searxngSearchUrl('ftp://s.example')).toThrow(/http/);
  });

  it('DuckDuckGo: reads the result page, unwraps the redirect links and skips ads', async () => {
    expect(parseDuckDuckGoHtml(DDG_PAGE)).toEqual([
      {
        title: 'Harbour fees & berths',
        url: 'https://example.org/harbour?a=1',
        snippet: 'The fee is 12 euros per night.',
      },
      { title: 'Plain link', url: 'https://plain.example/page', snippet: '' },
    ]);
    expect(parseDuckDuckGoHtml('<div class="no-results">No results.</div>')).toEqual([]);
    expect(parseDuckDuckGoHtml('<html><body>Unusual traffic</body></html>')).toBeNull();

    const http = scripted(() => new Response(DDG_PAGE, { status: 200 }));
    const text = await runWebSearch({ query: 'harbour', max_results: 1 }, search({}), undefined, http.fetch);
    expect(http.sent[0]!.url.href).toBe('https://html.duckduckgo.com/html/?q=harbour');
    expect(text).toContain('1. Harbour fees & berths');
    expect(text).not.toContain('Plain link');
  });

  it('a failure comes back as an error the model can read, naming the provider', async () => {
    const rejected = scripted(() => json({}, 401));
    expect(
      await runWebSearch({ query: 'x' }, search({ provider: 'brave', apiKey: 'bad' }), undefined, rejected.fetch),
    ).toMatch(/^Error: the web search failed \(Brave Search\): Brave Search rejected the API key \(401\)/);

    const htmlOnly = scripted(() => json({}, 403));
    expect(
      await runWebSearch(
        { query: 'x' },
        search({ provider: 'searxng', baseUrl: 'http://s.example' }),
        undefined,
        htmlOnly.fetch,
      ),
    ).toMatch(/search\.formats/);

    const challenge = scripted(() => new Response('<html>Unusual traffic</html>', { status: 200 }));
    expect(await runWebSearch({ query: 'x' }, search({}), undefined, challenge.fetch)).toMatch(
      /^Error: the web search failed \(DuckDuckGo\): DuckDuckGo sent no result list/,
    );

    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await runWebSearch({ query: 'x' }, search({}), undefined, down)).toMatch(/ENOTFOUND/);
  });

  it('an abort is thrown, not reported', async () => {
    const controller = new AbortController();
    const aborting = (async () => {
      controller.abort();
      throw new Error('aborted');
    }) as unknown as typeof fetch;
    await expect(runWebSearch({ query: 'x' }, search({}), controller.signal, aborting)).rejects.toThrow('aborted');
  });
});
