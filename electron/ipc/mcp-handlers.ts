import { ipcMain } from 'electron';
import { IPC_CHANNELS, McpStatus } from '../../shared/ipc-api';
import { AppConfigStore } from '../app-config';
import { McpHttpTransport } from '../mcp';
import { McpWriteBridge } from './mcp-write-bridge';

export interface McpHandlerDeps {
  appConfig: AppConfigStore;
  mcpHttp: McpHttpTransport;
  /** Absolute path to the bundled stdio-bridge script, for the client snippet. */
  stdioBridgePath: () => string;
  mcpWriteBridge: McpWriteBridge;
}

/** `mcp:status` for the Settings pane + the `mcp:write-decision` reply channel. */
export function registerMcpHandlers({
  appConfig,
  mcpHttp,
  stdioBridgePath,
  mcpWriteBridge,
}: McpHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.mcpStatus, (): McpStatus => ({
    enabled: appConfig.get().mcp.enabled,
    httpListening: mcpHttp.running,
    httpPort: mcpHttp.activePort,
    stdioBridgePath: stdioBridgePath(),
  }));
  ipcMain.handle(IPC_CHANNELS.mcpWriteDecision, (_event, id: number, approved: boolean): void => {
    mcpWriteBridge.resolveDecision(id, approved);
  });
}
