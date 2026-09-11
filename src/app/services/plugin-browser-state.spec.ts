import type { BrowserEvent } from '../../../plugins/browser/shared/browser';
import {
  createBrowserStore,
  type BrowserPorts,
  type BrowserStoreLinks,
} from '../../../plugins/browser/renderer/state';

describe('browser plugin store', () => {
  let calls: { name: string; arg: unknown }[];
  let docs: string[];
  let renamed: Array<{ tabId: string; title: string }>;
  let store: ReturnType<typeof createBrowserStore>;

  beforeEach(() => {
    calls = [];
    docs = [];
    renamed = [];
    const rec =
      (name: string) =>
      (arg: unknown): void => {
        calls.push({ name, arg });
      };
    const ports: BrowserPorts = {
      create: rec('create'),
      destroy: rec('destroy'),
      setBounds: rec('bounds'),
      setVisible: rec('visible'),
      navigate: rec('navigate'),
      goBack: rec('back'),
      goForward: rec('forward'),
      reload: rec('reload'),
      stop: rec('stop'),
      find: rec('find'),
      stopFind: rec('stopFind'),
    };
    const links: BrowserStoreLinks = {
      openDoc: (tabId) => docs.push(tabId),
      renameDoc: (tabId, title) => renamed.push({ tabId, title }),
    };
    store = createBrowserStore(ports, links);
  });

  function callsNamed(name: string): unknown[] {
    return calls.filter((c) => c.name === name).map((c) => c.arg);
  }

  it('openTab registers a browser doc and creates the native view with a normalised URL', () => {
    store.openTab('example.com');

    expect(docs).toEqual(['browser://1']);
    expect(callsNamed('create')).toEqual([{ tabId: 'browser://1', url: 'https://example.com' }]);
    expect(store.tabState('browser://1')?.url).toBe('https://example.com');
  });

  it('openTab with no input opens about:blank', () => {
    store.openTab();
    expect(callsNamed('create')).toEqual([{ tabId: 'browser://1', url: 'about:blank' }]);
  });

  it('mints a distinct key per tab', () => {
    store.openTab();
    store.openTab();
    expect(docs).toEqual(['browser://1', 'browser://2']);
  });

  it('a title event updates the tab state and renames the doc', () => {
    store.openTab();
    store.reduce({ tabId: 'browser://1', kind: 'title', title: '  Example Domain  ' });
    expect(store.tabState('browser://1')?.title).toBe('Example Domain');
    expect(renamed).toEqual([{ tabId: 'browser://1', title: 'Example Domain' }]);
  });

  it('a favicon event lands in the tab state (the doc-kind slot reads it)', () => {
    store.openTab();
    store.reduce({ tabId: 'browser://1', kind: 'favicon', favicon: 'https://x/f.ico' });
    expect(store.tabState('browser://1')?.favicon).toBe('https://x/f.ico');
  });

  it('a did-navigate event updates url and nav state', () => {
    store.openTab();
    store.reduce({
      tabId: 'browser://1',
      kind: 'did-navigate',
      url: 'https://example.com/page',
      canGoBack: true,
      canGoForward: false,
    });
    const state = store.tabState('browser://1');
    expect(state?.url).toBe('https://example.com/page');
    expect(state?.canGoBack).toBe(true);
  });

  it('closing the doc destroys the native view and drops its state', () => {
    store.openTab();
    // The tab X removed the doc -- the docs-changed sync runs with the
    // survivors.
    store.syncOpenDocs([]);

    expect(callsNamed('destroy')).toEqual([{ tabId: 'browser://1' }]);
    expect(store.tabState('browser://1')).toBeUndefined();
  });

  it('syncOpenDocs keeps tabs that are still open', () => {
    store.openTab();
    store.openTab();
    store.syncOpenDocs(['browser://2']);
    expect(callsNamed('destroy')).toEqual([{ tabId: 'browser://1' }]);
    expect(store.tabState('browser://2')).toBeDefined();
  });

  it('restoreTab re-uses the persisted key and bumps the key counter', () => {
    store.restoreTab('browser://5', 'https://example.com/old');

    expect(docs).toEqual(['browser://5']);
    expect(callsNamed('create')).toEqual([
      { tabId: 'browser://5', url: 'https://example.com/old' },
    ]);

    store.openTab();
    expect(docs).toEqual(['browser://5', 'browser://6']);
  });

  it('restoreTab falls back to about:blank', () => {
    store.restoreTab('browser://1', '');
    expect(callsNamed('create')).toEqual([{ tabId: 'browser://1', url: 'about:blank' }]);
  });

  it('find steps to the next hit when the query is unchanged', () => {
    store.openTab();
    store.find('browser://1', 'foo', true);
    store.find('browser://1', 'foo', true);
    const finds = callsNamed('find') as { findNext: boolean }[];
    expect(finds[0].findNext).toBe(false);
    expect(finds[1].findNext).toBe(true);
  });

  it('closeFind stops the search and resets the counters', () => {
    store.openTab();
    store.openFind('browser://1');
    store.find('browser://1', 'foo', true);
    store.closeFind('browser://1');

    const state = store.tabState('browser://1')!;
    expect(state.find).toEqual({ open: false, query: '', activeMatch: 0, matches: 0 });
    expect(callsNamed('stopFind')).toEqual([{ tabId: 'browser://1', action: 'clearSelection' }]);
  });

  it('setHidden flips the visibility flag the chromes assert', () => {
    expect(store.hidden()).toBe(false);
    store.setHidden(true);
    expect(store.hidden()).toBe(true);
    store.setHidden(true);
    store.setHidden(false);
    expect(store.hidden()).toBe(false);
  });

  it('reduce ignores events for unknown tabs', () => {
    const event: BrowserEvent = { tabId: 'browser://9', kind: 'loading', loading: true };
    store.reduce(event);
    expect(store.tabState('browser://9')).toBeUndefined();
  });
});
