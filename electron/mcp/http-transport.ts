/**
 * The localhost HTTP face of the MCP server. A single `POST /mcp`
 * endpoint that takes one JSON-RPC message (or a batch array) and returns
 * the response(s) as JSON -- the "Streamable HTTP" shape, minus the
 * optional SSE stream (a tools-only server never pushes to the client).
 *
 * Bound to 127.0.0.1 only. It is opt-in on top of `mcp.enabled`
 * (`McpConfig.httpEnabled`) precisely because it is a listening socket --
 * see `docs/09_architecture_decisions/0021-mcp-vault-server.md`.
 */
import * as http from 'node:http';
import type { JsonRpcResponse, McpServer } from './server';

export class McpHttpTransport {
  private server: http.Server | null = null;
  private port: number | null = null;

  constructor(private readonly mcp: McpServer) {}

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
    // Permissive CORS: the endpoint is already localhost-only and the
    // tools carry their own confirmation gate.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '/').split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found. POST JSON-RPC to /mcp.');
      return;
    }

    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(rpcError(null, -32700, 'Could not read request body.')));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(rpcError(null, -32700, 'Invalid JSON.')));
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await this.mcp.handle(message);
      if (response) {
        responses.push(response);
      }
    }

    // A batch of only notifications gets a bare 202.
    if (responses.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function rpcError(id: null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
