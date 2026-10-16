import { records, statusError, text, type SearchProvider } from './types';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/** Brave Search API: a subscription token, results under `web.results`. */
export const braveSearch: SearchProvider = {
  label: 'Brave Search',
  async search({ query, count, config, fetch, signal }) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey },
      signal,
    });
    if (!response.ok) {
      throw statusError(this.label, response);
    }
    const body = (await response.json()) as Record<string, unknown> | null;
    return records(body?.['web'], 'results').map((item) => ({
      title: text(item['title']),
      url: text(item['url']),
      snippet: text(item['description']),
    }));
  },
};
