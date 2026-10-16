/**
 * Which navigations the main window may make (bug-11). Drey is a single
 * page: the only document the window may load is the app's own entry —
 * `/` or `/index.html` on the renderer's origin (the dev server, else
 * `app://app`), e.g. the dev server's live reload. Any other path of that
 * origin (a relative link in rendered note HTML) would load a page that
 * is not the app and leave a dead window; other origins never load here
 * at all (web links open in the OS browser). Pure.
 */
export function isAllowedNavigation(url: string, appOrigin: string): boolean {
  // Spelled out instead of `URL.origin`: Node reports "null" as the origin
  // of a non-http scheme like `app:`.
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i.exec(url);
  if (!match) {
    return false;
  }
  const [, origin, rawPath] = match;
  if (origin.toLowerCase() !== appOrigin.toLowerCase()) {
    return false;
  }
  const path = rawPath === '' ? '/' : rawPath.toLowerCase();
  return path === '/' || path === '/index.html';
}
