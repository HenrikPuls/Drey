/**
 * The two fixed plugin channels + the discovery report (ADR-0044). The
 * plugin host owns everything behind them; this file only bridges
 * `ipcMain` to it. `plugin:event` is a push (host -> renderer) and has no
 * `ipcMain` side.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-api';
import type { PluginIpcInvokePayload } from '../../shared/plugin-api';
import type { PluginHost } from '../plugin-host';
import type { IpcHandlerDeps } from './index';

export function registerPluginHandlers(deps: IpcHandlerDeps): void {
  const host: PluginHost = deps.pluginHost;

  // Both handlers await activation (milestone 61): with the window
  // created before plugin activation finishes, the renderer can reach
  // these while the host is still filling — the gate serves the
  // post-activation view instead of an empty/half-registered one.
  ipcMain.handle(IPC_CHANNELS.pluginList, async () => {
    await host.activationDone();
    return host.listForRenderer();
  });

  ipcMain.handle(IPC_CHANNELS.pluginInvoke, async (event, payload: PluginIpcInvokePayload) => {
    // Defensive shape check: the payload comes from the contextBridge, but
    // never trust the wire — a malformed request is a rejection, not a crash.
    if (
      payload === null ||
      typeof payload !== 'object' ||
      typeof (payload as PluginIpcInvokePayload).pluginId !== 'string' ||
      typeof (payload as PluginIpcInvokePayload).method !== 'string'
    ) {
      throw new Error('malformed plugin:invoke payload');
    }
    await host.activationDone();
    return host.handleInvoke(payload, event.sender);
  });
}
