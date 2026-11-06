import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TicketsRemotePort } from '../contracts/remote-protocol';
import { NotesService } from '../services/notes-service';
import { DeviceRegistry, FailureLimiter, PairingCodes } from './auth';
import { RemoteGateway } from './gateway';
import { route, type RemoteRequest, type RouterDeps } from './router';

/**
 * req-100: the Notes API over the router and a real socket: the routes, the
 * read-only refusal, access rules, status codes, the SSE event, the body cap.
 */

const HOST = '127.0.0.1:47811';

let root: string;
let deps: RouterDeps;
let fullToken: string;
let readOnlyToken: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'drey-notes-routes-'));
  const devices = new DeviceRegistry([], async () => undefined);
  fullToken = (await devices.add('Phone', false, new Date())).token;
  readOnlyToken = (await devices.add('Tablet', true, new Date())).token;
  deps = {
    port: {} as unknown as TicketsRemotePort,
    devices,
    pairing: new PairingCodes(),
    limiter: new FailureLimiter(),
    allowedHosts: () => new Set([HOST]),
    now: () => new Date('2026-11-06T10:00:00Z'),
    log: () => undefined,
    onPaired: () => undefined,
    notes: new NotesService({ root: async () => root, log: () => undefined }),
  };
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const get = (url: string, token = fullToken): RemoteRequest => {
  const parsed = new URL(url, 'http://x.invalid');
  return {
    method: 'GET',
    path: parsed.pathname,
    query: parsed.searchParams,
    host: HOST,
    origin: undefined,
    authorization: `Bearer ${token}`,
    body: undefined,
    remote: '127.0.0.1',
  };
};

const post = (url: string, body: unknown, token = fullToken): RemoteRequest => ({ ...get(url, token), method: 'POST', query: undefined, body });

describe('Notes API routes', () => {
  beforeEach(async () => {
    await fsp.writeFile(path.join(root, 'a.md'), '# Boat\nnew sail\n', 'utf8');
  });

  it('serves list, recent, search and read', async () => {
    expect(await route(get('/api/notes'), deps)).toMatchObject({ status: 200, body: { ok: true, notes: [{ path: 'a.md' }] } });
    expect(await route(get('/api/notes/recent?limit=1'), deps)).toMatchObject({ status: 200, body: { ok: true, notes: [{ path: 'a.md' }] } });
    expect(await route(get('/api/notes/search?q=sail'), deps)).toMatchObject({ status: 200, body: { ok: true, hits: [{ path: 'a.md' }] } });
    expect(await route(get('/api/notes/note?path=a.md'), deps)).toMatchObject({ status: 200, body: { ok: true, text: '# Boat\nnew sail\n' } });
  });

  it('a read-only device reads everything', async () => {
    expect(await route(get('/api/notes/note?path=a.md', readOnlyToken), deps)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await route(get('/api/notes/search?q=sail', readOnlyToken), deps)).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('a read-only device never reaches the write path: 403 with the code, nothing written', async () => {
    const refusal = { status: 403, body: { ok: false, code: 'read_only', error: 'this device is paired read-only' } };
    expect(await route(post('/api/notes/note', { path: 'a.md', text: 'x', baseMtime: 1 }, readOnlyToken), deps)).toEqual(refusal);
    expect(await route(post('/api/notes', { path: 'b.md', text: 'x' }, readOnlyToken), deps)).toEqual(refusal);
    expect(await fsp.readdir(root)).toEqual(['a.md']);
    expect(await fsp.readFile(path.join(root, 'a.md'), 'utf8')).toBe('# Boat\nnew sail\n');
  });

  it('saves with the read mtime; a stale one is a 200 refusal that carries the disk text', async () => {
    const read = await route(get('/api/notes/note?path=a.md'), deps);
    const mtime = (read.body as { mtime: number }).mtime;
    expect(await route(post('/api/notes/note', { path: 'a.md', text: 'x', baseMtime: mtime - 9000 }), deps)).toMatchObject({
      status: 200,
      body: { ok: false, code: 'conflict', disk: { text: '# Boat\nnew sail\n', mtime } },
    });
    expect(await route(post('/api/notes/note', { path: 'a.md', text: 'x', baseMtime: mtime }), deps)).toMatchObject({ status: 200, body: { ok: true, text: 'x' } });
  });

  it('creates; an existing name is a 200 refusal', async () => {
    expect(await route(post('/api/notes', { path: 'b.md', text: 'x' }), deps)).toMatchObject({ status: 200, body: { ok: true, path: 'b.md' } });
    expect(await route(post('/api/notes', { path: 'b.md' }), deps)).toMatchObject({ status: 200, body: { ok: false, code: 'exists' } });
  });

  it('maps refusals to status plus code', async () => {
    expect(await route(get('/api/notes/note?path=nope.md'), deps)).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(await route(get('/api/notes/note?path=..%2Fa.md'), deps)).toMatchObject({ status: 400, body: { code: 'bad_path' } });
    expect(await route(get('/api/notes/note?path=.drafts%2Fa.md'), deps)).toMatchObject({ status: 400, body: { code: 'bad_path' } });
    expect(await route(get('/api/notes/note'), deps)).toMatchObject({ status: 400, body: { code: 'bad_path' } });
    expect(await route(get('/api/notes/search'), deps)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await route(get('/api/notes/other'), deps)).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(await route(post('/api/notes/note', { path: 'a.md', text: 'x' }), deps)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await route(post('/api/notes', { text: 'x' }), deps)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await route({ ...get('/api/notes'), method: 'DELETE' }, deps)).toMatchObject({ status: 405 });
  });

  it('answers internal when the disk fails, and logs it', async () => {
    const logged: string[] = [];
    const failing = { ...deps, log: (m: string) => logged.push(m), notes: { ...deps.notes!, list: () => Promise.reject(new Error('disk gone')) } };
    expect(await route(get('/api/notes'), failing)).toEqual({ status: 500, body: { ok: false, code: 'internal', error: 'the request failed on the desk' } });
    expect(logged[0]).toContain('disk gone');
  });

  it('asks for a paired device and a same-site write', async () => {
    expect(await route({ ...get('/api/notes'), authorization: undefined }, deps)).toMatchObject({ status: 401 });
    expect(await route({ ...post('/api/notes', { path: 'b.md' }), origin: 'https://evil.example' }, deps)).toMatchObject({ status: 403 });
    expect(await fsp.readdir(root)).toEqual(['a.md']);
  });

  it('is a plain 404 on a host without the service', async () => {
    const { notes: _notes, ...without } = deps;
    expect(await route(get('/api/notes'), without)).toMatchObject({ status: 404 });
    expect(await route(post('/api/notes', { path: 'b.md' }), without)).toMatchObject({ status: 404 });
  });
});

describe('Notes API over the gateway', () => {
  let gateway: RemoteGateway;
  let base: string;

  beforeEach(async () => {
    let allowed = new Set<string>();
    gateway = new RemoteGateway({
      clientDir: '/nonexistent-client-dir',
      log: () => undefined,
      router: {
        ...deps,
        port: { onChanged: () => () => undefined } as unknown as TicketsRemotePort,
        allowedHosts: () => allowed,
      },
    });
    await gateway.start('127.0.0.1', 0);
    const host = gateway.listening!;
    allowed = new Set([host]);
    base = `http://${host}`;
  });

  afterEach(async () => {
    await gateway.stop();
  });

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${fullToken}`, 'content-type': 'application/json' });

  it('hands the query through, and takes a save larger than the general body cap', async () => {
    await fsp.writeFile(path.join(root, 'a.md'), 'old', 'utf8');
    const read = (await (await fetch(`${base}/api/notes/note?path=a.md`, { headers: auth() })).json()) as { mtime: number };
    const text = 'x'.repeat(200 * 1024);
    const saved = await fetch(`${base}/api/notes/note`, { method: 'POST', headers: auth(), body: JSON.stringify({ path: 'a.md', text, baseMtime: read.mtime }) });
    expect(saved.status).toBe(200);
    expect(((await fsp.stat(path.join(root, 'a.md'))).size)).toBe(text.length);
  });

  it('refuses a save over the note cap with the code', async () => {
    const res = await fetch(`${base}/api/notes/note`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ path: 'a.md', text: 'x'.repeat(5 * 1024 * 1024), baseMtime: 1 }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('streams a notes event with the paths and without the vault folder', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events`, { headers: auth(), signal: controller.signal });
    const reader = stream.body!.getReader();
    await reader.read(); // the retry line: the subscription stands
    await fetch(`${base}/api/notes`, { method: 'POST', headers: auth(), body: JSON.stringify({ path: 'new.md', text: 'x' }) });
    let seen = '';
    while (!seen.includes('\n\n') || !seen.includes('event: notes')) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      seen += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(seen).toContain('event: notes\ndata: {"changed":["new.md"]}');
    expect(seen).not.toContain(path.basename(root));
  });
});
