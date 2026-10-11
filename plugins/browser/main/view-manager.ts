import {
  BrowserWindow,
  clipboard,
  Menu,
  session,
  shell,
  WebContentsView,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import type {
  BrowserEvent,
  BrowserRect,
  BrowserStopFindArgs,
  BrowserTabId,
} from '../shared/browser.js';

/**
 * Owns one `WebContentsView` per in-editor browser tab (ADR-0042; the
 * browser plugin's main side since ADR-0044 stage 8B).
 *
 * Each view is a native surface composited *above* the whole DOM, so this
 * class is deliberately dumb about layout: the renderer streams the client
 * rect of its chrome placeholder (`setBounds`) and a visibility flag
 * (`setVisible`, driven by pane focus / window blur / open overlays), and
 * the manager just applies them. It also runs the per-view security
 * handlers -- the main window's own `will-navigate` / `setWindowOpenHandler`
 * are on a different `webContents` and do not cover these.
 *
 * Pushes go through the callbacks the plugin's `activate` provides (`send`
 * / `requestOpenTab`) instead of fixed IPC channels -- everything crosses
 * the generic plugin bridge (`plugin:event`).
 */

/** Cookies + storage for every browser tab. Isolated from the app's own session. */
const PARTITION = 'persist:webtab';

interface Entry {
  readonly view: WebContentsView;
  desiredBounds: BrowserRect | null;
  desiredVisible: boolean;
  /** The query the last `findInPage` ran, so a repeat call can step (`findNext`). */
  lastFindQuery: string | null;
}

export class BrowserViewManager {
  private readonly entries = new Map<BrowserTabId, Entry>();
  private win: BrowserWindow | null = null;
  /** True while the window is blurred / minimized / hidden -- every view is forced hidden. */
  private windowObscured = false;
  private partitionPrepared = false;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly send: (event: BrowserEvent) => void,
    private readonly requestOpenTab: (url: string) => void,
  ) {}

  /**
   * Binds the live window and its focus lifecycle. Safe to call again on
   * the `app 'activate'` recreate path -- it rebinds and re-parents every
   * surviving view into the new window's `contentView`.
   */
  attach(win: BrowserWindow): void {
    this.win = win;
    this.windowObscured = !win.isFocused();

    const hideAll = (): void => {
      this.windowObscured = true;
      for (const [, entry] of this.entries) {
        entry.view.setVisible(false);
      }
    };
    const restoreAll = (): void => {
      this.windowObscured = false;
      for (const [, entry] of this.entries) {
        entry.view.setVisible(entry.desiredVisible);
      }
    };

    win.on('blur', hideAll);
    win.on('minimize', hideAll);
    win.on('hide', hideAll);
    win.on('focus', restoreAll);
    win.on('restore', restoreAll);
    win.on('show', restoreAll);

    // Re-parent any view that outlived a previous window (macOS re-activate).
    for (const [, entry] of this.entries) {
      win.contentView.addChildView(entry.view);
      entry.view.setVisible(entry.desiredVisible && !this.windowObscured);
      if (entry.desiredBounds) {
        this.applyBounds(entry, entry.desiredBounds);
      }
    }
  }

  create(tabId: BrowserTabId, url: string): void {
    if (this.entries.has(tabId)) {
      return;
    }
    const win = this.win ?? this.getMainWindow();
    if (!win) {
      return;
    }
    this.preparePartition();

    let view: WebContentsView | null = null;
    try {
      view = new WebContentsView({
        webPreferences: {
          partition: PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          // No preload: this is untrusted web content, it gets no bridge.
        },
      });
      const entry: Entry = { view, desiredBounds: null, desiredVisible: false, lastFindQuery: null };
      this.entries.set(tabId, entry);

      win.contentView.addChildView(view);
      view.setVisible(false);
      view.setBorderRadius?.(0);
      this.wireSecurity(tabId, view.webContents);
      this.wireEvents(tabId, view.webContents);
      this.wireContextMenu(view.webContents);
      this.stripElectronFromUserAgent(view.webContents);

      void view.webContents.loadURL(url || 'about:blank').catch(() => {
        /* a bad initial URL surfaces as a did-fail-load event, not a throw */
      });
    } catch (err) {
      // Roll back a half-created view so it can never leak.
      this.entries.delete(tabId);
      try {
        if (view) {
          win.contentView.removeChildView(view);
          view.webContents.close();
        }
      } catch {
        /* ignore */
      }
      console.warn(
        `browser tab ${tabId}: create failed -- ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  destroy(tabId: BrowserTabId): void {
    const entry = this.entries.get(tabId);
    if (!entry) {
      return;
    }
    this.entries.delete(tabId);
    try {
      (this.win ?? this.getMainWindow())?.contentView.removeChildView(entry.view);
    } catch {
      /* window already gone */
    }
    try {
      entry.view.webContents.close();
    } catch {
      /* already closed */
    }
  }

  destroyAll(): void {
    for (const tabId of [...this.entries.keys()]) {
      this.destroy(tabId);
    }
  }

  setBounds(tabId: BrowserTabId, rect: BrowserRect): void {
    const entry = this.entries.get(tabId);
    if (!entry) {
      return;
    }
    entry.desiredBounds = rect;
    this.applyBounds(entry, rect);
  }

  setVisible(tabId: BrowserTabId, visible: boolean): void {
    const entry = this.entries.get(tabId);
    if (!entry) {
      return;
    }
    entry.desiredVisible = visible;
    entry.view.setVisible(visible && !this.windowObscured);
  }

  navigate(tabId: BrowserTabId, url: string): void {
    const wc = this.entries.get(tabId)?.view.webContents;
    if (wc && url) {
      void wc.loadURL(url).catch(() => undefined);
    }
  }

  goBack(tabId: BrowserTabId): void {
    const wc = this.entries.get(tabId)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    }
  }

  goForward(tabId: BrowserTabId): void {
    const wc = this.entries.get(tabId)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    }
  }

  reload(tabId: BrowserTabId): void {
    this.entries.get(tabId)?.view.webContents.reload();
  }

  stop(tabId: BrowserTabId): void {
    this.entries.get(tabId)?.view.webContents.stop();
  }

  find(tabId: BrowserTabId, query: string, forward: boolean, findNext: boolean, matchCase: boolean): void {
    const entry = this.entries.get(tabId);
    if (!entry || query === '') {
      return;
    }
    const wc = entry.view.webContents;
    const stepping = findNext && entry.lastFindQuery === query;
    entry.lastFindQuery = query;
    wc.findInPage(query, { forward, findNext: stepping, matchCase });
  }

  stopFind(tabId: BrowserTabId, action: BrowserStopFindArgs['action']): void {
    const entry = this.entries.get(tabId);
    if (!entry) {
      return;
    }
    entry.lastFindQuery = null;
    entry.view.webContents.stopFindInPage(action);
  }

  // --- internals --------------------------------------------------------

  private applyBounds(entry: Entry, rect: BrowserRect): void {
    const win = this.win ?? this.getMainWindow();
    if (!win) {
      return;
    }
    const factor = win.webContents.getZoomFactor() || 1;
    const [cw, ch] = win.getContentSize();
    const x = Math.round(rect.x * factor);
    const y = Math.round(rect.y * factor);
    const width = Math.round(rect.width * factor);
    const height = Math.round(rect.height * factor);
    entry.view.setBounds({
      x: Math.max(0, Math.min(x, cw)),
      y: Math.max(0, Math.min(y, ch)),
      width: Math.max(0, Math.min(width, cw - Math.max(0, x))),
      height: Math.max(0, Math.min(height, ch - Math.max(0, y))),
    });
  }

  private preparePartition(): void {
    if (this.partitionPrepared) {
      return;
    }
    this.partitionPrepared = true;
    const ses = session.fromPartition(PARTITION);
    // Deny every powerful permission by default (geolocation, notifications,
    // camera/mic, …). Revisit per-permission if a real need turns up.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }

  private stripElectronFromUserAgent(wc: WebContents): void {
    const ua = wc
      .getUserAgent()
      .replace(/\s?(Electron|Drey)\/[^\s]+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    wc.setUserAgent(ua);
  }

  private wireSecurity(tabId: BrowserTabId, wc: WebContents): void {
    wc.on('will-navigate', (event, url) => {
      if (!/^(https?:|about:)/i.test(url)) {
        event.preventDefault();
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        this.requestOpenTab(url);
      } else if (/^mailto:/i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  }

  /**
   * A right-click menu for the embedded page. Electron shows no context
   * menu of its own, so this is the whole thing: navigation, the standard
   * clipboard verbs (gated on `params.editFlags`), link / image actions,
   * and "search the selection" -- link and search actions open a new
   * browser tab via the same `open-tab` push as a popup.
   */
  private wireContextMenu(wc: WebContents): void {
    wc.on('context-menu', (_event, params: ContextMenuParams) => {
      const win = this.win ?? this.getMainWindow();
      if (!win) {
        return;
      }
      const openTab = (url: string): void => this.requestOpenTab(url);
      const sep: MenuItemConstructorOptions = { type: 'separator' };
      const items: MenuItemConstructorOptions[] = [];

      items.push(
        {
          label: 'Back',
          enabled: wc.navigationHistory.canGoBack(),
          click: () => wc.navigationHistory.goBack(),
        },
        {
          label: 'Forward',
          enabled: wc.navigationHistory.canGoForward(),
          click: () => wc.navigationHistory.goForward(),
        },
        { label: 'Reload', click: () => wc.reload() },
      );

      if (params.linkURL) {
        items.push(sep, {
          label: 'Open link in new tab',
          click: () => openTab(params.linkURL),
        });
        items.push({
          label: 'Copy link address',
          click: () => void clipboard.writeText(params.linkURL),
        });
      }

      if (params.mediaType === 'image' && params.srcURL) {
        items.push(sep, {
          label: 'Open image in new tab',
          click: () => openTab(params.srcURL),
        });
        items.push({
          label: 'Copy image',
          click: () => wc.copyImageAt(params.x, params.y),
        });
        items.push({
          label: 'Copy image address',
          click: () => void clipboard.writeText(params.srcURL),
        });
      }

      const canPaste = params.editFlags.canPaste;
      if (params.isEditable || params.selectionText) {
        items.push(sep);
        if (params.isEditable) {
          items.push({
            label: 'Cut',
            enabled: params.editFlags.canCut,
            click: () => wc.cut(),
          });
        }
        items.push({
          label: 'Copy',
          enabled: params.editFlags.canCopy,
          click: () => wc.copy(),
        });
        if (params.isEditable) {
          items.push({ label: 'Paste', enabled: canPaste, click: () => wc.paste() });
        }
        items.push({
          label: 'Select all',
          enabled: params.editFlags.canSelectAll,
          click: () => wc.selectAll(),
        });
      }

      const selection = params.selectionText.trim();
      if (selection && !params.isEditable) {
        const q = selection.length > 40 ? `${selection.slice(0, 40)}…` : selection;
        items.push(sep, {
          label: `Search the web for "${q}"`,
          click: () => openTab(`https://duckduckgo.com/?q=${encodeURIComponent(selection)}`),
        });
      }

      items.push(sep, {
        label: 'Inspect element',
        click: () => wc.inspectElement(params.x, params.y),
      });

      Menu.buildFromTemplate(items).popup({ window: win });
    });
  }

  private wireEvents(tabId: BrowserTabId, wc: WebContents): void {
    const navState = (): { canGoBack: boolean; canGoForward: boolean } => ({
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
    const emitNav = (url: string): void =>
      this.send({ tabId, kind: 'did-navigate', url, ...navState() });

    wc.on('did-start-loading', () => this.send({ tabId, kind: 'loading', loading: true }));
    wc.on('did-stop-loading', () => this.send({ tabId, kind: 'loading', loading: false }));
    wc.on('did-navigate', (_e, url) => emitNav(url));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        emitNav(url);
      }
    });
    wc.on('page-title-updated', (_e, title) => this.send({ tabId, kind: 'title', title }));
    wc.on('page-favicon-updated', (_e, favicons) =>
      this.send({ tabId, kind: 'favicon', favicon: favicons[0] ?? null }),
    );
    wc.on('found-in-page', (_e, result) =>
      this.send({
        tabId,
        kind: 'found-in-page',
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      }),
    );
    wc.on('render-process-gone', (_e, details) =>
      this.send({ tabId, kind: 'crashed', reason: details.reason }),
    );
  }
}
