import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { TicketsGit } from '../core/tickets-git';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools } from '../fleet/protocol';
import { RUNNER_SCRIPT_PATH } from '../fleet/runner-path';
import { EngineBoardService } from '../services/board-service';
import { FleetClient } from '../services/fleet-client';
import { ChangeHub, DreyTicketsPort } from './drey-port';
import { FileConfigStore } from './file-config';
import { RemoteService } from './service';
import { FsEngineHost } from './standalone-host';

/**
 * The standalone tickets engine (ADR-0088, E2b): the whole board service,
 * the fleet client and the remote gateway composed over one tickets vault
 * on disk — no Drey. The Drey plugin either starts this process
 * (engine-main.ts, ELECTRON_RUN_AS_NODE) or adopts a live one through the
 * lockfile; both then talk to it over the invoke channel, and phones talk
 * to the same engine through the gateway's pairing as before.
 */

export interface EngineOptions {
  /** Absolute path of the tickets vault (the folder containing `tickets/`). */
  readonly vaultPath: string;
  /** The engine home: config, lockfile, run history, the legacy worktree base. */
  readonly home: string;
  /** The built phone client's folder (served by the gateway). */
  readonly clientDir: string;
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** The invoke listener's port; 0 picks a free one. */
  readonly invokePort?: number;
}

export interface Engine {
  /** The loopbase for the invoke channel, e.g. http://127.0.0.1:41231. */
  readonly invokeUrl: string;
  /** The local bearer token every invoke call carries. */
  readonly token: string;
  config: FileConfigStore;
  invoke(method: string, payload?: unknown): Promise<unknown>;
  onEvent(listener: (what: 'board' | 'fleet' | 'remote') => void): () => void;
  close(): Promise<void>;
}

/** Method names the invoke channel exposes. Everything else stays internal. */
const BOARD_METHODS = [
  'snapshot', 'refresh', 'readTicket', 'refineTicket', 'setPriority', 'setTrack', 'saveAttachment',
  'createTicket', 'transition', 'archive', 'unarchive', 'acceptTicket', 'sendBack', 'launchVersion',
  'changesOf', 'worktreeChangesOf', 'removeWorktreeForTicket', 'worktreeCleanup', 'worktreeBootSweep',
  'worktreesStatus', 'setClaim', 'startRun', 'setColumnConfig', 'listPrompts', 'savePrompt',
  'restoreShippedPrompts', 'listRepos', 'saveRepos', 'pickFolder', 'scanRepos', 'listProjects',
  'switchProject', 'openTicketsFolder', 'folderStatus', 'numberFolders', 'reorderPhases', 'editPhase',
  'initialize', 'onVaultEvent',
] as const;

const FLEET_METHODS = ['runs', 'start', 'chainStatus', 'stop', 'send', 'answerPermission', 'answerQuestion', 'stream', 'setMaster', 'setColumn', 'stopColumn', 'abortAll', 'startPolling', 'attach', 'control', 'log', 'status'] as const;

const REMOTE_METHODS = ['status', 'configure', 'pair', 'revoke', 'init'] as const;

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  const log = opts.log ?? (() => undefined);
  const config = new FileConfigStore(path.join(opts.home, 'config.json'));
  const storedToken = await config.get<string>('engine.token');
  const token = storedToken ?? randomBytes(24).toString('hex');
  if (storedToken === undefined) {
    await config.set('engine.token', token);
  }

  const hub = new ChangeHub();
  const host = new FsEngineHost(opts.vaultPath, config, hub, log, opts.home);
  const git = new TicketsGit(() => 'git');
  const fleetRoot = path.join(opts.home, 'fleet');
  const fleet = new FleetClient({
    root: fleetRoot,
    runnerScript: RUNNER_SCRIPT_PATH,
    log,
    onFleetChanged: () => hub.emit('fleet'),
  });
  const board = new EngineBoardService(
    host,
    git,
    'opencode',
    'accept-edits',
    '',
    fleet,
    fleetRoot,
    normalizeFleetCaps({}),
    normalizeFleetPools({}),
    normalizeFleetHandover({}),
    `engine@${hostname().toLowerCase()}`,
  );
  board.onChanged(() => hub.emit('board'));

  const remoteService: RemoteService = new RemoteService({
    config,
    port: new DreyTicketsPort(board, fleet, hub, { allowBypass: () => remoteService.allowBypass() }),
    clientDir: opts.clientDir,
    log,
    onChanged: () => hub.emit('remote'),
  });
  await remoteService.init();

  // The invoke table: the service instances behind an explicit allowlist.
  const table = new Map<string, (payload: unknown) => Promise<unknown>>();
  const register = (obj: object, names: readonly string[]): void => {
    for (const name of names) {
      const fn = (obj as Record<string, (input?: unknown) => unknown>)[name];
      if (typeof fn === 'function') {
        table.set(name, (payload) => Promise.resolve(fn.call(obj, payload)));
      }
    }
  };
  register(board, BOARD_METHODS);
  register(fleet, FLEET_METHODS);
  register(remoteService, REMOTE_METHODS);
  // The plugin's config sync: Drey's settings keys the engine reads.
  table.set('configSet', (payload) => {
    const message = payload as { key?: unknown; value?: unknown };
    if (typeof message?.key !== 'string') {
      throw new Error('configSet expects { key, value }');
    }
    return host.configSet(message.key, message.value);
  });
  table.set('configGet', (payload) => {
    const message = payload as { key?: unknown };
    if (typeof message?.key !== 'string') {
      throw new Error('configGet expects { key }');
    }
    return host.configGet(message.key);
  });

  // The invoke listener: loopback + local bearer only, independent of the
  // gateway's pairing state — the plugin's channel must survive remote off.
  const server = http.createServer((req, res) => {
    void handleInvoke(req, res).catch((error: unknown) => {
      log(`invoke: ${error instanceof Error ? error.message : String(error)}`, 'error');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    });
  });
  async function handleInvoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (auth.length !== expected.length || !timingSafeEqualStr(auth, expected)) {
      send(401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://engine.invalid');
    if (req.method === 'GET' && url.pathname === '/api/events') {
      // The plugin's live-update channel: same hub the gateway's SSE uses,
      // bearer-only. Events: board | fleet | remote.
      const auth = req.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (auth.length !== expected.length || !timingSafeEqualStr(auth, expected)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`: connected\n\n`);
      const unsubscribe = hub.subscribe((what) => {
        res.write(`data: ${JSON.stringify({ change: what })}\n\n`);
      });
      const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 25_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(200, { ok: true, vault: opts.vaultPath });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/invoke') {
      send(404, { ok: false, error: 'not found' });
      return;
    }
    const raw = await readBody(req, 1_000_000);
    let message: { method?: unknown; payload?: unknown };
    try {
      message = JSON.parse(raw) as { method?: unknown; payload?: unknown };
    } catch {
      send(400, { ok: false, error: 'the body is not JSON' });
      return;
    }
    if (typeof message.method !== 'string' || !table.has(message.method)) {
      send(404, { ok: false, error: `no such method: ${String(message.method)}` });
      return;
    }
    try {
      const value = await table.get(message.method)!(message.payload);
      send(200, { ok: true, value: value === undefined ? null : value });
    } catch (error) {
      send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  server.listen(opts.invokePort ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the invoke listener did not bind');
  }
  const invokeUrl = `http://127.0.0.1:${address.port}`;

  let closed = false;
  return {
    invokeUrl,
    token,
    config,
    invoke: (method, payload) => {
      const fn = table.get(method);
      if (fn === undefined) {
        return Promise.reject(new Error(`no such method: ${method}`));
      }
      return fn(payload);
    },
    onEvent: (listener) => hub.subscribe((what) => listener(what as 'board' | 'fleet' | 'remote')),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await remoteService.stop();
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function readBody(req: http.IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error('the body is too large'));
        req.destroy();
        return;
      }
      text += chunk;
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

/** Write (or refresh) the lockfile the lifecycle adopts the engine through. */
export async function writeEngineLock(home: string, lock: { pid: number; invokePort: number; token: string; vaultPath: string }): Promise<void> {
  const file = path.join(home, 'engine.lock');
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(lock, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export async function removeEngineLock(home: string): Promise<void> {
  await fsp.rm(path.join(home, 'engine.lock'), { force: true });
}
