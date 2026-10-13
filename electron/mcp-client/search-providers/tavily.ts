import { records, statusError, text, type SearchProvider } from './types';

const ENDPOINT = 'https://api.tavily.com/search';

/** Tavily: a bearer key, the query as a JSON body, results under `results`. */
export const tavilySearch: SearchProvider = {
  label: 'Tavily',
  async search({ query, count, config, fetch, signal }) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ query, max_results: count }),
      signal,
    });
    if (!response.ok) {
      throw statusError(this.label, response);
    }
    return records(await response.json(), 'results').map((item) => ({
      title: text(item['title']),
      url: text(item['url']),
      snippet: text(item['content']),
    }));
  },
};
