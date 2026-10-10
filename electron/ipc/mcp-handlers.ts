import { ipcMain } from 'electron';
import { IPC_CHANNELS, McpClientServerStatus, McpStatus } from '../../shared/ipc-api';
import { AppConfigStore } from '../app-config';
import { McpHttpTransport } from '../mcp';
import { McpClientManager } from '../mcp-client';
import { McpWriteBridge } from './mcp-write-bridge';
import { ToolApprovalBridge } from './tool-approval-bridge';

export interface McpHandlerDeps {
  appConfig: AppConfigStore;
  mcpHttp: McpHttpTransport;
  /** Absolute path to the bundled stdio-bridge script, for the client snippet. */
  stdioBridgePath: () => string;
  mcpWriteBridge: McpWriteBridge;
  mcpClients: McpClientManager;
  toolApprovalBridge: ToolApprovalBridge;
}

/** `mcp:status` for the Settings pane + the `mcp:write-decision` reply channel. */
export function registerMcpHandlers({
  appConfig,
  mcpHttp,
  stdioBridgePath,
  mcpWriteBridge,
  mcpClients,
  toolApprovalBridge,
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
  // The assistant's external MCP servers (ADR-0063).
  ipcMain.handle(IPC_CHANNELS.toolsStatus, (): McpClientServerStatus[] => mcpClients.status());
  ipcMain.handle(IPC_CHANNELS.toolsReconnect, async (_event, id: string): Promise<McpClientServerStatus[]> => {
    await mcpClients.reconnect(String(id));
    return mcpClients.status();
  });
  ipcMain.handle(IPC_CHANNELS.toolsApprovalDecision, (_event, id: number, approved: boolean): void => {
    toolApprovalBridge.resolveDecision(id, approved === true);
  });
}
