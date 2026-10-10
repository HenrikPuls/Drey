import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientServer } from '../../shared/app-config';
import type { McpClientServerStatus } from '../../shared/ipc-api';
import type { ToolSpec } from '../../shared/llm';

/** The prefix every external tool carries: `mcp__<serverId>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__';
/** Provider limit on a function name (OpenAI and Anthropic both cap at 64). */
const TOOL_NAME_MAX = 64;
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
/** A tool result lands in the chat note as one `drey-tool` line. */
export const TOOL_RESULT_MAX_CHARS = 20_000;

/** The part of the SDK `Client` the manager uses -- the seam the specs fake. */
export type McpClientLike = Pick<Client, 'connect' | 'listTools' | 'callTool' | 'close'> & {
  onclose?: () => void;
};

export interface McpClientManagerDeps {
  createClient: () => McpClientLike;
  createTransport: (server: McpClientServer) => Transport;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

interface RemoteTool {
  /** The name the model sees. */
  exposed: string;
  /** The name the server knows. */
  remote: string;
  spec: ToolSpec;
}

interface Connection {
  server: McpClientServer;
  /** `JSON.stringify(transport)` -- a change means reconnect. */
  signature: string;
  client: McpClientLike | null;
  state: 'connecting' | 'ready' | 'error';
  error: string | null;
  tools: RemoteTool[];
  connecting: Promise<void> | null;
}

/** `mcp__<serverId>__<tool>`, cut to the provider limit. */
export function exposedToolName(serverId: string, tool: string): string {
  const safe = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${MCP_TOOL_PREFIX}${serverId}__${safe}`.slice(0, TOOL_NAME_MAX);
}

/** The server id inside an exposed name, or `null` for any other tool. */
export function serverIdOfTool(name: string): string | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const cut = rest.indexOf('__');
  return cut > 0 ? rest.slice(0, cut) : null;
}

/** Flattens a `tools/call` result to the text the model reads, capped. */
export function flattenToolResult(result: unknown): string {
  const shape = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  for (const block of Array.isArray(shape.content) ? shape.content : []) {
    const item = (block ?? {}) as { type?: unknown; text?: unknown; resource?: { text?: unknown; uri?: unknown } };
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (item.type === 'resource' && typeof item.resource?.text === 'string') {
      parts.push(item.resource.text);
    } else if (typeof item.type === 'string') {
      parts.push(`[${item.type} omitted]`);
    }
  }
  if (parts.length === 0 && shape.structuredContent !== undefined) {
    parts.push(JSON.stringify(shape.structuredContent));
  }
  let text = parts.join('\n').trim();
  if (text === '') {
    text = shape.isError === true ? 'The tool reported an error without a message.' : '(empty result)';
  }
  if (text.length > TOOL_RESULT_MAX_CHARS) {
    text = `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated, ${text.length - TOOL_RESULT_MAX_CHARS} more characters]`;
  }
  return shape.isError === true ? `Error: ${text}` : text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The connections to the external MCP servers the user configured
 * (milestone 63, ADR-0063): one SDK client per enabled server, its tool
 * list cached after connecting. Tools only -- no resources, prompts or
 * sampling. A server that fails stays in the list with its error; a call
 * to it retries the connection once.
 */
export class McpClientManager {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly deps: McpClientManagerDeps) {}

  /** Brings the connections in line with the configured servers. */
  sync(servers: readonly McpClientServer[]): void {
    const wanted = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));
    for (const [id, connection] of this.connections) {
      const next = wanted.get(id);
      if (next === undefined || JSON.stringify(next.transport) !== connection.signature) {
        this.drop(id);
      } else {
        connection.server = next;
      }
    }
    for (const [id, server] of wanted) {
      if (!this.connections.has(id)) {
        this.open(server);
      }
    }
  }

  /** Drops and re-opens one connection (Settings → "Reconnect"). */
  async reconnect(id: string): Promise<void> {
    const server = this.connections.get(id)?.server;
    if (server === undefined) {
      return;
    }
    this.drop(id);
    await this.open(server).connecting;
  }

  status(): McpClientServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      id: c.server.id,
      state: c.state,
      error: c.error,
      tools: c.tools.map((t) => t.remote),
    }));
  }

  /** The tools of every connected server, as the model sees them. */
  toolSpecs(): ToolSpec[] {
    return [...this.connections.values()].flatMap((c) =>
      c.state === 'ready' ? c.tools.map((t) => t.spec) : [],
    );
  }

  server(id: string): McpClientServer | null {
    return this.connections.get(id)?.server ?? null;
  }

  /** The server-side name behind an exposed tool name. */
  remoteToolName(name: string): string | null {
    const id = serverIdOfTool(name);
    const tool = id === null ? undefined : this.connections.get(id)?.tools.find((t) => t.exposed === name);
    return tool?.remote ?? null;
  }

  /** Runs one tool; failures come back as text the model can react to. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const id = serverIdOfTool(name);
    let connection = id === null ? undefined : this.connections.get(id);
    if (connection === undefined) {
      return `Error: unknown tool ${name}.`;
    }
    if (connection.state !== 'ready') {
      const server = connection.server;
      this.drop(server.id);
      connection = this.open(server);
      await connection.connecting;
    }
    const tool = connection.tools.find((t) => t.exposed === name);
    if (connection.state !== 'ready' || connection.client === null) {
      return `Error: the server "${connection.server.name}" is not connected (${connection.error ?? 'unknown error'}).`;
    }
    if (tool === undefined) {
      return `Error: unknown tool ${name}.`;
    }
    try {
      const result = await connection.client.callTool(
        { name: tool.remote, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) },
      );
      return flattenToolResult(result);
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      return `Error: ${errorText(err)}`;
    }
  }

  async dispose(): Promise<void> {
    const ids = [...this.connections.keys()];
    await Promise.all(ids.map((id) => this.drop(id)));
  }

  private open(server: McpClientServer): Connection {
    const connection: Connection = {
      server,
      signature: JSON.stringify(server.transport),
      client: null,
      state: 'connecting',
      error: null,
      tools: [],
      connecting: null,
    };
    this.connections.set(server.id, connection);
    connection.connecting = this.connect(connection);
    return connection;
  }

  private async connect(connection: Connection): Promise<void> {
    const { server } = connection;
    let client: McpClientLike | null = null;
    try {
      client = this.deps.createClient();
      await client.connect(this.deps.createTransport(server), { timeout: CONNECT_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      if (this.connections.get(server.id) !== connection) {
        // Dropped or replaced while connecting.
        void client.close().catch(() => undefined);
        return;
      }
      const seen = new Set<string>();
      connection.tools = [];
      for (const tool of listed.tools) {
        const exposed = exposedToolName(server.id, tool.name);
        if (seen.has(exposed)) {
          continue;
        }
        seen.add(exposed);
        const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
        connection.tools.push({
          exposed,
          remote: tool.name,
          spec: {
            name: exposed,
            description: `[${server.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
            parameters: {
              type: 'object',
              properties: schema.properties ?? {},
              ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
            },
          },
        });
      }
      connection.client = client;
      connection.state = 'ready';
      client.onclose = () => {
        if (this.connections.get(server.id) === connection && connection.state === 'ready') {
          connection.state = 'error';
          connection.error = 'The connection was closed.';
          connection.client = null;
        }
      };
      this.deps.log(`mcp client: "${server.id}" ready, ${connection.tools.length} tool(s)`);
    } catch (err) {
      void client?.close().catch(() => undefined);
      if (this.connections.get(server.id) === connection) {
        connection.state = 'error';
        connection.error = errorText(err);
        this.deps.log(`mcp client: "${server.id}" failed: ${connection.error}`, 'warn');
      }
    }
  }

  private async drop(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (connection === undefined) {
      return;
    }
    this.connections.delete(id);
    const client = connection.client;
    connection.client = null;
    if (client !== null) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }
}
