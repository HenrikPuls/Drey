import { TestBed } from '@angular/core/testing';
import type { BrowserEvent, DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { OverlayGuardService } from '../services/overlay-guard.service';
import { BrowserViewService } from './browser-view.service';

describe('BrowserViewService', () => {
  let svc: BrowserViewService;
  let editor: EditorService;
  let calls: { name: string; arg: unknown }[];
  let eventListener: ((e: BrowserEvent) => void) | null;

  beforeEach(() => {
    calls = [];
    eventListener = null;
    const rec =
      (name: string) =>
      (arg: unknown): Promise<void> => {
        calls.push({ name, arg });
        return Promise.resolve();
      };
    const fakeApi: Partial<DreyApi> = {
      createBrowserView: rec('create'),
      destroyBrowserView: rec('destroy'),
      navigateBrowserView: rec('navigate'),
      setBrowserViewVisible: rec('visible'),
      setBrowserViewBounds: rec('bounds'),
      browserViewFind: rec('find'),
      browserViewStopFind: rec('stopFind'),
      onBrowserEvent: (listener) => {
        eventListener = listener;
        return () => undefined;
      },
      onBrowserOpenTab: () => () => undefined,    };
    window.dreyApi = fakeApi as DreyApi;
    svc = TestBed.inject(BrowserViewService);
    editor = TestBed.inject(EditorService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.clear();
  });

  function callsNamed(name: string): unknown[] {
    return calls.filter((c) => c.name === name).map((c) => c.arg);
  }

  it('openTab registers a browser doc and creates the native view with a normalised URL', () => {
    svc.openTab('example.com');

    const docs = editor.openDocs();
    expect(docs.length).toBe(1);
    expect(docs[0].kind).toBe('browser');
    expect(docs[0].path).toBe('browser://1');
    expect(callsNamed('create')).toEqual([
      { tabId: 'browser://1', url: 'https://example.com' },
    ]);
    expect(svc.tabState('browser://1')?.url).toBe('https://example.com');
  });

  it('openTab with no input opens about:blank', () => {
    svc.openTab();
    expect(callsNamed('create')).toEqual([{ tabId: 'browser://1', url: 'about:blank' }]);
  });

  it('mints a distinct key per tab', () => {
    svc.openTab();
    svc.openTab();
    expect(editor.openDocs().map((d) => d.path)).toEqual(['browser://1', 'browser://2']);
  });

  it('a title event updates the tab state and the tab name', () => {
    svc.openTab();
    eventListener!({ tabId: 'browser://1', kind: 'title', title: '  Example Domain  ' });
    expect(svc.tabState('browser://1')?.title).toBe('Example Domain');
    expect(editor.docFor('browser://1')?.name).toBe('Example Domain');
  });

  it('a favicon event lands in the tab state (the doc-kind slot reads it)', () => {
    svc.openTab();
    eventListener!({ tabId: 'browser://1', kind: 'favicon', favicon: 'https://x/f.ico' });
    expect(svc.tabState('browser://1')?.favicon).toBe('https://x/f.ico');
  });

  it('a did-navigate event updates url and nav state', () => {
    svc.openTab();
    eventListener!({
      tabId: 'browser://1',
      kind: 'did-navigate',
      url: 'https://example.com/page',
      canGoBack: true,
      canGoForward: false,
    });
    const state = svc.tabState('browser://1');
    expect(state?.url).toBe('https://example.com/page');
    expect(state?.canGoBack).toBe(true);
  });

  it('closing the tab destroys the native view and drops its state', () => {
    svc.openTab();
    editor.closeTab('browser://1');
    TestBed.tick(); // flush the openDocs() diff effect

    expect(callsNamed('destroy')).toEqual([{ tabId: 'browser://1' }]);
    expect(svc.tabState('browser://1')).toBeUndefined();
  });

  it('find steps to the next hit when the query is unchanged', () => {
    svc.openTab();
    svc.find('browser://1', 'foo', true);
    svc.find('browser://1', 'foo', true);
    const finds = callsNamed('find') as { findNext: boolean }[];
    expect(finds[0].findNext).toBe(false);
    expect(finds[1].findNext).toBe(true);
  });

  it('hides every view while an overlay guard is held', () => {
    svc.openTab();
    calls.length = 0;
    const release = TestBed.inject(OverlayGuardService).acquire();
    TestBed.tick();
    expect(callsNamed('visible')).toContainEqual({ tabId: 'browser://1', visible: false });
    release();
  });
});
