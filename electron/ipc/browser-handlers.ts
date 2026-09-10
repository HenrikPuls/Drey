import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-api';
import type {
  BrowserCreateArgs,
  BrowserFindArgs,
  BrowserNavigateArgs,
  BrowserSetBoundsArgs,
  BrowserSetVisibleArgs,
  BrowserStopFindArgs,
  BrowserTabRef,
} from '../../shared/browser';
import { BrowserViewManager } from '../browser';

export interface BrowserHandlerDeps {
  browserViews: BrowserViewManager;
}

/**
 * Renderer -> main control channels for the in-editor web browser tab
 * (Req-19, ADR-0040). Every handler is a thin delegate onto
 * `BrowserViewManager`; the interesting logic (bounds math, security
 * handlers, event forwarding) lives there. Events flow back the other way
 * on `browser:event` / `browser:open-tab`, sent by the manager.
 */
export function registerBrowserHandlers({ browserViews }: BrowserHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.browserCreate, (_e, args: BrowserCreateArgs): void => {
    browserViews.create(args.tabId, args.url);
  });
  ipcMain.handle(IPC_CHANNELS.browserDestroy, (_e, ref: BrowserTabRef): void => {
    browserViews.destroy(ref.tabId);
  });
  ipcMain.handle(IPC_CHANNELS.browserSetBounds, (_e, args: BrowserSetBoundsArgs): void => {
    browserViews.setBounds(args.tabId, args.rect);
  });
  ipcMain.handle(IPC_CHANNELS.browserSetVisible, (_e, args: BrowserSetVisibleArgs): void => {
    browserViews.setVisible(args.tabId, args.visible);
  });
  ipcMain.handle(IPC_CHANNELS.browserNavigate, (_e, args: BrowserNavigateArgs): void => {
    browserViews.navigate(args.tabId, args.url);
  });
  ipcMain.handle(IPC_CHANNELS.browserGoBack, (_e, ref: BrowserTabRef): void => {
    browserViews.goBack(ref.tabId);
  });
  ipcMain.handle(IPC_CHANNELS.browserGoForward, (_e, ref: BrowserTabRef): void => {
    browserViews.goForward(ref.tabId);
  });
  ipcMain.handle(IPC_CHANNELS.browserReload, (_e, ref: BrowserTabRef): void => {
    browserViews.reload(ref.tabId);
  });
  ipcMain.handle(IPC_CHANNELS.browserStop, (_e, ref: BrowserTabRef): void => {
    browserViews.stop(ref.tabId);
  });
  ipcMain.handle(IPC_CHANNELS.browserFind, (_e, args: BrowserFindArgs): void => {
    browserViews.find(args.tabId, args.query, args.forward, args.findNext, args.matchCase);
  });
  ipcMain.handle(IPC_CHANNELS.browserStopFind, (_e, args: BrowserStopFindArgs): void => {
    browserViews.stopFind(args.tabId, args.action);
  });
}
