/**
 * Turns whatever the user typed in a browser tab's address bar into a URL
 * to load (ADR-0042).
 *
 * Rules, in order:
 *  1. `about:blank` / `about:*` -> passed through.
 *  2. Already has an `http(s)://` scheme -> passed through (trimmed).
 *  3. Any *other* explicit scheme (`file:`, `javascript:`, `data:`, …) ->
 *     treated as a search query, never navigated to. Loading those inside
 *     an embedded view is either useless or a footgun.
 *  4. Looks like a bare host / URL (`example.com`, `localhost:3000`,
 *     `127.0.0.1/x`, `sub.example.co.uk/p?q=1`) -> `https://` prefixed.
 *  5. Everything else -> a DuckDuckGo search.
 *
 * DuckDuckGo is hard-coded for v1 (no engine setting yet). It has an
 * HTML-friendly result page and no consent wall.
 */

const SEARCH_URL = 'https://duckduckgo.com/?q=';

/** `host`, `host:port`, `host/path`, `host:port/path…` with a dotted host or `localhost`. */
const HOST_LIKE =
  /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** A bare IPv4 (optionally `:port` / path), e.g. `127.0.0.1`, `192.168.1.5:8080/x`. */
const IPV4_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#]\S*)?$/;

export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (value === '') {
    return '';
  }

  if (/^about:/i.test(value)) {
    return value;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  // `//example.com` (protocol-relative) -> https.
  if (value.startsWith('//') && HOST_LIKE.test(value.slice(2))) {
    return `https:${value}`;
  }

  // Host-shaped input gets `https://` -- checked *before* the generic
  // "any scheme" test below so `localhost:3000` / `127.0.0.1:8080` (which
  // look like `scheme:rest`) are treated as hosts, not schemes.
  if (HOST_LIKE.test(value) || IPV4_LIKE.test(value)) {
    return `https://${value}`;
  }

  // Anything else -- free text, or some other explicit scheme (`file:`,
  // `javascript:`, `data:`, …) which an embedded view must never navigate
  // to -- becomes a search.
  return search(value);
}

function search(query: string): string {
  return SEARCH_URL + encodeURIComponent(query);
}
