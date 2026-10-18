/**
 * `electron/mcp` -- the vault MCP server (ADR-0021). Thin barrel; import
 * from here, never from a file inside (enforced by `eslint.config.mjs`).
 */
export { VaultTools } from './vault-tools';
export { NO_VAULT } from './tools/types';
export type {
  ApproveAction,
  ConfirmWrite,
  McpToolDef,
  McpToolResult,
  McpTextContent,
  VaultCallOptions,
  VaultToolDeps,
  VaultWriteRule,
} from './vault-tools';
export { createVaultMcpServer, MCP_SERVER_NAME } from './server';
export { McpHttpTransport } from './http-transport';
export { PluginMcpTools } from './plugin-tools';
