/**
 * Types for the in-editor web browser tab (ADR-0042, the browser plugin
 * since ADR-0044 stage 8B). One main-process `WebContentsView` per browser
 * tab; this module is the contract between the plugin's main and renderer
 * entries (it compiles into both plugin trees).
 *
 * A browser tab is a fileless doc keyed `browser://<n>` -- the same key is
 * its `BrowserTabId` here. `://` guarantees it never collides with a vault
 * path.
 */

/** The doc key of a browser tab, always `browser://<n>`. */
export type BrowserTabId = string;

/**
 * A rectangle in renderer CSS pixels (what `getBoundingClientRect()`
 * returns), relative to the window's top-left. The main process multiplies
 * it by `webContents.getZoomFactor()` before `WebContentsView.setBounds`.
 */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserCreateArgs {
  tabId: BrowserTabId;
  /** Already normalised by `normalizeAddress`; `about:blank` is fine. */
  url: string;
}

export interface BrowserTabRef {
  tabId: BrowserTabId;
}

export interface BrowserSetBoundsArgs {
  tabId: BrowserTabId;
  rect: BrowserRect;
}

export interface BrowserSetVisibleArgs {
  tabId: BrowserTabId;
  visible: boolean;
}

export interface BrowserNavigateArgs {
  tabId: BrowserTabId;
  /** Already normalised by `normalizeAddress`. */
  url: string;
}

export interface BrowserFindArgs {
  tabId: BrowserTabId;
  query: string;
  forward: boolean;
  /** `false` starts a fresh search for `query`; `true` steps to the next hit. */
  findNext: boolean;
  matchCase: boolean;
}

export interface BrowserStopFindArgs {
  tabId: BrowserTabId;
  action: 'clearSelection' | 'keepSelection' | 'activateSelection';
}

/**
 * Main -> renderer (`ctx.ipc.emit('event', …)`), one per meaningful
 * `webContents` event. A discriminated union on `kind` so the renderer
 * reducer stays exhaustive.
 */
export type BrowserEvent =
  | {
      tabId: BrowserTabId;
      kind: 'did-navigate';
      url: string;
      canGoBack: boolean;
      canGoForward: boolean;
    }
  | { tabId: BrowserTabId; kind: 'loading'; loading: boolean }
  | { tabId: BrowserTabId; kind: 'title'; title: string }
  | { tabId: BrowserTabId; kind: 'favicon'; favicon: string | null }
  | { tabId: BrowserTabId; kind: 'found-in-page'; activeMatchOrdinal: number; matches: number }
  | { tabId: BrowserTabId; kind: 'crashed'; reason: string };

/**
 * Main -> renderer (`ctx.ipc.emit('open-tab', …)`): a `target="_blank"` /
 * `window.open` the embedded page tried to open. The renderer opens it as a
 * new browser tab.
 */
export interface BrowserOpenTabRequest {
  url: string;
}

/** Per-tab UI state the renderer holds (`createBrowserStore`). */
export interface BrowserTabState {
  tabId: BrowserTabId;
  url: string;
  title: string;
  favicon: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  crashed: boolean;
  find: {
    open: boolean;
    query: string;
    activeMatch: number;
    matches: number;
  };
}
