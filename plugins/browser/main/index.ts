import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import type {
  BrowserCreateArgs,
  BrowserFindArgs,
  BrowserNavigateArgs,
  BrowserSetBoundsArgs,
  BrowserSetVisibleArgs,
  BrowserStopFindArgs,
  BrowserTabRef,
} from '../shared/browser.js';
import { BrowserViewManager } from './view-manager.js';

/** Reads one string field out of an untrusted bridge payload. */
function str(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' ? value : '';
}

function num(payload: unknown, field: string): number {
  const value = (payload as Record<string, unknown> | null)?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bool(payload: unknown, field: string): boolean {
  return (payload as Record<string, unknown> | null)?.[field] === true;
}

/**
 * The browser plugin's main entry (ADR-0042; converted in ADR-0044 stage
 * 8B): owns the native `WebContentsView` per tab and binds it to the main
 * window's lifecycle. The interesting logic (bounds math, security
 * handlers, event forwarding) lives in `BrowserViewManager`; these
 * handlers are thin delegates, exactly as the old `browser-handlers.ts`
 * was. Events flow back as `event` / `open-tab` pushes over the generic
 * plugin bridge.
 */
const plugin: MainPluginModule = {
  activate(ctx: MainPluginContext) {
    const manager = new BrowserViewManager(
      () => ctx.app.getMainWindow(),
      (event) => ctx.ipc.emit('event', event),
      (url) => ctx.ipc.emit('open-tab', { url }),
    );

    // The window arrives after activation (plugins activate first) -- bind
    // then, and drop every view with it. `onWillQuit` is the shutdown
    // backstop.
    ctx.app.onMainWindowCreated((win) => {
      manager.attach(win);
      win.on('closed', () => manager.destroyAll());
    });
    ctx.app.onWillQuit(() => manager.destroyAll());

    ctx.ipc.handle('create', (payload) => {
      const args = payload as BrowserCreateArgs;
      manager.create(str(args, 'tabId'), str(args, 'url'));
    });
    ctx.ipc.handle('destroy', (payload) => {
      manager.destroy(str(payload as BrowserTabRef, 'tabId'));
    });
    ctx.ipc.handle('set-bounds', (payload) => {
      const args = payload as BrowserSetBoundsArgs | null;
      const tabId = str(args, 'tabId');
      const rect = args?.rect;
      if (tabId && rect && typeof rect === 'object') {
        manager.setBounds(tabId, {
          x: num(rect, 'x'),
          y: num(rect, 'y'),
          width: num(rect, 'width'),
          height: num(rect, 'height'),
        });
      }
    });
    ctx.ipc.handle('set-visible', (payload) => {
      manager.setVisible(str(payload as BrowserSetVisibleArgs, 'tabId'), bool(payload, 'visible'));
    });
    ctx.ipc.handle('navigate', (payload) => {
      const args = payload as BrowserNavigateArgs;
      manager.navigate(str(args, 'tabId'), str(args, 'url'));
    });
    ctx.ipc.handle('go-back', (payload) => {
      manager.goBack(str(payload as BrowserTabRef, 'tabId'));
    });
    ctx.ipc.handle('go-forward', (payload) => {
      manager.goForward(str(payload as BrowserTabRef, 'tabId'));
    });
    ctx.ipc.handle('reload', (payload) => {
      manager.reload(str(payload as BrowserTabRef, 'tabId'));
    });
    ctx.ipc.handle('stop', (payload) => {
      manager.stop(str(payload as BrowserTabRef, 'tabId'));
    });
    ctx.ipc.handle('find', (payload) => {
      const args = payload as BrowserFindArgs;
      manager.find(
        str(args, 'tabId'),
        str(args, 'query'),
        bool(args, 'forward'),
        bool(args, 'findNext'),
        bool(args, 'matchCase'),
      );
    });
    ctx.ipc.handle('stop-find', (payload) => {
      const args = payload as BrowserStopFindArgs;
      const action = str(args, 'action');
      if (action === 'clearSelection' || action === 'keepSelection' || action === 'activateSelection') {
        manager.stopFind(str(args, 'tabId'), action);
      }
    });

    ctx.log('activated');
  },
};

export default plugin;
