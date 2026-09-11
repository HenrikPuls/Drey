import type { BrowserRect } from '../shared/browser.js';
import { iconSvg } from './icons.js';
import type { BrowserPorts, BrowserStore } from './state.js';

/**
 * One pane's chrome for a `browser://` tab, as plain DOM (ADR-0044 rule 2;
 * ported from the old Angular `BrowserTab` component in ADR-0044 stage
 * 8B). It renders *only* the toolbar (back / forward / reload / address
 * bar / find) and an empty `.drey-browser-viewport` placeholder -- the page
 * itself is a main-process `WebContentsView` floated on top, matched
 * frame-by-frame to the placeholder's client rect.
 *
 * The view is created once (when the tab opens, in the store) and destroyed
 * when the tab leaves the registry; this controller only toggles its
 * visibility (hidden while unmounted, while an overlay is open, or during a
 * layout drag) and streams the bounds.
 */
export interface BrowserTabHandle {
  /** The doc's pane gained/lost focus (gates the find chord). */
  setFocused(focused: boolean): void;
  cleanup(): void;
}

export function mountBrowserTab(
  host: HTMLElement,
  tabId: string,
  store: BrowserStore,
  ports: BrowserPorts,
): BrowserTabHandle {
  host.classList.add('drey-browser');

  // -- build -----------------------------------------------------------------

  const toolbar = document.createElement('div');
  toolbar.className = 'drey-browser-toolbar';

  const navButton = (icon: string, size: number, title: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drey-browser-nav';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.appendChild(iconSvg(icon as Parameters<typeof iconSvg>[0], size));
    return btn;
  };

  const backBtn = navButton('chevron-left', 16, 'Back');
  const forwardBtn = navButton('chevron-right', 16, 'Forward');
  const reloadBtn = navButton('refresh-cw', 14, 'Reload');
  toolbar.append(backBtn, forwardBtn, reloadBtn);

  const address = document.createElement('input');
  address.type = 'text';
  address.className = 'drey-browser-address';
  address.spellcheck = false;
  address.setAttribute('autocapitalize', 'off');
  address.setAttribute('autocomplete', 'off');
  address.placeholder = 'Enter a URL or search';
  toolbar.appendChild(address);

  const findbar = document.createElement('div');
  findbar.className = 'drey-browser-findbar';
  findbar.hidden = true;

  const findInput = document.createElement('input');
  findInput.type = 'text';
  findInput.className = 'drey-browser-find-input';
  findInput.spellcheck = false;
  findInput.placeholder = 'Find in page';

  const findCount = document.createElement('span');
  findCount.className = 'drey-browser-find-count';

  const prevBtn = navButton('chevron-left', 14, 'Previous match');
  const nextBtn = navButton('chevron-right', 14, 'Next match');
  const closeFindBtn = navButton('x', 12, 'Close find');
  findbar.append(findInput, findCount, prevBtn, nextBtn, closeFindBtn);

  const viewport = document.createElement('div');
  viewport.className = 'drey-browser-viewport';

  const crashed = document.createElement('div');
  crashed.className = 'drey-browser-crashed';
  crashed.hidden = true;
  const crashedText = document.createElement('p');
  crashedText.textContent = 'This page crashed.';
  const crashedReload = document.createElement('button');
  crashedReload.type = 'button';
  crashedReload.textContent = 'Reload';
  crashed.append(crashedText, crashedReload);

  viewport.appendChild(crashed);
  host.append(toolbar, findbar, viewport);

  // -- render ----------------------------------------------------------------

  /** Local address-bar buffer; true while the user is editing it (don't clobber). */
  let editingAddress = false;

  const render = (): void => {
    const s = store.tabState(tabId);
    if (s === undefined) {
      return;
    }
    backBtn.disabled = !s.canGoBack;
    forwardBtn.disabled = !s.canGoForward;
    const wantIcon = s.loading ? 'x' : 'refresh-cw';
    if (reloadBtn.dataset['icon'] !== wantIcon) {
      reloadBtn.dataset['icon'] = wantIcon;
      reloadBtn.replaceChildren(iconSvg(wantIcon, 14));
    }
    reloadBtn.title = s.loading ? 'Stop' : 'Reload';
    reloadBtn.setAttribute('aria-label', reloadBtn.title);
    if (!editingAddress) {
      address.value = s.url === 'about:blank' ? '' : s.url;
    }

    findbar.hidden = !s.find.open;
    if (s.find.open && document.activeElement !== findInput) {
      findInput.focus();
    }
    findInput.value = s.find.query;
    if (s.find.matches > 0) {
      findCount.textContent = `${s.find.activeMatch} / ${s.find.matches}`;
    } else if (s.find.query) {
      findCount.textContent = '0 / 0';
    } else {
      findCount.textContent = '';
    }

    crashed.hidden = !s.crashed;
  };

  // -- visibility + bounds -----------------------------------------------------

  let mounted = true;
  let focused = false;
  let lastRect = '';
  let rafId = 0;
  let resizeObs: ResizeObserver | null = null;

  const assertVisibility = (): void => {
    const visible = mounted && !store.hidden();
    ports.setVisible({ tabId, visible });
    if (visible) {
      measure(true);
    }
  };

  const measure = (force: boolean): void => {
    if (store.hidden()) {
      return;
    }
    const r: DOMRect = viewport.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (!force && key === lastRect) {
      return;
    }
    lastRect = key;
    const rect: BrowserRect = { x: r.left, y: r.top, width: r.width, height: r.height };
    ports.setBounds({ tabId, rect });
  };

  // -- events ----------------------------------------------------------------

  const unsubStore = store.onChange(() => {
    render();
    assertVisibility();
  });

  const onAddressFocus = (): void => {
    editingAddress = true;
  };
  const onAddressBlur = (): void => {
    editingAddress = false;
    const s = store.tabState(tabId);
    address.value = s?.url === 'about:blank' ? '' : (s?.url ?? '');
  };
  const submitAddress = (): void => {
    editingAddress = false;
    store.navigate(tabId, address.value);
  };
  address.addEventListener('focus', onAddressFocus);
  address.addEventListener('blur', onAddressBlur);
  address.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      submitAddress();
    }
  });

  backBtn.addEventListener('click', () => store.back(tabId));
  forwardBtn.addEventListener('click', () => store.forward(tabId));
  reloadBtn.addEventListener('click', () => {
    if (store.tabState(tabId)?.loading) {
      store.stop(tabId);
    } else {
      store.reload(tabId);
    }
  });
  crashedReload.addEventListener('click', () => store.reload(tabId));

  findInput.addEventListener('input', () => store.find(tabId, findInput.value, true));
  findInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      const q = store.tabState(tabId)?.find.query ?? '';
      if (q) {
        store.find(tabId, q, false);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const q = store.tabState(tabId)?.find.query ?? '';
      if (q) {
        store.find(tabId, q, true);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      store.closeFind(tabId);
    }
  });
  prevBtn.addEventListener('click', () => {
    const q = store.tabState(tabId)?.find.query ?? '';
    if (q) {
      store.find(tabId, q, false);
    }
  });
  nextBtn.addEventListener('click', () => {
    const q = store.tabState(tabId)?.find.query ?? '';
    if (q) {
      store.find(tabId, q, true);
    }
  });
  closeFindBtn.addEventListener('click', () => store.closeFind(tabId));

  /** The find chord, document-level like the old component, gated on pane focus. */
  const onDocKey = (event: KeyboardEvent): void => {
    if (!focused) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      store.openFind(tabId);
    } else if (event.key === 'Escape' && (store.tabState(tabId)?.find.open ?? false)) {
      event.preventDefault();
      store.closeFind(tabId);
    }
  };
  document.addEventListener('keydown', onDocKey);

  resizeObs = new ResizeObserver(() => measure(false));
  resizeObs.observe(viewport);
  const onWinResize = (): void => measure(false);
  window.addEventListener('resize', onWinResize);
  // A cheap rAF poll catches splitter / dock drags (the rect moves every
  // frame with no resize event on this element).
  const tick = (): void => {
    measure(false);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  render();
  assertVisibility();

  return {
    setFocused(next: boolean): void {
      focused = next;
    },
    cleanup(): void {
      mounted = false;
      unsubStore();
      document.removeEventListener('keydown', onDocKey);
      resizeObs?.disconnect();
      resizeObs = null;
      window.removeEventListener('resize', onWinResize);
      cancelAnimationFrame(rafId);
      ports.setVisible({ tabId, visible: false });
    },
  };
}
