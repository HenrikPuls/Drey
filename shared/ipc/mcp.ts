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
 * for the built-in `web_fetch`, `'web_search'` for `web_search`, otherwise
 * the MCP server id.
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

/** The text of one open tab, as the vault tools see it (ADR-0071). */
export interface OpenDocBuffer {
  vaultId: string;
  path: string;
  /** The buffer, `\n` line ends. */
  content: string;
  /** Whether the buffer differs from the file on disk. */
  dirty: boolean;
}

/**
 * What a vault tool asks the editor (milestone 78, ADR-0071): a tool reads
 * the buffer of an open file instead of the file on disk, and a change to
 * an open file goes into its tab.
 *
 *  - `peek`: the buffer of one file, when it is open in a tab;
 *  - `dirty`: every open vault file with unsaved changes;
 *  - `apply`: put `content` into the open tab — `save: true` also saves it
 *    (the on-save Actions stay out), `save: false` leaves it unsaved;
 *  - `moved` / `closed`: the file was moved or deleted on disk — the tab
 *    follows, or closes.
 */
export type OpenDocsRequest = { id: number } & (
  | { kind: 'peek'; vaultId: string; path: string }
  | { kind: 'dirty' }
  | {
      kind: 'apply';
      vaultId: string;
      path: string;
      content: string;
      save: boolean;
      /** Who changed it, for the local note history. */
      origin: string;
    }
  | { kind: 'moved'; vaultId: string; from: string; to: string }
  | { kind: 'closed'; vaultId: string; path: string }
);

/** The answer to an {@link OpenDocsRequest}; fields the request did not ask for are absent. */
export interface OpenDocsReply {
  /** `peek`: one entry or none; `dirty`: all of them. */
  buffers?: OpenDocBuffer[];
  /** `apply`: whether the tab took the text. */
  applied?: boolean;
  /** `apply` with `save`: whether the tab is clean afterwards. */
  saved?: boolean;
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

  /**
   * Subscribes to what the vault tools ask about open tabs (ADR-0071).
   * Answer every request with `replyOpenDocs(request.id, reply)`.
   */
  onOpenDocsRequest(listener: (request: OpenDocsRequest) => void): () => void;

  replyOpenDocs(id: number, reply: OpenDocsReply): Promise<void>;
}
