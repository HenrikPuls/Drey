/**
 * What the vault tools share (ADR-0071): the result shape, what a tool
 * needs from the rest of the app, and what one call may do.
 */
import type { AppConfig } from '../../../shared/app-config';
import type { RenameLinksRequest, RenameLinksResult, VaultFileEntry, VaultStatus } from '../../../shared/ipc-api';
import type {
  SectionSearchProvider,
  SemanticSearchProvider,
  TaskQueryProvider,
} from '../../../shared/plugin-api';

/** JSON-Schema-ish tool descriptor, as MCP `tools/list` returns it. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A single content block of a `tools/call` result. */
export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

/**
 * Asked before a change to a file hits disk, unless the caller writes
 * without asking. `vaultId` / `vaultName` are present when the change
 * targets a vault other than the active one.
 */
export type ConfirmWrite = (request: {
  path: string;
  before: string;
  after: string;
  mode: 'overwrite' | 'append';
  vaultId?: string;
  vaultName?: string;
  /** Set when the built-in assistant asks; the dialog names it. */
  origin?: 'assistant';
}) => Promise<boolean>;

/** Asked before a move or a delete — a change a diff cannot show. */
export type ApproveAction = (request: {
  tool: string;
  args: Record<string, unknown>;
}) => Promise<boolean>;

/** The slice of `VaultManager` the tools use. */
export interface ToolVault {
  listVaults(): VaultStatus[];
  getActiveVaultId(): string | null;
  listFiles(vaultId?: string): Promise<VaultFileEntry[]>;
  listMarkdownFiles(vaultId?: string): Promise<string[]>;
  readFile(relativePath: string, vaultId?: string): Promise<{ content: string; modifiedMs: number }>;
  writeFile(
    relativePath: string,
    content: string,
    vaultId?: string,
    opts?: { origin?: string },
  ): Promise<number>;
  deleteEntry(relativePath: string, vaultId?: string): Promise<{ trashed: boolean }>;
}

/** Everything the tool set is built over. */
export interface VaultToolDeps {
  vault: ToolVault;
  /** The section index (the tags plugin); `null` degrades a tag search with a clear error. */
  getSearchProvider: () => SectionSearchProvider | null;
  /** The task index (the tasks plugin); `null` degrades `tasks_list`. */
  getTaskProvider: () => TaskQueryProvider | null;
  /** Semantic retrieval (the assistant plugin, while enabled); `null` = `vault_retrieve` is not offered. */
  getSemanticProvider: () => SemanticSearchProvider | null;
  getConfig: () => AppConfig;
  confirmWrite: ConfirmWrite;
  approve: ApproveAction;
  /** A rename that keeps links intact (ADR-0059). */
  rename: (request: RenameLinksRequest) => Promise<RenameLinksResult>;
  /** Files changed or went away in one vault: index events and the renderer push. */
  announce: (changes: {
    vaultId: string;
    changedPaths: string[];
    deletedPaths: string[];
  }) => void;
  /** Something moved in a vault: rebuild its indexes and refresh the tree. */
  announceRefresh: (vaultId: string) => void;
}

/** Whether a call may change files, and whether it asks first. */
export type VaultWriteRule = 'off' | 'confirm' | 'auto';

/** What one call — or one tool listing — is allowed. */
export interface VaultCallOptions {
  /**
   * The vaults this call may touch (the assistant's Vault chip). Absent:
   * every registered vault. A `vault` argument outside it is refused.
   */
  scope?: readonly string[];
  /** Absent: `mcp.yolo` decides between `auto` and `confirm`. */
  write?: VaultWriteRule;
  /** Who writes, for the local note history. Default `mcp`. */
  origin?: 'mcp' | 'assistant';
  /**
   * The app's own folders — `chats/` and `.drafts/` — stay out of
   * listings and searches and cannot be changed (the assistant; a
   * connected program sees the vault as it is).
   */
  protectAppFolders?: boolean;
}

export function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A failed call. The text says what was wrong and how to correct it. */
export function fail(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
