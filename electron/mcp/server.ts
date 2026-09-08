/**
 * A minimal MCP server: JSON-RPC 2.0 dispatch over the vault tool set
 * (`vault-tools.ts`). Transport-agnostic -- `http-transport.ts` feeds it
 * parsed request objects and the bundled stdio bridge proxies to that
 * over HTTP.
 *
 * Hand-rolled rather than `@modelcontextprotocol/sdk`: the SDK is
 * ESM-only and brings transitive deps, the main process compiles to
 * CommonJS, and a tools-only server is a short, stable surface
 * (`initialize`, `tools/list`, `tools/call`, `ping`). See
 * `docs/09_architecture_decisions/0021-mcp-vault-server.md`.
 */
import type { VaultTools } from './vault-tools';

/** The MCP revision this server speaks; clients echo it back in `initialize`. */
const PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export class McpServer {
  constructor(
    private readonly tools: VaultTools,
    private readonly serverVersion: string,
  ) {}

  /**
   * Handles one JSON-RPC message. Returns the response object, or `null`
   * for a notification (a request with no `id`, e.g.
   * `notifications/initialized`) which must not be answered.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (
      !isObject(message) ||
      message['jsonrpc'] !== '2.0' ||
      typeof message['method'] !== 'string'
    ) {
      return this.error(idOf(message), ERR.invalidRequest, 'Not a JSON-RPC 2.0 request.');
    }
    const req = message as unknown as JsonRpcRequest;
    const isNotification = req.id === undefined || req.id === null;

    try {
      switch (req.method) {
        case 'initialize':
          return this.ok(req.id ?? null, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'drey-vault', version: this.serverVersion },
          });

        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return this.ok(req.id ?? null, {});

        case 'tools/list':
          return this.ok(req.id ?? null, { tools: this.tools.list() });

        case 'tools/call': {
          if (isNotification) {
            return null;
          }
          const params = isObject(req.params) ? req.params : {};
          const name = typeof params['name'] === 'string' ? params['name'] : '';
          if (name === '') {
            return this.error(req.id ?? null, ERR.invalidParams, 'tools/call needs a tool name.');
          }
          const args = isObject(params['arguments'])
            ? (params['arguments'] as Record<string, unknown>)
            : {};
          const result = await this.tools.call(name, args);
          return this.ok(req.id ?? null, result);
        }

        default:
          return isNotification
            ? null
            : this.error(req.id ?? null, ERR.methodNotFound, `Unknown method: ${req.method}`);
      }
    } catch (err) {
      return isNotification
        ? null
        : this.error(
            req.id ?? null,
            ERR.internal,
            err instanceof Error ? err.message : String(err),
          );
    }
  }

  private ok(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(message: unknown): string | number | null {
  return isObject(message) &&
    (typeof message['id'] === 'string' || typeof message['id'] === 'number')
    ? (message['id'] as string | number)
    : null;
}

export { PROTOCOL_VERSION, ERR as JSON_RPC_ERRORS };
