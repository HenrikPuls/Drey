import { records, statusError, text, type SearchProvider } from './types';

/** The instance's search address: its root, or the `/search` page itself. */
export function searxngSearchUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`"${baseUrl}" is not a valid address for the SearXNG instance.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The SearXNG address must start with http:// or https://.');
  }
  if (!/\/search\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
  }
  return url;
}

/** A SearXNG instance of the user's own, asked for JSON. */
export const searxngSearch: SearchProvider = {
  label: 'SearXNG',
  async search({ query, count, config, fetch, signal }) {
    const url = searxngSearchUrl(config.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (response.status === 403) {
      // The stock configuration answers HTML only.
      throw new Error(
        'the SearXNG instance refused the JSON format (403). Add "json" to search.formats in its settings.yml.',
      );
    }
    if (!response.ok) {
      throw statusError(this.label, response);
    }
    return records(await response.json(), 'results')
      .slice(0, count)
      .map((item) => ({
        title: text(item['title']),
        url: text(item['url']),
        snippet: text(item['content']),
      }));
  },
};
