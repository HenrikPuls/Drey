import type { WebSearchConfig } from '../../../shared/app-config';

/** One result of a web search, as every provider hands it back. */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchRequest {
  query: string;
  /** How many results to ask for. */
  count: number;
  config: WebSearchConfig;
  fetch: typeof fetch;
  signal: AbortSignal;
}

/**
 * One search backend (milestone 79). It throws an `Error` whose message
 * tells the user what to change; the tool turns that into its result.
 */
export interface SearchProvider {
  /** The name used in messages. */
  readonly label: string;
  search(request: SearchRequest): Promise<SearchHit[]>;
}

/** A failed response as a message; the usual key and limit cases worded once. */
export function statusError(label: string, response: Response): Error {
  if (response.status === 401 || response.status === 403) {
    return new Error(`${label} rejected the API key (${response.status}). Check it in Settings → Assistant tools.`);
  }
  if (response.status === 429) {
    return new Error(`${label} is rate-limiting requests (429). Try again later.`);
  }
  return new Error(`${label} answered ${response.status} ${response.statusText}`.trim());
}

/** Text of an unknown JSON value; anything that is not a string reads as empty. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** The array under `key` as records; anything else reads as no results. */
export function records(value: unknown, key: string): Record<string, unknown>[] {
  const list = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : null;
  return Array.isArray(list)
    ? list.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    : [];
}
