/**
 * The window never navigates away from the app because of a link
 * (bug-11). Drey is a single page: an `<a href>` that resolves to the
 * app's own origin (a relative note link in rendered HTML, a manual page
 * …) would load that path from the dev server or `app://` and leave a
 * dead window behind — no titlebar, no way to quit.
 *
 * A capture-phase `click` / `auxclick` listener on the window cancels
 * the default action of any same-origin anchor that names another page.
 * It only blocks the navigation: the feature that drew the link opens it
 * itself (the editor routes widget links through its link opening).
 * `#anchor` jumps inside the page and links to other origins (opened in
 * the OS browser by main's window-open handler) are left alone.
 * Main's `will-navigate` guard is the second line (`main-window.ts`).
 */
export function installLinkNavigationGuard(win: Window): () => void {
  const onClick = (event: MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || event.defaultPrevented) {
      return;
    }
    if (navigatesAway(anchor.href, win.location.href)) {
      event.preventDefault();
    }
  };
  win.addEventListener('click', onClick, { capture: true });
  win.addEventListener('auxclick', onClick, { capture: true });
  return () => {
    win.removeEventListener('click', onClick, { capture: true });
    win.removeEventListener('auxclick', onClick, { capture: true });
  };
}

/** True when following `href` from `current` would load another page of the app's own origin. */
export function navigatesAway(href: string, current: string): boolean {
  let target: URL;
  let here: URL;
  try {
    target = new URL(href, current);
    here = new URL(current);
  } catch {
    return false;
  }
  if (target.origin !== here.origin) {
    return false;
  }
  // Only the fragment differs: an in-page jump (footnotes, the manual's contents).
  return target.pathname !== here.pathname || target.search !== here.search;
}
