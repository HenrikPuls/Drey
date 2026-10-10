/**
 * The vault MCP server: the protocol layer of the official
 * `@modelcontextprotocol/sdk` over the vault tool set (`vault-tools.ts`).
 * Tools only. Transport-agnostic -- `http-transport.ts` connects one
 * instance per request and the bundled stdio bridge proxies to that over
 * HTTP.
 *
 * The low-level `Server` rather than the SDK's `McpServer` helper: the
 * tool definitions already are JSON Schemas, and `VaultTools.call`
 * already answers in the `tools/call` result shape. Hand-rolled until
 * milestone 63 (ADR-0021, later change; ADR-0063).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { VaultTools } from './vault-tools';

export const MCP_SERVER_NAME = 'drey-vault';

/** A fresh server over the tool set; the caller connects it to a transport. */
export function createVaultMcpServer(tools: VaultTools, version: string): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools.list()] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Unknown names and bad arguments come back as `isError` text from
    // `VaultTools`, so the model can correct itself.
    const result = await tools.call(request.params.name, request.params.arguments ?? {});
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });
  return server;
}
