import type {
  BrowserEvent,
  BrowserFindArgs,
  BrowserRect,
  BrowserStopFindArgs,
  BrowserTabState,
} from '../shared/browser.js';
import { normalizeAddress } from './normalize-address.js';

/**
 * Renderer-side state of the browser plugin (ADR-0042, ADR-0044 stage 8B):
 * the per-tab chrome state, the `browser://<n>` key mint, the event
 * reducer and the lifecycle, framework-free. The pane chrome
 * (`mountBrowserTab`) renders from it; the doc itself never enters this DOM.
 */

/** The native-view control channel (the plugin main's handlers). */
export interface BrowserPorts {
  create(args: { tabId: string; url: string }): void;
  destroy(args: { tabId: string }): void;
  setBounds(args: { tabId: string; rect: BrowserRect }): void;
  setVisible(args: { tabId: string; visible: boolean }): void;
  navigate(args: { tabId: string; url: string }): void;
  goBack(args: { tabId: string }): void;
  goForward(args: { tabId: string }): void;
  reload(args: { tabId: string }): void;
  stop(args: { tabId: string }): void;
  find(args: BrowserFindArgs): void;
  stopFind(args: BrowserStopFindArgs): void;
}

/**
 * The tab-registry links. A browser tab is a doc of kind `browser`; the
 * store calls into the documents API exactly where the pre-plugin
 * `BrowserViewService` called `EditorService` directly.
 */
export interface BrowserStoreLinks {
  openDoc(tabId: string): void;
  renameDoc(tabId: string, title: string): void;
}

const DEFAULT_STATE = (tabId: string): BrowserTabState => ({
  tabId,
  url: '',
  title: 'New tab',
  favicon: null,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  crashed: false,
  find: { open: false, query: '', activeMatch: 0, matches: 0 },
});

export interface BrowserStore {
  tabState(tabId: string): BrowserTabState | undefined;
  /** True while an overlay is up or a layout gesture runs (views must hide). */
  hidden(): boolean;
  openTab(rawInput?: string): void;
  /** Session restore: re-creates a tab with its exact previous key + URL. */
  restoreTab(tabId: string, lastUrl: string): void;
  /** Destroys state + native view for every tab no longer in `alivePaths`. */
  syncOpenDocs(alivePaths: readonly string[]): void;
  /** "Native surfaces must hide" push (`api.env.onNativeSurfaceVisibility`). */
  setHidden(hidden: boolean): void;
  navigate(tabId: string, rawInput: string): void;
  back(tabId: string): void;
  forward(tabId: string): void;
  reload(tabId: string): void;
  stop(tabId: string): void;
  setBounds(tabId: string, rect: BrowserRect): void;
  openFind(tabId: string): void;
  closeFind(tabId: string): void;
  find(tabId: string, query: string, forward: boolean, matchCase?: boolean): void;
  reduce(event: BrowserEvent): void;
  onChange(listener: () => void): () => void;
}

export function createBrowserStore(ports: BrowserPorts, links: BrowserStoreLinks): BrowserStore {
  let state: Record<string, BrowserTabState> = {};
  let hidden = false;
  let seq = 0;
  const lastFindQuery = new Map<string, string>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const patch = (tabId: string, partial: Partial<BrowserTabState>): void => {
    const cur = state[tabId];
    if (cur) {
      state = { ...state, [tabId]: { ...cur, ...partial } };
    }
  };

  const patchFind = (tabId: string, partial: Partial<BrowserTabState['find']>): void => {
    const cur = state[tabId];
    if (cur) {
      state = { ...state, [tabId]: { ...cur, find: { ...cur.find, ...partial } } };
    }
  };

  /** Drops a tab's chrome state and its native view. */
  const forget = (tabId: string): void => {
    const { [tabId]: _gone, ...rest } = state;
    state = rest;
    lastFindQuery.delete(tabId);
    ports.destroy({ tabId });
  };

  const store: BrowserStore = {
    tabState: (tabId) => state[tabId],
    hidden: () => hidden,

    openTab(rawInput?: string): void {
      const tabId = `browser://${++seq}`;
      const url = normalizeAddress(rawInput ?? '') || 'about:blank';
      state = { ...state, [tabId]: { ...DEFAULT_STATE(tabId), url } };
      links.openDoc(tabId);
      ports.create({ tabId, url });
      notify();
    },

    restoreTab(tabId: string, lastUrl: string): void {
      const n = Number(tabId.replace('browser://', ''));
      if (Number.isFinite(n)) {
        seq = Math.max(seq, n);
      }
      const url = lastUrl && lastUrl !== 'about:blank' ? lastUrl : 'about:blank';
      state = { ...state, [tabId]: { ...DEFAULT_STATE(tabId), url } };
      links.openDoc(tabId);
      ports.create({ tabId, url });
      notify();
    },

    syncOpenDocs(alivePaths: readonly string[]): void {
      const alive = new Set(alivePaths);
      const gone = Object.keys(state).filter((id) => !alive.has(id));
      if (gone.length === 0) {
        return;
      }
      for (const id of gone) {
        forget(id);
      }
      notify();
    },

    setHidden(next: boolean): void {
      if (hidden === next) {
        return;
      }
      hidden = next;
      notify();
    },

    navigate(tabId: string, rawInput: string): void {
      const url = normalizeAddress(rawInput);
      if (!url) {
        return;
      }
      patch(tabId, { url });
      ports.navigate({ tabId, url });
      notify();
    },

    back: (tabId) => ports.goBack({ tabId }),
    forward: (tabId) => ports.goForward({ tabId }),
    reload: (tabId) => ports.reload({ tabId }),
    stop: (tabId) => ports.stop({ tabId }),
    setBounds: (tabId, rect) => ports.setBounds({ tabId, rect }),

    openFind(tabId: string): void {
      patchFind(tabId, { open: true });
      notify();
    },

    closeFind(tabId: string): void {
      patchFind(tabId, { open: false, query: '', activeMatch: 0, matches: 0 });
      lastFindQuery.delete(tabId);
      ports.stopFind({ tabId, action: 'clearSelection' });
      notify();
    },

    find(tabId: string, query: string, forward: boolean, matchCase = false): void {
      patchFind(tabId, { query });
      if (query === '') {
        ports.stopFind({ tabId, action: 'clearSelection' });
        lastFindQuery.delete(tabId);
        notify();
        return;
      }
      const findNext = lastFindQuery.get(tabId) === query;
      lastFindQuery.set(tabId, query);
      ports.find({ tabId, query, forward, findNext, matchCase });
      notify();
    },

    reduce(event: BrowserEvent): void {
      const { tabId } = event;
      if (!state[tabId]) {
        return;
      }
      switch (event.kind) {
        case 'did-navigate':
          patch(tabId, {
            url: event.url,
            canGoBack: event.canGoBack,
            canGoForward: event.canGoForward,
            crashed: false,
          });
          break;
        case 'loading':
          patch(tabId, { loading: event.loading });
          break;
        case 'title': {
          const title = event.title.trim() || 'New tab';
          patch(tabId, { title });
          links.renameDoc(tabId, title);
          break;
        }
        case 'favicon':
          patch(tabId, { favicon: event.favicon });
          break;
        case 'found-in-page':
          patchFind(tabId, { activeMatch: event.activeMatchOrdinal, matches: event.matches });
          break;
        case 'crashed':
          patch(tabId, { crashed: true, loading: false });
          break;
      }
      notify();
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return store;
}
