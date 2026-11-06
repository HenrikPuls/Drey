/**
 * The remote's HTTP server (req-66, ADR-0086): `node:http` on the bound
 * address, the JSON API through `route`, live changes as Server-Sent
 * Events, and the phone client's static files under a strict CSP. It
 * moves bytes only — every rule lives in `router.ts`.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { ChatChangePayload, RemoteChange } from '../contracts/remote-protocol';
import { FALLBACK_FILES } from './fallback-client';
import { isNotesPath, notesFailure } from './notes-routes';
import { authorize, hostRefusal, route, type RemoteRequest, type RouterDeps } from './router';

const MAX_BODY = 64 * 1024;
/** `/api/attachments` alone may grow: 6 MB of image plus its base64 overhead. */
const ATTACHMENT_BODY = 12 * 1024 * 1024;
/** A note save carries the whole file; `/api/notes` may grow to this. */
const NOTE_BODY = 4 * 1024 * 1024;
const KEEPALIVE_MS = 25_000;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    // style-src needs 'unsafe-inline': Angular injects the components'
    // styles at runtime as <style> blocks (the global stylesheet is the
    // only external style). Scripts stay strict 'self'.
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; " +
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** The attachment names the proof card's gallery asks for (`verify-…`, `img-…`). */
const ATTACHMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpg|jpeg|webp|mp4|webm)$/;

/** The video names the proof card's player asks for (E11-1). */
const VIDEO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(mp4|webm)$/;

/**
 * One `Range: bytes=a-b` header against a file of `size` bytes: the
 * inclusive byte window, `'unsatisfiable'` for a window outside the
 * file, null for a header that is absent or not a single byte range
 * (the whole file is then served). Safari streams video through
 * ranges, so this route must answer them.
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === '' && match[2] === '')) {
    return null;
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    // A suffix range: the last n bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) {
      return 'unsatisfiable';
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start >= size || start > end ? 'unsatisfiable' : { start, end };
}

export interface GatewayOptions {
  readonly router: RouterDeps;
  /** The built phone client (R3); missing = the built-in pairing page. */
  readonly clientDir: string;
  /** The vault's attachment bytes (E5c); null = no such file. */
  readonly attachments?: (name: string) => Promise<Uint8Array | null>;
  /** The vault's walkthrough videos (E11-1): the file and its size; null = no such video. */
  readonly videos?: (name: string) => Promise<{ file: string; bytes: number } | null>;
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
    if (method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
      await this.serveAttachment(base, decodeURIComponent(url.pathname.slice('/api/attachments/'.length)), res);
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/api/videos/')) {
      await this.serveVideo({ ...base, range: req.headers.range }, decodeURIComponent(url.pathname.slice('/api/videos/'.length)), res);
      return;
    }

    let body: unknown;
    if (method === 'POST' || method === 'PATCH') {
      const notes = isNotesPath(url.pathname);
      const cap = url.pathname === '/api/attachments' ? ATTACHMENT_BODY : notes ? NOTE_BODY : MAX_BODY;
      const raw = await readBody(req, cap);
      if (raw === null) {
        const refused = notes ? notesFailure('too_large', 'this note is too large to save from here') : { status: 413, body: { ok: false, error: 'the request is too large' } };
        send(res, refused.status, refused.body);
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
    const response = await route({ ...base, query: url.searchParams, body }, this.options.router);
    send(res, response.status, response.body);
  }

  /**
   * Server-Sent Events: `board` / `fleet` / `remote` / `chat` on every
   * change — chat changes carry their `{ file, event }` stream payload,
   * the others stay an empty JSON object; `notes` (req-100) carries the
   * changed paths. A comment line as keep-alive.
   */
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
    const off = this.options.router.port.onChanged((what: RemoteChange, payload?: ChatChangePayload) => {
      res.write(`event: ${what}\ndata: ${JSON.stringify(payload ?? {})}\n\n`);
    });
    const offNotes = this.options.router.notes?.onChanged(({ changed }) => {
      res.write(`event: notes\ndata: ${JSON.stringify({ changed })}\n\n`);
    });
    const { router } = this.options;
    // An open stream is a connected device: the keep-alive refreshes its
    // "last connected" (D-2) — the registry persists at most once a minute.
    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
      void router.devices.touch(auth.device.id, router.now()).catch(() => undefined);
    }, KEEPALIVE_MS);
    const close = (): void => {
      clearInterval(keepAlive);
      off();
      offNotes?.();
      this.streams.delete(res);
    };
    res.on('close', close);
  }

  private async serveAttachment(
    req: Pick<RemoteRequest, 'method' | 'host' | 'origin' | 'authorization' | 'remote'>,
    name: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const auth = authorize({ ...req, path: '/api/attachments', body: undefined }, this.options.router);
    if ('response' in auth) {
      send(res, auth.response.status, auth.response.body);
      return;
    }
    const read = this.options.attachments;
    if (read === undefined || !ATTACHMENT_NAME.test(name) || name.includes('/') || name.includes('\\')) {
      send(res, 404, { ok: false, error: 'no such attachment' });
      return;
    }
    try {
      const bytes = await read(name);
      if (bytes === null) {
        send(res, 404, { ok: false, error: 'no such attachment' });
        return;
      }
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'cache-control': 'private, max-age=60',
        'content-length': bytes.byteLength,
      });
      res.end(Buffer.from(bytes));
    } catch (error) {
      this.options.log(`remote: attachment ${name} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      send(res, 500, { ok: false, error: 'reading the attachment failed' });
    }
  }

  private async serveVideo(
    req: Pick<RemoteRequest, 'method' | 'host' | 'origin' | 'authorization' | 'remote'> & { range?: string },
    name: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const auth = authorize({ ...req, path: '/api/videos', body: undefined }, this.options.router);
    if ('response' in auth) {
      send(res, auth.response.status, auth.response.body);
      return;
    }
    const find = this.options.videos;
    const found = find === undefined || !VIDEO_NAME.test(name) ? null : await find(name).catch(() => null);
    if (found === null) {
      send(res, 404, { ok: false, error: 'no such video' });
      return;
    }
    const range = parseByteRange(req.range, found.bytes);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'content-range': `bytes */${found.bytes}` });
      res.end();
      return;
    }
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const window = range ?? { start: 0, end: found.bytes - 1 };
    res.writeHead(range === null ? 200 : 206, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=60',
      'content-length': found.bytes === 0 ? 0 : window.end - window.start + 1,
      ...(range === null ? {} : { 'content-range': `bytes ${window.start}-${window.end}/${found.bytes}` }),
    });
    if (found.bytes === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(found.file, { start: window.start, end: window.end });
    stream.on('error', (error) => {
      this.options.log(`remote: video ${name} failed: ${error.message}`, 'error');
      res.destroy();
    });
    stream.pipe(res);
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
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
