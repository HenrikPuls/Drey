/**
 * The remote's HTTP server (req-66, ADR-0084): `node:http` on the bound
 * address, the JSON API through `route`, live changes as Server-Sent
 * Events, and the phone client's static files under a strict CSP. It
 * moves bytes only — every rule lives in `router.ts`.
 */
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { RemoteChange } from '../../shared/remote-protocol';
import { FALLBACK_FILES } from './fallback-client';
import { authorize, hostRefusal, route, type RemoteRequest, type RouterDeps } from './router';

const MAX_BODY = 64 * 1024;
const KEEPALIVE_MS = 25_000;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface GatewayOptions {
  readonly router: RouterDeps;
  /** The built phone client (R3); missing = the built-in pairing page. */
  readonly clientDir: string;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export class RemoteGateway {
  private server: http.Server | null = null;
  private readonly streams = new Set<http.ServerResponse>();
  private address: string | null = null;

  constructor(private readonly options: GatewayOptions) {}

  /** `host:port` while listening, else null. */
  get listening(): string | null {
    return this.address;
  }

  async start(host: string, port: number): Promise<void> {
    await this.stop();
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.options.log(`remote: ${error instanceof Error ? error.message : String(error)}`, 'error');
        if (!res.headersSent) {
          send(res, 500, { ok: false, error: 'internal error' });
        } else {
          res.end();
        }
      });
    });
    server.headersTimeout = 20_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const bound = server.address();
    this.address = `${host}:${typeof bound === 'object' && bound !== null ? bound.port : port}`;
    this.options.log(`remote: listening on ${this.address}`);
  }

  async stop(): Promise<void> {
    for (const res of this.streams) {
      res.end();
    }
    this.streams.clear();
    const server = this.server;
    this.server = null;
    this.address = null;
    if (server !== null) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://remote.invalid');
    const method = req.method ?? 'GET';
    const base = {
      method,
      path: url.pathname,
      host: req.headers.host,
      origin: req.headers.origin,
      authorization: req.headers.authorization,
      remote: req.socket.remoteAddress ?? 'unknown',
    };

    const refused = hostRefusal(base, this.options.router);
    if (refused !== null) {
      send(res, refused.status, refused.body);
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      await this.serveStatic(method, url.pathname, res);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/events') {
      this.openEvents({ ...base, body: undefined }, res);
      return;
    }

    let body: unknown;
    if (method === 'POST') {
      const raw = await readBody(req);
      if (raw === null) {
        send(res, 413, { ok: false, error: 'the request is too large' });
        return;
      }
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          send(res, 400, { ok: false, error: 'the body is not JSON' });
          return;
        }
      }
    }
    const response = await route({ ...base, body }, this.options.router);
    send(res, response.status, response.body);
  }

  /** Server-Sent Events: `board` / `fleet` on every change, a comment line as keep-alive. */
  private openEvents(req: RemoteRequest, res: http.ServerResponse): void {
    const auth = authorize(req, this.options.router);
    if ('response' in auth) {
      send(res, auth.response.status, auth.response.body);
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.streams.add(res);
    const off = this.options.router.port.onChanged((what: RemoteChange) => {
      res.write(`event: ${what}\ndata: {}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);
    const close = (): void => {
      clearInterval(keepAlive);
      off();
      this.streams.delete(res);
    };
    res.on('close', close);
  }

  private async serveStatic(method: string, pathname: string, res: http.ServerResponse): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { ok: false, error: 'only GET is served here' });
      return;
    }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    const type = CONTENT_TYPES[path.extname(name).toLowerCase()];
    if (type === undefined || name.includes('..') || name.includes('\\') || name.includes('\0')) {
      send(res, 404, { ok: false, error: 'not found' });
      return;
    }
    let content: Buffer | null = null;
    const root = path.resolve(this.options.clientDir);
    const file = path.resolve(root, name);
    if (file.startsWith(root + path.sep)) {
      content = await fsp.readFile(file).catch(() => null);
    }
    if (content === null) {
      const fallback = FALLBACK_FILES[name];
      if (fallback === undefined) {
        send(res, 404, { ok: false, error: 'not found' });
        return;
      }
      content = Buffer.from(fallback, 'utf8');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': content.length,
      'Cache-Control': name === 'index.html' ? 'no-cache' : 'max-age=300',
    });
    res.end(method === 'HEAD' ? undefined : content);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** The body as text, or null when it exceeds the cap. */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
