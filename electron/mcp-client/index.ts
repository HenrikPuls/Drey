import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientServer } from '../../shared/app-config';
import { McpClientManager } from './mcp-client-manager';

export { AssistantToolbox } from './assistant-toolbox';
export type { ApproveToolCall } from './assistant-toolbox';
export { McpClientManager } from './mcp-client-manager';

/** The SDK transport for one configured server (ADR-0063). */
function createTransport(server: McpClientServer): Transport {
  const { transport } = server;
  if (transport.kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(transport.url), {
      requestInit: { headers: transport.headers },
    });
  }
  if (transport.command === '') {
    throw new Error('No command configured.');
  }
  return new StdioClientTransport({
    command: transport.command,
    args: transport.args,
    env: { ...getDefaultEnvironment(), ...transport.env },
    stderr: 'ignore',
  });
}

/** The manager over the real SDK client and transports. */
export function createMcpClientManager(
  version: string,
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
): McpClientManager {
  return new McpClientManager({
    createClient: () => new Client({ name: 'drey', version }, { capabilities: {} }),
    createTransport,
    log,
  });
}
