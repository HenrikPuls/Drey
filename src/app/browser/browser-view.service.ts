import {
  Injectable,
  ApplicationRef,
  ComponentRef,
  computed,
  createComponent,
  effect,
  EnvironmentInjector,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { BrowserEvent, BrowserTabState } from '../../../shared/ipc-api';
import type { PluginDocKindContrib } from '../../../shared/plugin-api/renderer';
import { EditorService } from '../services/editor.service';
import { DocKindRegistry } from '../plugin-host';
import { LayoutGestureService } from '../services/layout-gesture.service';
import { OverlayGuardService } from '../services/overlay-guard.service';
import { BrowserTab } from './browser-tab';
import { normalizeAddress } from './normalize-address';

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

/**
 * Renderer-side owner of the in-editor web browser tabs (ADR-0042). Holds the per-tab chrome state, mints the `browser://<n>`
 * keys, drives the main-process `WebContentsView` over `window.dreyApi`,
 * and keeps `EditorService` (the tab registry) in step -- the page itself
 * never enters this DOM.
 *
 * `BrowserTabComponent` renders only the toolbar + a placeholder whose
 * rect it streams as the view's bounds; this service is where the state,
 * the event reducer and the lifecycle live so the component stays thin and
 * the logic stays testable.
 */
@Injectable({ providedIn: 'root' })
export class BrowserViewService {
  private readonly editor = inject(EditorService);
  private readonly overlayGuard = inject(OverlayGuardService);
  private readonly layout = inject(LayoutGestureService);
  private readonly docKinds = inject(DocKindRegistry);
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly appRef = inject(ApplicationRef);

  private readonly _state = signal<Record<string, BrowserTabState>>({});
  readonly state = this._state.asReadonly();

  /**
   * True when every browser view must be hidden: an Angular overlay is on
   * screen, or a layout drag (pane splitter / dock edge / panel header) is
   * in flight -- a `WebContentsView` paints above all DOM and trails a
   * fast drag by a frame. `BrowserTab` folds this into its own visibility.
   */
  readonly hidden = computed(() => this.overlayGuard.suppressed() || this.layout.active());

  private seq = 0;
  private readonly lastFindQuery = new Map<string, string>();
  /** The imperatively-mounted `BrowserTab` per open tab, for the focus slot. */
  private readonly mounted = new Map<string, ComponentRef<BrowserTab>>();

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  constructor() {
    this.api?.onBrowserEvent((event) => this.reduce(event));
    this.api?.onBrowserOpenTab(({ url }) => this.openTab(url));

    // The browser tab as a doc kind (ADR-0044 stage 8A): still a base
    // feature, but it reaches the pane through the same registry a plugin
    // will use in stage 8B -- the pane body, the tab-strip favicon and the
    // status-bar line resolve through it, and the session persists browser
    // tabs through its serialize/restore.
    this.docKinds.register(this.browserDocKind());

    // A browser tab removed from the registry (closed via the tab X, "close
    // all", …) -- tear its native view down. One authoritative path for
    // every close route.
    effect(() => {
      const alive = new Set(
        this.editor
          .openDocs()
          .filter((d) => d.kind === 'browser')
          .map((d) => d.path),
      );
      untracked(() => {
        for (const id of Object.keys(this._state())) {
          if (!alive.has(id)) {
            this.forget(id);
          }
        }
      });
    });

    // While `hidden` is true (an overlay is up, or a layout gesture is
    // running) force every view hidden so it can't paint over a menu /
    // dialog and doesn't trail the layout. Each `BrowserTab` re-asserts
    // its own visibility when `hidden` clears.
    effect(() => {
      if (this.hidden()) {
        untracked(() => {
          for (const id of Object.keys(this._state())) {
            void this.api?.setBrowserViewVisible({ tabId: id, visible: false });
          }
        });
      }
    });
  }

  tabState(tabId: string): BrowserTabState | undefined {
    return this._state()[tabId];
  }

  /** Opens a new browser tab (menu / `Ctrl+Shift+B` / a page's `target=_blank`). */
  openTab(rawInput?: string): void {
    const tabId = `browser://${++this.seq}`;
    const url = normalizeAddress(rawInput ?? '') || 'about:blank';
    this._state.update((s) => ({ ...s, [tabId]: { ...DEFAULT_STATE(tabId), url } }));
    this.editor.addPluginDoc('browser', tabId, 'New tab');
    void this.api?.createBrowserView({ tabId, url });
  }

  /**
   * Session restore (ADR-0043): re-creates a browser tab with its exact
   * previous `tabId` (so the persisted pane layout still references it) and
   * last URL. Bumps the id counter so a later `openTab()` won't collide.
   */
  restoreTab(tabId: string, lastUrl: string): void {
    const n = Number(tabId.replace('browser://', ''));
    if (Number.isFinite(n)) {
      this.seq = Math.max(this.seq, n);
    }
    const url = lastUrl && lastUrl !== 'about:blank' ? lastUrl : 'about:blank';
    this._state.update((s) => ({ ...s, [tabId]: { ...DEFAULT_STATE(tabId), url } }));
    this.editor.addPluginDoc('browser', tabId, 'New tab');
    void this.api?.createBrowserView({ tabId, url });
  }

  // --- chrome commands (called by BrowserTabComponent) -----------------

  navigate(tabId: string, rawInput: string): void {
    const url = normalizeAddress(rawInput);
    if (!url) {
      return;
    }
    this.patch(tabId, { url });
    void this.api?.navigateBrowserView({ tabId, url });
  }

  back(tabId: string): void {
    void this.api?.browserViewGoBack({ tabId });
  }
  forward(tabId: string): void {
    void this.api?.browserViewGoForward({ tabId });
  }
  reload(tabId: string): void {
    void this.api?.browserViewReload({ tabId });
  }
  stop(tabId: string): void {
    void this.api?.browserViewStop({ tabId });
  }

  setBounds(tabId: string, rect: { x: number; y: number; width: number; height: number }): void {
    void this.api?.setBrowserViewBounds({ tabId, rect });
  }

  setVisible(tabId: string, visible: boolean): void {
    void this.api?.setBrowserViewVisible({ tabId, visible });
  }

  openFind(tabId: string): void {
    this.patchFind(tabId, { open: true });
  }

  closeFind(tabId: string): void {
    this.patchFind(tabId, { open: false, query: '', activeMatch: 0, matches: 0 });
    this.lastFindQuery.delete(tabId);
    void this.api?.browserViewStopFind({ tabId, action: 'clearSelection' });
  }

  find(tabId: string, query: string, forward: boolean, matchCase = false): void {
    this.patchFind(tabId, { query });
    if (query === '') {
      void this.api?.browserViewStopFind({ tabId, action: 'clearSelection' });
      this.lastFindQuery.delete(tabId);
      return;
    }
    const findNext = this.lastFindQuery.get(tabId) === query;
    this.lastFindQuery.set(tabId, query);
    void this.api?.browserViewFind({ tabId, query, forward, findNext, matchCase });
  }

  // --- internals ------------------------------------------------------

  private reduce(event: BrowserEvent): void {
    const { tabId } = event;
    if (!this._state()[tabId]) {
      return;
    }
    switch (event.kind) {
      case 'did-navigate':
        this.patch(tabId, {
          url: event.url,
          canGoBack: event.canGoBack,
          canGoForward: event.canGoForward,
          crashed: false,
        });
        break;
      case 'loading':
        this.patch(tabId, { loading: event.loading });
        break;
      case 'title': {
        const title = event.title.trim() || 'New tab';
        this.patch(tabId, { title });
        this.editor.renameDoc(tabId, title);
        break;
      }
      case 'favicon':
        this.patch(tabId, { favicon: event.favicon });
        break;
      case 'found-in-page':
        this.patchFind(tabId, { activeMatch: event.activeMatchOrdinal, matches: event.matches });
        break;
      case 'crashed':
        this.patch(tabId, { crashed: true, loading: false });
        break;
    }
  }

  /**
   * The `DocKindRegistry` contribution (ADR-0044 stage 8A): everything the
   * pane body, tab strip, status bar and session need from a browser tab,
   * answered from the service's own chrome state. `mount` brings the
   * Angular `BrowserTab` in imperatively -- plugin kinds mount plain DOM,
   * but the seam must carry the built-in first.
   */
  private browserDocKind(): PluginDocKindContrib {
    return {
      kind: 'browser',
      icon: 'globe',
      serialize: (path) => ({ url: this.tabState(path)?.url ?? '' }),
      restore: (path, data) => {
        const url =
          typeof data === 'object' && data !== null && typeof (data as { url?: unknown }).url === 'string'
            ? (data as { url: string }).url
            : '';
        this.restoreTab(path, url);
      },
      favicon: (path) => this.tabState(path)?.favicon ?? null,
      statusText: (path) => {
        const url = this.tabState(path)?.url ?? '';
        return url && url !== 'about:blank' ? url : 'New tab';
      },
      onFocused: (path, focused) => this.mounted.get(path)?.setInput('focused', focused),
      mount: (el, path) => {
        const ref = createComponent(BrowserTab, {
          hostElement: el,
          environmentInjector: this.envInjector,
        });
        ref.setInput('tabId', path);
        this.appRef.attachView(ref.hostView);
        this.mounted.set(path, ref);
        return () => {
          this.mounted.delete(path);
          this.appRef.detachView(ref.hostView);
          ref.destroy();
        };
      },
    };
  }

  /** Drops a tab's chrome state and its native view. */
  private forget(tabId: string): void {
    this._state.update((s) => {
      const { [tabId]: _gone, ...rest } = s;
      return rest;
    });
    this.lastFindQuery.delete(tabId);
    void this.api?.destroyBrowserView({ tabId });
  }

  private patch(tabId: string, partial: Partial<BrowserTabState>): void {
    this._state.update((s) => {
      const cur = s[tabId];
      return cur ? { ...s, [tabId]: { ...cur, ...partial } } : s;
    });
  }

  private patchFind(tabId: string, partial: Partial<BrowserTabState['find']>): void {
    this._state.update((s) => {
      const cur = s[tabId];
      return cur ? { ...s, [tabId]: { ...cur, find: { ...cur.find, ...partial } } } : s;
    });
  }
}
