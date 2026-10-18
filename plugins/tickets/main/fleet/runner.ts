/**
 * The fleet runner's entry (ADR-0075, milestone 84): a plain Node
 * process — spawned detached by the tickets plugin with
 * ELECTRON_RUN_AS_NODE, so it survives Drey closing and restarting —
 * that owns what Drey cannot: the worker process table, the held stdio
 * pipes behind the per-run stream files, and the tree-kills.
 *
 * Surface: a loopback HTTP endpoint with a bearer token, rooted under
 * `<userData>/fleet/` (the descriptor with port + token lives in
 * `<root>/runner.json`) — Drey talks to it, and so can a terminal
 * (curl), which the owner asked for explicitly. Single instance: a
 * second runner finding a healthy peer exits quietly; a stale
 * descriptor (peer dead) is taken over. With no live runs and no
 * requests for the idle span the runner shuts itself down.
 *
 * Usage: node runner.js --root <abs-path-to-fleet-root> [--idle-ms <n>]
 */
import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { claudeCodeAdapter, opencodeAdapter } from './providers';
import { freePort, nodeSpawnFn } from './procs';
import { Orchestrator } from './orchestrator';
import { RunSupervisor } from './runs';
import {
  isWorkerProvider,
  type ChainConfig,
  type ChainMaster,
  type ColumnMode,
  type RunRequest,
  type RunnerDescriptor,
} from './protocol';

const VERSION = 1;
const MAX_BODY = 1024 * 1024;

interface Args {
  readonly root: string;
  readonly idleMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  let root = '';
  let idleMs = 15 * 60_000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) {
      root = argv[i + 1]!;
      i++;
    } else if (argv[i] === '--idle-ms' && argv[i + 1] !== undefined) {
      idleMs = Number(argv[i + 1]);
      i++;
    }
  }
  if (root === '') {
    console.error('fleet runner: --root is required');
    process.exit(2);
  }
  return { root, idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 15 * 60_000 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await fsp.mkdir(args.root, { recursive: true });
  await fsp.mkdir(path.join(args.root, 'runs'), { recursive: true });
  const descriptorPath = path.join(args.root, 'runner.json');

  // Single instance: a healthy peer keeps this process out; a stale
  // descriptor (crashed runner) is taken over.
  const existing = await readDescriptor(descriptorPath);
  if (existing !== null && (await peerAlive(existing))) {
    process.exit(0);
  }

  // The daemon's log reaches three places: the console (lost for a
  // detached process), a ring buffer the /log route serves, and
  // runner.log — the owner's window into every dispatch decision
  // (T-0007 review finding 2: the daemon's doings were invisible).
  const logPath = path.join(args.root, 'runner.log');
  // The build stamp: the entry file's mtime at boot. When the file on
  // disk moves on (a new build), the client retires this daemon and
  // respawns — stale code never serves a second session.
  const buildStamp = (await fsp.stat(__filename)).mtime.toISOString();
  const ring: string[] = [];
  let logChain: Promise<void> = Promise.resolve();
  const log = (message: string): void => {
    const line = `[fleet ${new Date().toISOString()}] ${message}`;
    console.log(line);
    ring.push(line);
    if (ring.length > 1000) {
      ring.splice(0, ring.length - 1000);
    }
    logChain = logChain
      .then(async () => {
        await fsp.appendFile(logPath, `${line}\n`, 'utf8');
        const stat = await fsp.stat(logPath).catch(() => null);
        if (stat !== null && stat.size > 512 * 1024) {
          const text = await fsp.readFile(logPath, 'utf8').catch(() => '');
          await fsp.writeFile(logPath, text.slice(-256 * 1024), 'utf8');
        }
      })
      .catch(() => undefined);
  };
  log(`daemon pid ${process.pid} starting in ${args.root} (v${VERSION})`);

  // Runs carry their provider, so the entry keeps one supervisor per
  // adapter and routes by the request's provider. The chain
  // orchestrator (M85) plans across both; its run-settled hook comes
  // back through the supervisors' dep.
  const adapters = {
    opencode: opencodeAdapter(nodeSpawnFn()),
    'claude-code': claudeCodeAdapter(nodeSpawnFn()),
  };
  let orchestrator: Orchestrator | null = null;
  const supervisors = new Map<string, RunSupervisor>(
    Object.values(adapters).map((adapter) => [
      adapter.id,
      new RunSupervisor({
        root: args.root,
        adapter,
        git: 'git',
        log,
        onRunSettled: (info) => void orchestrator?.onRunSettled(info),
        secondOpinion: (request) => orchestrator?.secondOpinion(request) ?? Promise.resolve(null),
      }),
    ]),
  );
  orchestrator = new Orchestrator({
    root: args.root,
    log,
    supervisorOf: (provider) => supervisors.get(provider) ?? supervisors.get('opencode')!,
  });
  for (const one of supervisors.values()) {
    await one.adopt();
  }
  await orchestrator.load();

  const port = await freePort();
  const token = crypto.randomBytes(24).toString('hex');
  const descriptor: RunnerDescriptor = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: VERSION,
    build: buildStamp,
  };
  const tokenBuffer = Buffer.from(token, 'utf8');

  let lastRequest = Date.now();
  const server = http.createServer((req, res) => {
    lastRequest = Date.now();
    const given = req.headers.authorization ?? '';
    const okToken =
      given.startsWith('Bearer ') &&
      given.length === 'Bearer '.length + tokenBuffer.length &&
      crypto.timingSafeEqual(Buffer.from(given.slice('Bearer '.length), 'utf8'), tokenBuffer);
    if (!okToken) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    void route(req, res);
  });

  const url = (req: http.IncomingMessage): { pathname: string; parts: readonly string[] } => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    return { pathname: parsed.pathname, parts: parsed.pathname.split('/').filter((p) => p !== '') };
  };

  const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        throw new Error('body too large');
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : (JSON.parse(text) as unknown);
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const { pathname, parts } = url(req);
    try {
      if (req.method === 'GET' && pathname === '/health') {
        respond(200, { ok: true, version: VERSION, build: buildStamp, live: supervisorsOfLive() });
        return;
      }
      if (req.method === 'POST' && pathname === '/shutdown') {
        respond(200, { ok: true });
        log('shutdown requested — stopping live runs first, then exiting');
        // Graceful: a worker left alive while its record goes detached is
        // an unsupervised agent on a parked ticket (T-0007 review). The
        // stop path is the owner's own button; the wait is bounded so a
        // hung adapter cannot hold the daemon hostage.
        const stops = [...supervisors.values()].flatMap((sup) =>
          sup
            .list()
            .filter((info) => info.state === 'starting' || info.state === 'running')
            .map((info) => sup.stop(info.id, 'the runner is retired for a newer build')),
        );
        if (stops.length > 0) {
          log(`stopping ${stops.length} live run${stops.length === 1 ? '' : 's'} before exit`);
        }
        await Promise.race([
          Promise.allSettled(stops),
          new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
        setTimeout(() => process.exit(0), 100);
        return;
      }
      if (req.method === 'GET' && pathname === '/log') {
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
        const tail = Number(params.get('tail') ?? '');
        const count = Number.isFinite(tail) && tail > 0 ? Math.min(Math.trunc(tail), 2000) : 300;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(ring.slice(-count).join('\n'));
        return;
      }
      if (req.method === 'GET' && pathname === '/chain') {
        respond(200, orchestrator.status());
        return;
      }
      if (req.method === 'POST' && pathname === '/chain/config') {
        const body = (await readBody(req)) as Partial<ChainConfig>;
        if (typeof body.ticketsVaultPath !== 'string' || body.ticketsVaultPath.trim() === '') {
          respond(422, { ok: false, error: 'the chain config needs a ticketsVaultPath' });
          return;
        }
        const status = await orchestrator.configure({
          ticketsVaultPath: body.ticketsVaultPath,
          git: typeof body.git === 'string' && body.git.trim() !== '' ? body.git : 'git',
          defaultWorker: typeof body.defaultWorker === 'string' && body.defaultWorker.trim() !== '' ? body.defaultWorker : 'opencode',
          permissionMode: body.permissionMode === 'bypass' ? 'bypass' : 'accept-edits',
        });
        respond(200, status);
        return;
      }
      if (req.method === 'POST' && pathname === '/chain/master') {
        const body = (await readBody(req)) as { mode?: unknown };
        if (body.mode !== 'run' && body.mode !== 'halted') {
          respond(422, { ok: false, error: 'the master mode is "run" or "halted"' });
          return;
        }
        respond(200, await orchestrator.setMaster(body.mode as ChainMaster));
        return;
      }
      if (req.method === 'POST' && pathname === '/chain/column') {
        const body = (await readBody(req)) as { phase?: unknown; mode?: unknown; stop?: unknown };
        if (typeof body.phase !== 'string' || body.phase.trim() === '') {
          respond(422, { ok: false, error: 'the column control needs a phase id' });
          return;
        }
        if (body.stop === true) {
          respond(200, await orchestrator.stopColumn(body.phase));
          return;
        }
        if (body.mode !== 'playing' && body.mode !== 'held') {
          respond(422, { ok: false, error: 'the column mode is "playing" or "held"' });
          return;
        }
        respond(200, await orchestrator.setColumn(body.phase, body.mode as ColumnMode));
        return;
      }
      if (req.method === 'POST' && pathname === '/chain/abort') {
        respond(200, await orchestrator.abortAll());
        return;
      }
      if (req.method === 'GET' && pathname === '/status') {
        const runs = [...supervisors.values()].flatMap((s) => s.list());
        respond(200, { runs });
        return;
      }
      if (req.method === 'POST' && pathname === '/start') {
        const request = (await readBody(req)) as RunRequest;
        const adapter = isWorkerProvider(request.provider) ? adapters[request.provider] : adapters['opencode'];
        const outcome = await supervisors.get(adapter.id)!.start(request);
        respond(outcome.ok ? 200 : 422, outcome);
        return;
      }
      if (req.method === 'POST' && pathname === '/stop') {
        const body = (await readBody(req)) as { runId?: unknown; reason?: unknown };
        const supervisor = supervisorOfRun(String(body.runId ?? ''));
        if (supervisor === null) {
          respond(404, { ok: false, error: `unknown run "${String(body.runId)}"` });
          return;
        }
        const outcome = await supervisor.stop(String(body.runId), typeof body.reason === 'string' ? body.reason : null);
        respond(outcome.ok ? 200 : 422, outcome);
        return;
      }
      if (req.method === 'POST' && pathname === '/send') {
        const body = (await readBody(req)) as { runId?: unknown; text?: unknown };
        const supervisor = supervisorOfRun(String(body.runId ?? ''));
        if (supervisor === null) {
          respond(404, { ok: false, error: `unknown run "${String(body.runId)}"` });
          return;
        }
        const outcome = await supervisor.send(String(body.runId), String(body.text ?? ''));
        respond(outcome.ok ? 200 : 422, outcome);
        return;
      }
      if (req.method === 'GET' && parts[0] === 'status' && parts.length === 2) {
        const supervisor = supervisorOfRun(parts[1]!);
        const run = supervisor?.get(parts[1]!) ?? null;
        if (run === null) {
          respond(404, { ok: false, error: `unknown run "${parts[1]}"` });
          return;
        }
        respond(200, { run, streamPath: supervisor?.streamPath(parts[1]!) });
        return;
      }
      if (req.method === 'GET' && parts[0] === 'stream' && parts.length === 2) {
        const supervisor = supervisorOfRun(parts[1]!);
        const streamPath = supervisor?.streamPath(parts[1]!) ?? null;
        if (streamPath === null) {
          respond(404, { ok: false, error: `unknown run "${parts[1]}"` });
          return;
        }
        const tail = await fsp.readFile(streamPath, 'utf8').catch(() => '');
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(tail.slice(-200_000));
        return;
      }
      respond(404, { ok: false, error: `no such route: ${req.method} ${pathname}` });
    } catch (error) {
      respond(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const supervisorsOfLive = (): number =>
    [...supervisors.values()].filter((s) => s.hasLive()).length;

  const supervisorOfRun = (runId: string): RunSupervisor | null => {
    for (const s of supervisors.values()) {
      if (s.get(runId) !== null) {
        return s;
      }
    }
    return null;
  };

  server.listen(port, '127.0.0.1', () => {
    fsSync.writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    log(`listening on 127.0.0.1:${port} (pid ${process.pid})`);
  });

  // The lease reaper's round (M85): a run whose worker process is
  // provably dead is failed and its ticket freed — chain or not.
  const reapTimer = setInterval(() => {
    void orchestrator.reapAll().catch((error) => log(`reap failed: ${String(error)}`));
  }, 60_000);
  reapTimer.unref();

  // Idle shutdown: nothing live, the chain is not running, and nobody
  // asked for a while — the plugin respawns the runner on demand. A
  // running chain keeps the process alive: it is the thing that drains
  // the board while Drey is closed (M85).
  const idleTimer = setInterval(() => {
    if (
      !orchestrator.active &&
      !supervisorsOfLive() &&
      Date.now() - lastRequest > args.idleMs
    ) {
      log(`idle for ${Math.round(args.idleMs / 1000)}s — shutting down`);
      shutdown(0);
    }
  }, 15_000);
  idleTimer.unref();

  const shutdown = (code: number): void => {
    fsSync.rmSync(descriptorPath, { force: true });
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 2_000).unref();
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('exit', () => {
    fsSync.rmSync(descriptorPath, { force: true });
  });
}

async function readDescriptor(descriptorPath: string): Promise<RunnerDescriptor | null> {
  try {
    const raw = await fsp.readFile(descriptorPath, 'utf8');
    const parsed = JSON.parse(raw) as RunnerDescriptor;
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function peerAlive(peer: RunnerDescriptor): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    const res = await fetch(`http://127.0.0.1:${peer.port}/health`, {
      headers: { Authorization: `Bearer ${peer.token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

void main();
