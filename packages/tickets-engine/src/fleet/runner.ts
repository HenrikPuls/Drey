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
 * descriptor (peer dead) is taken over.
 *
 * When it leaves (req-110, `runner-lifecycle.ts`): with no live run and no
 * On/Paused Autopilot it exits when the Autopilot is switched Off, when
 * the engine asks (`POST /retire-if-idle`, sent once Drey is gone) and
 * after the idle span without a write. A live run always keeps it.
 *
 * Usage: node runner.js --root <abs-path-to-fleet-root> [--idle-ms <n>] [--store-backed]
 */
import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fleetBuildStamp } from './build-stamp';
import { kimiAdapter } from './kimi';
import { nodeKimiUsageReader } from './kimi-usage';
import { claudeCodeAdapter, opencodeAdapter } from './providers';
import { freePort, nodeSpawnFn, scrubInheritedEnv } from './procs';
import { parseAutopilotSet } from './autopilot';
import { Orchestrator, type FleetEvents } from './orchestrator';
import { FleetEventWriter, statusPathFor } from './event-writer';
import { dkTargetFor, retreatStages } from './dk-target';
import { MAX_ATTACHMENT_BYTES, RunSupervisor, type SupervisorRecord } from './runs';
import { personaCostReport, tokenReport, type ReportRun } from './report';
import { IdleWatch, retireVerdict, type RunnerLiveness } from './runner-lifecycle';
import {
  isWorkerProvider,
  normalizeFleetCaps,
  normalizeFleetHandover,
  normalizeChainStore,
  normalizeFleetPools,
  questionAnswersOf,
  type ChainConfig,
  type ChainMaster,
  type ColumnMode,
  type RunDkTarget,
  type RunRequest,
  type RunnerDescriptor,
} from './protocol';

const VERSION = 1;
const MAX_BODY = 1024 * 1024;

export interface Args {
  readonly root: string;
  readonly idleMs: number;
  /** The board lives in a dricket store (D-42): known at the start, before a chain config arrives. */
  readonly storeBacked?: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let root = '';
  let idleMs = 15 * 60_000;
  let storeBacked = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--store-backed') {
      storeBacked = true;
    } else if (argv[i] === '--root' && argv[i + 1] !== undefined) {
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
  return { root, idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 15 * 60_000, storeBacked };
}

/** The process seams the in-process spec replaces; the real entry uses the defaults. */
export interface RunnerDeps {
  /** Ends the process; `process.exit` by default. */
  readonly exit?: (code: number) => void;
  /** Mirrors every log line; `console.log` by default. */
  readonly stdout?: (line: string) => void;
  /**
   * Where the runner is found (req-164). `file` (the standalone entry, a
   * debugging tool since Drey Service): `<root>/runner.json` plus the
   * single-instance guard on it. `none` (the Crew runner component of Drey
   * Service): no file and no guard — `service.lock` records the endpoint and
   * the service is the single instance.
   */
  readonly descriptor?: 'file' | 'none';
  /** Whether the runner installs its own SIGINT/SIGTERM/exit handlers; the service handles signals itself. */
  readonly signals?: boolean;
}

/** What `startRunner` hands back: the spec reads the descriptor and ends the runner through it. */
export interface RunnerHandle {
  readonly port: number;
  readonly token: string;
  readonly descriptorPath: string;
  /** The endpoint record (port, token, pid, build) — the service writes it into `service.lock`. */
  readonly descriptor: RunnerDescriptor;
  /** The graceful stop: live runs stopped (bounded), the descriptor removed, `exit(0)`. */
  stop(): Promise<void>;
}

export async function startRunner(args: Args, deps: RunnerDeps = {}): Promise<RunnerHandle | null> {
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const stdout = deps.stdout ?? ((line: string): void => console.log(line));
  await fsp.mkdir(args.root, { recursive: true });
  await fsp.mkdir(path.join(args.root, 'runs'), { recursive: true });
  const descriptorPath = path.join(args.root, 'runner.json');
  const writesDescriptor = (deps.descriptor ?? 'file') === 'file';

  // Single instance: a healthy peer keeps this process out; a stale
  // descriptor (crashed runner) is taken over. Inside Drey Service the
  // service lock is the single instance (req-164).
  const existing = writesDescriptor ? await readDescriptor(descriptorPath) : null;
  if (existing !== null && (await peerAlive(existing))) {
    exit(0);
    return null;
  }

  // The daemon's log reaches three places: the console (lost for a
  // detached process), a ring buffer the /log route serves, and
  // runner.log — the owner's window into every dispatch decision
  // (T-0007 review finding 2: the daemon's doings were invisible).
  const logPath = path.join(args.root, 'runner.log');
  // The build stamp (req-51): a hash of the fleet code this process
  // loaded, plus its newest mtime. A rebuild that changed none of it
  // keeps this daemon; one that did makes the client retire it with a
  // handover — stale code never serves a second session.
  const buildStamp = await fleetBuildStamp(__filename);
  let handingOver = false;
  const ring: string[] = [];
  let logChain: Promise<void> = Promise.resolve();
  const log = (message: string): void => {
    const line = `[fleet ${new Date().toISOString()}] ${message}`;
    stdout(line);
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
  const scrubbed = scrubInheritedEnv(process.env);
  if (scrubbed.length > 0) {
    log(`workers start without ${scrubbed.length} inherited variable(s): ${scrubbed.join(', ')}`);
  }

  // Runs carry their provider, so the entry keeps one supervisor per
  // adapter and routes by the request's provider. The chain
  // orchestrator (M85) plans across both; its run-settled hook comes
  // back through the supervisors' dep.
  const adapters = {
    opencode: opencodeAdapter(nodeSpawnFn()),
    'claude-code': claudeCodeAdapter(nodeSpawnFn()),
    kimi: kimiAdapter(nodeSpawnFn(), nodeKimiUsageReader()),
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
        storeBacked: () => args.storeBacked === true || orchestrator?.onStore() === true,
        onRunSettled: (info) => void orchestrator?.onRunSettled(info),
        secondOpinion: (request) => orchestrator?.secondOpinion(request) ?? Promise.resolve(null),
      }),
    ]),
  );
  // E7: the status log + fleet ledger writer. The vault path arrives only
  // with the chain config below, so the writer is built lazily on the
  // first event and shared from then on.
  let eventWriter: FleetEventWriter | null = null;
  let eventsVaultPath: string | null = null;
  const events: FleetEvents = {
    ledger: (write) => {
      if (eventsVaultPath === null) {
        return;
      }
      eventWriter ??= new FleetEventWriter({ vaultPath: eventsVaultPath, log });
      eventWriter.ledger(write);
    },
    status: (cardPath, at, verb, payload) => {
      if (eventsVaultPath === null) {
        return;
      }
      eventWriter ??= new FleetEventWriter({ vaultPath: eventsVaultPath, log });
      eventWriter.status(cardPath, at, verb, payload);
    },
  };
  // E14-5b: one pass over all supervisors - a live run of the OTHER provider's supervisor must not read as a leftover.
  const releaseLeftoverClaimsOf = (target: RunDkTarget, retreat: Record<string, string | null>): ReturnType<RunSupervisor['releaseLeftoverClaims']> => {
    const live = new Set<string>();
    for (const sup of supervisors.values()) {
      for (const id of sup.liveTickets()) {
        live.add(id);
      }
    }
    return (supervisors.get('opencode') ?? [...supervisors.values()][0]!).releaseLeftoverClaims(target, retreat, live);
  };
  orchestrator = new Orchestrator({
    root: args.root,
    log,
    events,
    cardPathOf: (ticketId) =>
      eventsVaultPath === null
        ? Promise.resolve(null)
        : statusPathFor(eventsVaultPath, ticketId),
    supervisorOf: (provider) => supervisors.get(provider) ?? supervisors.get('opencode')!,
    // E14-5b: a killed runner's claims on a dricket store are released before the chain's first dispatch there.
    releaseLeftovers: async (store, pipeline) => {
      const report = await releaseLeftoverClaimsOf(
        dkTargetFor(store, pipeline, pipeline[0]?.id ?? ''),
        retreatStages(pipeline),
      );
      if (report.released.length > 0 || report.skipped.length > 0) {
        log(`leftover claims: released ${report.released.join(', ') || 'none'}${report.skipped.length > 0 ? `; skipped ${report.skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}` : ''}`);
      }
    },
    // The shipped default prompt beside the built plugin (`<plugin>/prompts/`), for
    // the "vault copy is older" note; a ref without a shipped file reads as null.
    shippedPrompt: (ref) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref)
        ? fsp.readFile(path.join(__dirname, '..', '..', 'prompts', `${ref}.md`), 'utf8').catch(() => null)
        : Promise.resolve(null),
  });
  for (const one of supervisors.values()) {
    await one.adopt();
  }
  await orchestrator.load();

  // A graceful exit halts the chain FIRST: each stopped run settles and
  // triggers a dispatch pass, which used to start fresh workers inside the
  // wait window — orphans once the process left. The wait is bounded so a
  // hung adapter cannot hold the daemon hostage.
  const stopLiveRunsForExit = async (): Promise<void> => {
    await orchestrator?.setMaster('halted').catch((error) => log(`halting the chain failed: ${String(error)}`));
    const stops = [...supervisors.values()].flatMap((sup) =>
      sup
        .list()
        .filter((info) => info.state === 'starting' || info.state === 'running')
        .map((info) => sup.stop(info.id, 'the runner was shut down')),
    );
    if (stops.length > 0) {
      log(`stopping ${stops.length} live run${stops.length === 1 ? '' : 's'} before exit`);
    }
    await Promise.race([Promise.allSettled(stops), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  };

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

  // The idle clock counts writes only (req-110): the engine's 2.5 s
  // `/status` poll used to reset it for as long as the engine lived.
  const idle = new IdleWatch(args.idleMs);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      idle.noteActivity();
    }
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

  const readBody = async (req: http.IncomingMessage, limit = MAX_BODY): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) {
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
      // D-51: a runner on its way out (req-110's exit after an Off) takes no
      // more writes — an On sent in that instant would be answered and then
      // lost with the process. The client waits for the exit and starts a
      // fresh runner instead.
      if (req.method === 'POST' && leaving && pathname !== '/shutdown' && pathname !== '/retire-if-idle') {
        respond(503, { ok: false, error: 'the runner is leaving', code: 'leaving' });
        return;
      }
      if (req.method === 'POST' && pathname === '/shutdown') {
        const body = (await readBody(req).catch(() => ({}))) as { handover?: unknown };
        if (body.handover === true) {
          // Retired for a newer build (req-51): the runs go on under the
          // successor. Mid-transition runs make it wait — the client asks
          // again on its next poll and this runner serves on meanwhile.
          if (handingOver) {
            respond(200, { ok: true });
            return;
          }
          const blocker = [...supervisors.values()].map((sup) => sup.handoverBlocker()).find((b) => b !== null) ?? null;
          if (blocker !== null) {
            respond(409, { ok: false, error: blocker });
            return;
          }
          handingOver = true;
          respond(200, { ok: true });
          log('handover requested by a newer build — leaving the live runs to the successor');
          let count = 0;
          for (const sup of supervisors.values()) {
            count += await sup.handOver().catch((error) => {
              log(`handover failed: ${String(error)}`);
              return 0;
            });
          }
          log(`handed over ${count} live run${count === 1 ? '' : 's'} — exiting`);
          // The successor keeps the master switch as it stands.
          await orchestrator?.markHandover().catch((error) => log(`handover stamp failed: ${String(error)}`));
          // runner.log is written behind a promise chain: flush it, or the
          // handover's lines are lost with the process.
          await logChain;
          // The descriptor goes only now: until the records are written, a
          // successor's boot guard must still find this runner alive.
          shutdown(0);
          return;
        }
        respond(200, { ok: true });
        log('shutdown requested — stopping live runs first, then exiting (a newer build hands over instead)');
        // Graceful: a worker left alive while its record goes detached is
        // an unsupervised agent on a parked ticket (T-0007 review). The
        // stop path is the owner's own button; the wait is bounded so a
        // hung adapter cannot hold the daemon hostage.
        await stopLiveRunsForExit();
        setTimeout(() => shutdown(0), 100);
        return;
      }
      if (req.method === 'POST' && pathname === '/retire-if-idle') {
        // Drey is gone (req-110): the engine asks the runner to leave when
        // nothing needs it. The decision is the runner's own — a live run or
        // an On/Paused Autopilot says no, and the reply says why — so no
        // `/health` → `/shutdown` pair can race a run that starts in between.
        // A route of its own, not a `/shutdown` flag: a runner from before
        // this build would read an unknown flag as the plain stop-all.
        const verdict = retireVerdict(liveness());
        respond(200, { ok: true, ...verdict });
        if (verdict.exiting) {
          leave('Drey closed and nothing is live');
        }
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
        const store = normalizeChainStore(body.store);
        const status = await orchestrator.configure({
          ticketsVaultPath: body.ticketsVaultPath,
          ...(store === null ? {} : { store }),
          git: typeof body.git === 'string' && body.git.trim() !== '' ? body.git : 'git',
          defaultWorker: typeof body.defaultWorker === 'string' && body.defaultWorker.trim() !== '' ? body.defaultWorker : 'opencode',
          permissionMode: body.permissionMode === 'bypass' ? 'bypass' : 'accept-edits',
          // Absent or invalid keys degrade to the defaults per key (T-0048):
          // an older plugin keeps a newer runner working.
          caps: normalizeFleetCaps(body.caps),
          pools: normalizeFleetPools(body.pools),
          // The handover thresholds (T-0049) reach the supervisors the
          // same way — their start-time resolution reads them.
          handover: normalizeFleetHandover(body.handover),
        });
        eventsVaultPath = body.ticketsVaultPath;
        for (const one of supervisors.values()) {
          one.setHandoverConfig(normalizeFleetHandover(body.handover));
        }
        respond(200, status);
        return;
      }
      if (req.method === 'POST' && pathname === '/claims/release-leftovers') {
        // E14-5b (4): the owner's "release leftover claims" action - agent claims of this host with no live run.
        const body = (await readBody(req)) as { dk?: unknown; retreat?: unknown };
        const store = normalizeChainStore(body.dk);
        if (store === null) {
          respond(422, { ok: false, error: 'release-leftovers needs the dricket store (dk)' });
          return;
        }
        const retreat: Record<string, string | null> = {};
        if (body.retreat !== null && typeof body.retreat === 'object') {
          for (const [stage, before] of Object.entries(body.retreat as Record<string, unknown>)) {
            retreat[stage] = typeof before === 'string' ? before : null;
          }
        }
        try {
          respond(200, { ok: true, ...(await releaseLeftoverClaimsOf(dkTargetFor(store, [], ''), retreat)) });
        } catch (error) {
          respond(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/chain/master') {
        const body = (await readBody(req)) as { mode?: unknown };
        if (body.mode !== 'run' && body.mode !== 'halted') {
          respond(422, { ok: false, error: 'the master mode is "run" or "halted"' });
          return;
        }
        respond(200, await orchestrator.setMaster(body.mode as ChainMaster));
        if (body.mode === 'halted') {
          leaveIfDeactivated();
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/chain/autopilot') {
        const parsed = parseAutopilotSet(await readBody(req), new Date());
        if (!parsed.ok) {
          respond(422, parsed);
          return;
        }
        respond(200, await orchestrator.setAutopilot(parsed.value));
        if (parsed.value.state === 'off') {
          leaveIfDeactivated();
        }
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
        // The Notaus leaves the Autopilot Off; the runs it stopped are
        // still settling, so this usually finds them live and the idle
        // span takes over once they are gone.
        leaveIfDeactivated();
        return;
      }
      if (req.method === 'POST' && pathname === '/chain/persona-pause') {
        const body = (await readBody(req)) as { persona?: unknown; paused?: unknown };
        if (typeof body.persona !== 'string' || body.persona.trim() === '') {
          respond(422, { ok: false, error: 'the persona pause needs a persona id' });
          return;
        }
        if (typeof body.paused !== 'boolean') {
          respond(422, { ok: false, error: 'the persona pause needs paused: true or false' });
          return;
        }
        respond(200, await orchestrator.setPersonaPaused(body.persona, body.paused));
        return;
      }
      if (req.method === 'GET' && pathname === '/status') {
        const runs = [...supervisors.values()].flatMap((s) => s.list());
        respond(200, { runs });
        return;
      }
      if (req.method === 'GET' && pathname === '/report') {
        // Token telemetry grouped by ticket, phase and model (T-0048) —
        // curl-able next to /status and /log. One run belongs to exactly
        // one supervisor; dedupe keeps a shared port honest.
        const byId = new Map<string, SupervisorRecord>();
        for (const sup of supervisors.values()) {
          for (const record of sup.records()) {
            if (!byId.has(record.info.id)) {
              byId.set(record.info.id, record);
            }
          }
        }
        const runs: ReportRun[] = [...byId.values()].map((record) => ({
          ticketId: record.info.ticketId,
          persona: record.info.persona ?? null,
          costUsd: record.info.costUsd ?? null,
          phase: record.info.phase ?? record.request.phase,
          model: record.info.model ?? record.request.model,
          provider: record.info.provider,
          usage: record.info.usage ?? null,
          tokensIn: record.info.tokensIn,
          tokensOut: record.info.tokensOut,
          tokensBeforeFirstWrite: record.info.tokensBeforeFirstWrite ?? null,
        }));
        respond(200, { ok: true, groups: tokenReport(runs), byPersona: personaCostReport(runs) });
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
      if (req.method === 'POST' && pathname === '/attach') {
        // base64 of up to MAX_ATTACHMENT_BYTES, plus the JSON around it
        const body = (await readBody(req, Math.ceil(MAX_ATTACHMENT_BYTES * 1.4) + 4096)) as {
          runId?: unknown;
          name?: unknown;
          data?: unknown;
        };
        const supervisor = supervisorOfRun(String(body.runId ?? ''));
        if (supervisor === null || typeof body.name !== 'string' || typeof body.data !== 'string') {
          respond(404, { ok: false, error: 'unknown run or bad attachment' });
          return;
        }
        const outcome = await supervisor.attachFile(String(body.runId), body.name, body.data);
        respond(outcome.ok ? 200 : 422, outcome);
        return;
      }
      if (req.method === 'POST' && pathname === '/resume') {
        const body = (await readBody(req)) as { runId?: unknown };
        const supervisor = supervisorOfRun(String(body.runId ?? ''));
        if (supervisor === null) {
          respond(404, { ok: false, error: `unknown run "${String(body.runId)}"` });
          return;
        }
        const outcome = await supervisor.resume(String(body.runId));
        respond(outcome.ok ? 200 : 422, outcome);
        return;
      }
      if (req.method === 'POST' && (pathname === '/takeover' || pathname === '/interrupt' || pathname === '/softpause' || pathname === '/release')) {
        const body = (await readBody(req)) as { runId?: unknown };
        const supervisor = supervisorOfRun(String(body.runId ?? ''));
        if (supervisor === null) {
          respond(404, { ok: false, error: `unknown run "${String(body.runId)}"` });
          return;
        }
        const runId = String(body.runId);
        const outcome =
          pathname === '/takeover'
            ? await supervisor.takeover(runId)
            : pathname === '/interrupt'
              ? await supervisor.interrupt(runId)
              : pathname === '/softpause'
                ? await supervisor.pauseAfterAction(runId)
                : await supervisor.release(runId);
        respond(outcome.ok ? 200 : 422, outcome);
        return;
      }
      if (req.method === 'POST' && pathname === '/permission') {
        // The owner's answer to a worker's pending approval (req-64).
        const body = (await readBody(req)) as { runId?: unknown; decision?: unknown };
        const supervisor = supervisorOfRun(String(body.runId ?? ''));
        if (supervisor === null) {
          respond(404, { ok: false, error: `unknown run "${String(body.runId)}"` });
          return;
        }
        if (body.decision !== 'once' && body.decision !== 'always' && body.decision !== 'reject') {
          respond(400, { ok: false, error: 'decision must be once, always or reject' });
          return;
        }
        const outcome = await supervisor.answerPermission(String(body.runId), body.decision);
        respond(outcome.ok ? 200 : 422, outcome);
        return;
      }
      if (req.method === 'POST' && pathname === '/answer') {
        // The owner's choices for a worker's question form (OpenCode's `question` tool).
        const body = (await readBody(req)) as { runId?: unknown; answers?: unknown };
        const supervisor = supervisorOfRun(String(body.runId ?? ''));
        if (supervisor === null) {
          respond(404, { ok: false, error: `unknown run "${String(body.runId)}"` });
          return;
        }
        const answers = questionAnswersOf(body.answers);
        if (answers === null) {
          respond(400, { ok: false, error: 'answers must map question keys to a string or a list of strings' });
          return;
        }
        const outcome = await supervisor.answerQuestion(String(body.runId), answers);
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
  const liveness = (): RunnerLiveness => ({
    live: supervisorsOfLive(),
    keepsAlive: orchestrator?.keepsRunnerAlive ?? false,
  });

  // The exit after a reply (req-110): the response leaves first, then the
  // descriptor goes and the server closes. Never during a handover — that
  // path ends the process itself once its records are written.
  let leaving = false;
  const leave = (why: string): void => {
    if (leaving || handingOver) {
      return;
    }
    leaving = true;
    log(`${why} — ${writesDescriptor ? 'exiting' : 'going to sleep'} (it starts again when it is needed)`);
    setTimeout(() => shutdown(0), 100);
  };
  /**
   * The Autopilot was switched Off (or the master halted, or the Notaus): deactivated, so the
   * runner leaves unless a run is live. Called only on the request that switched it off —
   * never on an On / run request: a runner without a chain config (no `/chain/config` yet,
   * which is every fresh vault) reads as "nothing to keep alive" and would leave right after
   * answering "Run the chain" (the fleet-snapshot e2e caught it, 2026-11-07).
   */
  const leaveIfDeactivated = (): void => {
    const state = liveness();
    if (retireVerdict(state).exiting) {
      leave('the Autopilot is off and nothing is live');
    } else if (!state.keepsAlive) {
      log('the Autopilot is off — the runner stays for its live runs and leaves after the idle span once they end');
    }
  };

  const supervisorOfRun = (runId: string): RunSupervisor | null => {
    for (const s of supervisors.values()) {
      if (s.get(runId) !== null) {
        return s;
      }
    }
    return null;
  };

  const listening = new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (writesDescriptor) {
        fsSync.writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
      }
      log(`listening on 127.0.0.1:${port} (pid ${process.pid})`);
      resolve();
    });
  });

  // The lease reaper's round (M85): a run whose worker process is
  // provably dead is failed and its ticket freed — chain or not.
  const reapTimer = setInterval(() => {
    void orchestrator.reapAll().catch((error) => log(`reap failed: ${String(error)}`));
  }, 60_000);
  reapTimer.unref();

  // Idle shutdown: nothing live, the Autopilot is Off, and no write for
  // a while — the engine respawns the runner on demand. A running chain
  // keeps the process alive: it is the thing that drains the board while
  // Drey is closed (M85). So does a Paused one: the runner is what
  // resumes it, and a respawn would boot as Off. Reads never count
  // (req-110): the engine polls for as long as it lives.
  const idleTimer = setInterval(() => {
    if (!leaving && !handingOver && idle.expired(liveness())) {
      log(`idle for ${Math.round(args.idleMs / 1000)}s — shutting down`);
      leaving = true;
      shutdown(0);
    }
  }, 15_000);
  idleTimer.unref();

  let exited = false;
  const shutdown = (code: number): void => {
    if (writesDescriptor) {
      fsSync.rmSync(descriptorPath, { force: true });
    }
    clearInterval(idleTimer);
    clearInterval(reapTimer);
    // In-process (the service's component) nothing ends with the process:
    // the chain's scan timer must stop with the runner.
    orchestrator?.dispose();
    const once = (): void => {
      if (!exited) {
        exited = true;
        exit(code);
      }
    };
    server.close(once);
    setTimeout(once, 2_000).unref();
  };
  const onSignal = (): void => {
    void stopLiveRunsForExit().finally(() => shutdown(0));
  };
  if (deps.signals ?? true) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('exit', () => {
      if (writesDescriptor) {
        fsSync.rmSync(descriptorPath, { force: true });
      }
    });
  }

  await listening;
  return {
    port,
    token,
    descriptorPath,
    descriptor,
    stop: async () => {
      await stopLiveRunsForExit();
      await new Promise<void>((resolve) => {
        server.once('close', resolve);
        shutdown(0);
      });
    },
  };
}

async function main(): Promise<void> {
  await startRunner(parseArgs(process.argv.slice(2)));
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

// The process entry only: the spec imports `startRunner` and runs the
// daemon in-process against a temp root.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main();
}
