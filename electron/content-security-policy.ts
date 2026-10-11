/**
 * The Content-Security-Policy of the main window's page (ADR-0001, later
 * change). The renderer draws material it did not write — notes of a
 * cloned vault, fetched web pages, model and tool output — next to a bridge
 * that can write files and run plugin backends. The HTML sanitizer is the
 * first layer; this policy is the second: whatever markup slips through,
 * no script runs unless it was loaded from the app's own bundle or from a
 * plugin's renderer directory.
 *
 * What each directive is there for:
 * - `script-src`: the Angular bundle (`'self'`) and plugin renderer modules
 *   (`plugin:`). No inline scripts, no `eval`.
 * - `style-src`: `'unsafe-inline'` is required — Angular and CodeMirror
 *   inject `<style>` elements and the UI sets `style` attributes.
 * - `img-src`: vault files (`drey-asset:`), rendered diagrams (`data:`),
 *   pasted pictures (`blob:`) and remote pictures a note links to.
 * - `connect-src`: the page's own files, plugin files and vault files
 *   (the PDF embed probes a reference before framing it). No network.
 * - `frame-src`: the PDF viewer (`drey-asset:`) and a plugin's own pages
 *   (`plugin:`, the diagram editor). A framed page has its own policy.
 *
 * Kept free of Electron imports so it is testable in plain Node.
 */

/** Header name, for the two places that attach the policy. */
export const CSP_HEADER = 'Content-Security-Policy';

/**
 * Builds the policy. `devServerUrl` is the `ng serve` origin in a dev run:
 * the page then comes from that origin over HTTP and keeps a WebSocket to
 * it for live reload, which `'self'` covers for everything but the socket.
 */
export function buildContentSecurityPolicy(devServerUrl: string | null = null): string {
  const devSocket = devServerUrl === null ? [] : [toWebSocketOrigin(devServerUrl)];
  const directives: [string, string[]][] = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", 'plugin:']],
    ['style-src', ["'self'", 'plugin:', "'unsafe-inline'"]],
    ['img-src', ["'self'", 'plugin:', 'drey-asset:', 'data:', 'blob:', 'http:', 'https:']],
    ['font-src', ["'self'", 'plugin:', 'data:']],
    ['media-src', ["'self'", 'drey-asset:', 'data:', 'blob:']],
    ['connect-src', ["'self'", 'plugin:', 'drey-asset:', ...devSocket]],
    ['frame-src', ['plugin:', 'drey-asset:']],
    ['worker-src', ["'self'", 'blob:']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

function toWebSocketOrigin(httpUrl: string): string {
  const url = new URL(httpUrl);
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
}

/**
 * True for a response that is the main window's own page rather than the
 * startup splash, which is a static, self-contained file with inline CSS
 * and script and shows nothing but progress text from main.
 */
export function isAppDocument(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (lower.endsWith('/splash.html')) {
    return false;
  }
  return lower === '/' || lower.endsWith('.html');
}
