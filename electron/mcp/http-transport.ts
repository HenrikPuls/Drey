/**
 * The localhost HTTP face of the MCP server: a single `POST /mcp`
 * endpoint over the SDK's Streamable HTTP transport, **stateless** and
 * answering in plain JSON (a tools-only server never pushes to the
 * client, so there is no session and no SSE stream).
 *
 * Bound to 127.0.0.1 only. It is opt-in on top of `mcp.enabled`
 * (`McpConfig.httpEnabled`) precisely because it is a listening socket --
 * see `docs/09_architecture_decisions/0021-mcp-vault-server.md`.
 *
 * Binding to loopback does not keep a web page out: a browser on this
 * machine can reach it too. So every request must carry a local `Host`,
 * and an `Origin` -- which only a browser sends -- must be local as well.
 */
import * as http from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether a `Host` header names this machine on the endpoint's port. */
export function isLocalHost(host: string | undefined, port: number | null): boolean {
  if (host === undefined) {
    return false;
  }
  const cut = host.lastIndexOf(':');
  const name = cut > 0 && !host.endsWith(']') ? host.slice(0, cut) : host;
  const hostPort = cut > 0 && !host.endsWith(']') ? host.slice(cut + 1) : '';
  return LOCAL_HOSTNAMES.has(name.toLowerCase()) && (hostPort === '' || hostPort === String(port));
}

/** Whether an `Origin` header is absent (not a browser) or a local page. */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).host.replace(/:\d+$/, '').toLowerCase());
  } catch {
    return false;
  }
}

export class McpHttpTransport {
  private server: http.Server | null = null;
  private port: number | null = null;

  /** `createServer` builds one MCP server per request (stateless mode). */
  constructor(private readonly createServer: () => Server) {}

  /** True while the endpoint is listening. */
  get running(): boolean {
    return this.server !== null;
  }

  get activePort(): number | null {
    return this.port;
  }

  /** Starts (or restarts on a new port) the endpoint. Rejects if the port is taken. */
  async start(port: number): Promise<void> {
    if (this.server && this.port === port) {
      return;
    }
    await this.stop();
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.onRequest(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.server = server;
        this.port = port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isLocalHost(req.headers.host, this.port) || !isLocalOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden.');
      return;
    }
    if ((req.url ?? '/').split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found. POST JSON-RPC to /mcp.');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no GET stream to open, no session to DELETE.
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' }).end('Method not allowed.');
      return;
    }

    // A stateless transport serves exactly one request, so each gets its
    // own transport and server; both go when the response is done.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = this.createServer();
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          }),
        );
      }
    }
  }
}
