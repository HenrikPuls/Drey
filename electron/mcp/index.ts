/**
 * `electron/mcp` -- the vault MCP server (ADR-0021). Thin barrel; import
 * from here, never from a file inside (enforced by `eslint.config.mjs`).
 */
export { VaultTools, VAULT_TOOL_DEFS } from './vault-tools';
export type { ConfirmWrite, McpToolDef, McpToolResult, McpTextContent } from './vault-tools';
export { McpServer, PROTOCOL_VERSION } from './server';
export type { JsonRpcRequest, JsonRpcResponse } from './server';
export { McpHttpTransport } from './http-transport';
