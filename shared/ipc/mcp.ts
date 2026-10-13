/**
 * IPC contract, MCP part: the vault server Drey offers (ADR-0021) and
 * the assistant's external tools (ADR-0063)
 * (`shared/ipc-api.ts` is the barrel).
 */

/**
 * A `vault_write` an MCP client asked for, pushed to the renderer so the
 * user can confirm it in the shared diff dialog before it hits disk
 * (skipped entirely in YOLO mode). The renderer replies via
 * `resolveMcpWrite(id, approved)`. `vaultId`/`vaultName` name the target
 * vault for the dialog's header (absent in old payloads / the default
 * active-vault case).
 */
export interface McpWriteRequest {
  id: number;
  path: string;
  before: string;
  after: string;
  mode: 'overwrite' | 'append';
  vaultId?: string;
  vaultName?: string;
  /** Set when the built-in assistant asks (a tool group on `confirm`, ADR-0063). */
  origin?: 'assistant';
}

/** One configured external MCP server as the Settings page shows it (ADR-0063). */
export interface McpClientServerStatus {
  id: string;
  state: 'connecting' | 'ready' | 'error';
  error: string | null;
  /** The server's own tool names (without the `mcp__<id>__` prefix). */
  tools: string[];
}

/**
 * One external tool call waiting for the user (ADR-0063): pushed to the
 * renderer when the call's source is set to "ask". `source` is `'web'`
 * for the built-in `web_fetch`, otherwise the MCP server id.
 */
export interface ToolApprovalRequest {
  id: number;
  source: string;
  sourceName: string;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Asked every time (a move or a delete in the vault, ADR-0071): the
   * dialog offers no "Always allow".
   */
  once?: boolean;
}

/** What `getMcpStatus` reports for the Settings pane. */
export interface McpStatus {
  enabled: boolean;
  httpListening: boolean;
  httpPort: number | null;
  /** Absolute path to the stdio bridge script, for the client config snippet. */
  stdioBridgePath: string;
}

/** The MCP vault server and the external tool servers. */
export interface McpIpc {
  /** Current MCP vault server state for the Settings pane (ADR-0021). */
  getMcpStatus(): Promise<McpStatus>;

  /**
   * Subscribes to `vault_write` requests from an MCP client. The renderer
   * shows the shared confirmation diff and answers with
   * `resolveMcpWrite(request.id, approved)`. Never fires in YOLO mode.
   * Returns an unsubscribe; the raw IPC event is never forwarded.
   */
  onMcpWriteRequest(listener: (request: McpWriteRequest) => void): () => void;

  /** Answers an `onMcpWriteRequest` (approve / reject the write). */
  resolveMcpWrite(id: number, approved: boolean): Promise<void>;

  /** Connection state of the configured external MCP servers (ADR-0063). */
  getToolsStatus(): Promise<McpClientServerStatus[]>;

  /** Drops and re-opens one external MCP server connection. */
  reconnectToolServer(id: string): Promise<McpClientServerStatus[]>;

  /**
   * Subscribes to external tool calls that need the user's approval
   * (ADR-0063). Answer with `resolveToolApproval(request.id, approved)`.
   */
  onToolApprovalRequest(listener: (request: ToolApprovalRequest) => void): () => void;

  resolveToolApproval(id: number, approved: boolean): Promise<void>;
}
