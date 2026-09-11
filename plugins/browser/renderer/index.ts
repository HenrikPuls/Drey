import type {
  DreyPluginApi,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import type { BrowserEvent, BrowserOpenTabRequest } from '../shared/browser.js';
import { mountBrowserTab, type BrowserTabHandle } from './browser-tab.js';
import { createBrowserStore, type BrowserPorts, type BrowserStore } from './state.js';

/**
 * The browser plugin's renderer (ADR-0042; converted in ADR-0044 stage
 * 8B): the per-tab chrome state (`createBrowserStore`), the `browser` doc
 * kind (pane chrome via `mountBrowserTab`, favicon/status slots, session
 * serialize/restore), the `browser.new` command with its File-menu row, and
 * the three host subscriptions -- native-view events and `target="_blank"`
 * pushes arrive over `backend.on`, "an overlay is up / a layout gesture is
 * running" over `env.onNativeSurfaceVisibility`.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    const ports: BrowserPorts = {
      create: (args) => void api.backend.invoke('create', args),
      destroy: (args) => void api.backend.invoke('destroy', args),
      setBounds: (args) => void api.backend.invoke('set-bounds', args),
      setVisible: (args) => void api.backend.invoke('set-visible', args),
      navigate: (args) => void api.backend.invoke('navigate', args),
      goBack: (args) => void api.backend.invoke('go-back', args),
      goForward: (args) => void api.backend.invoke('go-forward', args),
      reload: (args) => void api.backend.invoke('reload', args),
      stop: (args) => void api.backend.invoke('stop', args),
      find: (args) => void api.backend.invoke('find', args),
      stopFind: (args) => void api.backend.invoke('stop-find', args),
    };

    const store: BrowserStore = createBrowserStore(ports, {
      openDoc: (tabId) => api.documents.addDoc('browser', tabId, 'New tab'),
      renameDoc: (tabId, title) => api.documents.rename(tabId, title),
    });

    // Native-view events + a page's target="_blank" (the old fixed
    // `browser:*` push channels, now generic plugin pushes).
    api.backend.on('event', (data) => store.reduce(data as BrowserEvent));
    api.backend.on('open-tab', (data) => {
      const url = (data as BrowserOpenTabRequest | null)?.url;
      if (typeof url === 'string') {
        store.openTab(url);
      }
    });

    // An Angular overlay is up or a layout drag runs -- every view hides
    // (it paints above all DOM); each mounted chrome re-asserts visibility
    // when the push clears.
    api.env.onNativeSurfaceVisibility((hidden) => store.setHidden(hidden));

    // A browser doc removed from the registry (closed via the tab X, "close
    // all", ...) -- tear its state and native view down. One authoritative
    // path for every close route.
    const syncOpenDocs = (): void =>
      store.syncOpenDocs(
        api
          .documents.list()
          .filter((doc) => doc.kind === 'browser')
          .map((doc) => doc.path),
      );
    api.documents.onChange((event) => {
      if (event.type === 'docs-changed') {
        syncOpenDocs();
      }
    });
    syncOpenDocs();

    // The mounted pane chromes, for the doc kind's focus slot.
    const mounted = new Map<string, BrowserTabHandle>();

    api.ui.registerDocKind({
      kind: 'browser',
      icon: 'globe',
      serialize: (path) => ({ url: store.tabState(path)?.url ?? '' }),
      restore: (path, data) => {
        const url =
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { url?: unknown }).url === 'string'
            ? (data as { url: string }).url
            : '';
        store.restoreTab(path, url);
      },
      favicon: (path) => store.tabState(path)?.favicon ?? null,
      statusText: (path) => {
        const url = store.tabState(path)?.url ?? '';
        return url && url !== 'about:blank' ? url : 'New tab';
      },
      onFocused: (path, focused) => mounted.get(path)?.setFocused(focused),
      mount: (el, path) => {
        const handle = mountBrowserTab(el, path, store, ports);
        mounted.set(path, handle);
        return () => {
          mounted.delete(path);
          handle.cleanup();
        };
      },
    });

    // Command + File row (moved out of the base app.ts / menu bar).
    api.commands.register({
      id: 'browser.new',
      label: 'New browser tab',
      keybinding: 'Mod+Shift+B',
      run: () => store.openTab(),
    });
    api.ui.registerMenuContributions([
      {
        menu: 'file',
        label: 'New browser tab',
        hint: 'Ctrl Shift B',
        commandId: 'browser.new',
      },
    ]);
  },
};

export default plugin;
