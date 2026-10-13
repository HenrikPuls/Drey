import type { WebSearchConfig, WebSearchProvider } from '../../shared/app-config';
import type { ToolSpec } from '../../shared/llm';
import { braveSearch } from './search-providers/brave';
import { duckDuckGoSearch } from './search-providers/duckduckgo';
import { searxngSearch } from './search-providers/searxng';
import { tavilySearch } from './search-providers/tavily';
import type { SearchHit, SearchProvider } from './search-providers/types';

export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const WEB_SEARCH_SPEC: ToolSpec = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    'Search the web and return the best results: title, URL and a short excerpt each. Use it ' +
    'for current or external information. The excerpts are short and may be out of context — ' +
    'to rely on a page, read it (with web_fetch, when that tool is available). Write the ' +
    'query the way you would type it into a search engine: a few key words, not a sentence.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search words.' },
      max_results: {
        type: 'number',
        description: 'How many results to return (default 5, at most 10).',
      },
    },
    required: ['query'],
  },
};

const SEARCH_TIMEOUT_MS = 20_000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 300;
const MAX_QUERY_CHARS = 400;

const PROVIDERS: Record<WebSearchProvider, SearchProvider> = {
  duckduckgo: duckDuckGoSearch,
  brave: braveSearch,
  tavily: tavilySearch,
  searxng: searxngSearch,
};

function resultCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
    ? Math.min(MAX_RESULTS, Math.floor(raw))
    : DEFAULT_RESULTS;
}

/** The results as the text the model reads. */
export function formatSearchHits(query: string, hits: readonly SearchHit[]): string {
  const usable = hits.filter((hit) => hit.url !== '');
  if (usable.length === 0) {
    return `No results for "${query}".`;
  }
  const lines = usable.map((hit, index) => {
    const snippet =
      hit.snippet.length > MAX_SNIPPET_CHARS ? `${hit.snippet.slice(0, MAX_SNIPPET_CHARS)}…` : hit.snippet;
    return [`${index + 1}. ${hit.title === '' ? hit.url : hit.title}`, `   ${hit.url}`, ...(snippet === '' ? [] : [`   ${snippet}`])].join(
      '\n',
    );
  });
  return `Results for "${query}":\n\n${lines.join('\n\n')}`;
}

/**
 * The built-in `web_search` tool (milestone 79, ADR-0063 later change):
 * one query to the provider chosen in Settings. Failures come back as
 * text so the model can say what went wrong; only an abort throws.
 */
export async function runWebSearch(
  args: Record<string, unknown>,
  config: WebSearchConfig,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const query = typeof args['query'] === 'string' ? args['query'].replace(/\s+/g, ' ').trim() : '';
  if (query === '') {
    return 'Error: query is required — pass the search words, e.g. {"query": "electron safeStorage linux"}.';
  }
  if (query.length > MAX_QUERY_CHARS) {
    return `Error: the query is too long (${query.length} characters, at most ${MAX_QUERY_CHARS}). Search for a few key words.`;
  }
  const provider = PROVIDERS[config.provider];
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  try {
    const hits = await provider.search({
      query,
      count: resultCount(args['max_results']),
      config,
      fetch: fetchFn,
      signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return formatSearchHits(query, hits.slice(0, MAX_RESULTS));
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    return `Error: the web search failed (${provider.label}): ${err instanceof Error ? err.message : String(err)}`;
  }
}
