/**
 * Drey Service's host (req-164, ADR-0092): one process, four components,
 * one lifecycle.
 *
 * - **engine** — `createEngine`, the board service, chat, verify and the
 *   invoke channel; always on while the service runs.
 * - **runner** — the Crew runner, in-process ({@link RunnerComponent});
 *   sleeps on req-110's verdict and wakes on demand.
 * - **gateway** — the remote gateway inside the engine (ADR-0086); its row
 *   follows the remote settings (switched in Settings → Remote access).
 * - **mcp** — Drey's MCP server stays in the Drey process until req-167;
 *   the row says so (`external`).
 *
 * The host owns the control port (bearer = the engine token), the one log
 * (`service.log`, the component as a field), `service.lock`, and the
 * service-level sleep ({@link serviceSleepVerdict}).
 *
 * **Optional (the owner's ruling on Q3, 2026-11-08).** `service.enabled`
 * (default off) decides the mode, re-read every tick from the engine's
 * config (Drey syncs it from Settings → Tickets):
 * - **background** (on): the service outlives Drey and sleeps on the
 *   two-level verdict; `service.autostart` registers the log-in start.
 * - **with Drey** (off): the components live and die with Drey — once no
 *   Drey has held the event stream for {@link WITH_DREY_GRACE_MS} the
 *   service stops its live runs and leaves (Drey's exit prompt asked the
 *   owner first; a crashed Drey takes its runs with it).
 */
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createEngine, type Engine, type EngineOptions } from '../server/engine';
import { FileConfigStore } from '../server/file-config';
import type { Args, RunnerDeps, RunnerHandle } from '../fleet/runner';
import { hasHandedOverRuns, retireLegacyEngine, retireLegacyRunner, type LegacyDeps } from './legacy';
import { RunnerComponent } from './runner-component';
import {
  COMPONENT_NAMES,
  SERVICE_LOCK_VERSION,
  removeServiceLock,
  writeServiceLock,
  type ComponentName,
  type ComponentRecord,
  type ServiceLock,
} from './service-lock';
import { ServiceIdleWatch, serviceSleepVerdict, type ServiceLiveness, type SleepVerdict } from './sleep';

export type LogLevel = 'info' | 'warn' | 'error';

/** One service log line: time, level, component, message. */
export function formatServiceLogLine(at: Date, level: LogLevel, component: ComponentName | 'service', message: string): string {
  return `${at.toISOString()} ${level.padEnd(5)} ${component.padEnd(7)} ${message}`;
}

export interface ServiceHostOptions {
  readonly home: string;
  readonly vaultPath: string;
  readonly clientDir: string;
  /** This build's stamp (`<builtAt>#<hash>`). */
  readonly build: string;
  /** The service's idle span. */
  readonly idleMs: number;
  /** Ends the process once the service has shut down; `process.exit` in the entry. */
  readonly exit: (code: number) => void;
  /** Mirrors every log line (the entry: stdout). */
  readonly stdout?: (line: string) => void;
  /** How often the host re-checks sleep and rewrites the lock; 5 s by default. */
  readonly tickMs?: number;
  /** The runner's own idle span (req-110), 15 min by default. */
  readonly runnerIdleMs?: number;
  /** Test seams. */
  readonly createEngine?: (opts: EngineOptions) => Promise<Engine>;
  readonly engineOptions?: Partial<EngineOptions>;
  readonly startRunner?: (args: Args, deps: RunnerDeps) => Promise<RunnerHandle | null>;
  readonly legacy?: LegacyDeps;
  readonly now?: () => number;
  /**
   * Applies start with Windows (on = background mode and `service.autostart`);
   * the entry passes the registry writer, a spec leaves it out (no-op).
   */
  readonly applyAutostart?: (on: boolean) => Promise<void>;
  /** Test seams for the with-Drey spans ({@link WITH_DREY_GRACE_MS}, {@link FIRST_DREY_WAIT_MS}). */
  readonly withDreyGraceMs?: number;
  readonly firstDreyWaitMs?: number;
}

export interface ServiceStatus {
  readonly pid: number;
  readonly build: string;
  readonly startedAt: string;
  readonly vaultPath: string;
  readonly components: Readonly<Record<ComponentName, ComponentRecord>>;
  /** What holds the service now, or that nothing does. */
  readonly sleep: SleepVerdict;
  readonly dreyClients: number;
  /** `service.enabled`: background (outlives Drey) or with Drey. */
  readonly mode: ServiceMode;
}

type ShutdownReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

const LOG_CAP = 1024 * 1024;

/** With the service off: how long after the last Drey left the service follows it (longer than a reconnect). */
export const WITH_DREY_GRACE_MS = 10_000;
/** With the service off: how long a service started for a Drey waits for its first Drey before it gives up. */
export const FIRST_DREY_WAIT_MS = 120_000;

export type ServiceMode = 'background' | 'with-drey';

export class ServiceHost {
  private engine: Engine | null = null;
  private readonly runner: RunnerComponent;
  private server: http.Server | null = null;
  private token = '';
  private port = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly ring: string[] = [];
  private logChain: Promise<void> = Promise.resolve();
  private lastLockJson = '';
  private ticker: ReturnType<typeof setInterval> | null = null;
  private idle: ServiceIdleWatch;
  private closing: Promise<ShutdownReply> | null = null;
  private legacyRunnerBusy = false;
  private mode: ServiceMode = 'with-drey';
  private sawDrey = false;
  private dreyGoneAt: number | null = null;
  private readonly bootAt: number;
  private autostartApplied: boolean | null = null;

  private constructor(private readonly opts: ServiceHostOptions) {
    this.idle = new ServiceIdleWatch(opts.idleMs, opts.now);
    this.bootAt = this.now();
    const ownConfig = new FileConfigStore(path.join(opts.home, 'config.json'));
    this.runner = new RunnerComponent({
      root: path.join(opts.home, 'fleet'),
      ...(opts.runnerIdleMs === undefined ? {} : { idleMs: opts.runnerIdleMs }),
      // The engine's store is the one Drey's sync writes; before it exists, the file.
      storeBacked: async () => (await (this.engine?.config ?? ownConfig).get<string>('backend')) === 'dricket',
      log: (line) => this.log('runner', line.replace(/^\[fleet [^\]]+\] /, '')),
      onChange: () => void this.refreshLock(),
      ...(opts.startRunner === undefined ? {} : { start: opts.startRunner }),
    });
  }

  /** Migration, engine, control port, lock — in that order. */
  static async start(opts: ServiceHostOptions): Promise<ServiceHost> {
    const host = new ServiceHost(opts);
    await host.boot();
    return host;
  }

  log(component: ComponentName | 'service', message: string, level: LogLevel = 'info'): void {
    const line = formatServiceLogLine(new Date(), level, component, message);
    this.opts.stdout?.(line);
    this.ring.push(line);
    if (this.ring.length > 2000) {
      this.ring.splice(0, this.ring.length - 2000);
    }
    const file = path.join(this.opts.home, 'service.log');
    this.logChain = this.logChain
      .then(async () => {
        await fsp.appendFile(file, `${line}\n`, 'utf8');
        const stat = await fsp.stat(file).catch(() => null);
        if (stat !== null && stat.size > LOG_CAP) {
          const text = await fsp.readFile(file, 'utf8').catch(() => '');
          await fsp.writeFile(file, text.slice(-LOG_CAP / 2), 'utf8');
        }
      })
      .catch(() => undefined);
  }

  private async boot(): Promise<void> {
    const { home } = this.opts;
    await fsp.mkdir(home, { recursive: true });
    this.log('service', `starting (pid ${process.pid}, build ${this.opts.build}) for ${this.opts.vaultPath}`);

    // Migration (req-164): the pre-service processes go before anything binds.
    const log = (message: string): void => this.log('service', message);
    await retireLegacyEngine(home, log, this.opts.legacy).catch((error: unknown) => log(`retiring the old engine failed: ${String(error)}`));
    await this.retireLegacyRunnerOnce();

    this.engine = await (this.opts.createEngine ?? createEngine)({
      vaultPath: this.opts.vaultPath,
      home,
      clientDir: this.opts.clientDir,
      log: (message, level) => this.log('engine', message, level ?? 'info'),
      runner: this.runner,
      ...this.opts.engineOptions,
    });
    this.token = this.engine.token;
    await this.readMode();
    await this.listen();
    await this.refreshLock();
    this.log('service', `up: control 127.0.0.1:${this.port}, engine ${this.engine.invokeUrl}, ${this.mode === 'background' ? 'background (outlives Drey)' : 'with Drey (the background service is off)'}`);

    // Runs a retiring runner handed over wait for a successor: wake it now.
    if (!this.legacyRunnerBusy && (await hasHandedOverRuns(path.join(home, 'fleet')))) {
      this.log('runner', 'handed-over runs found — waking the runner to take them back');
      void this.runner.wake();
    }

    this.ticker = setInterval(() => void this.tick(), this.opts.tickMs ?? 5_000);
    this.ticker.unref();
  }

  /** The legacy runner's handover; a busy one blocks this service's runner until it has gone. */
  private async retireLegacyRunnerOnce(): Promise<void> {
    const outcome = await retireLegacyRunner(this.opts.home, (message) => this.log('service', message), this.opts.legacy).catch(
      (error: unknown) => {
        this.log('service', `retiring the old runner failed: ${String(error)}`, 'warn');
        return { kind: 'none' } as const;
      },
    );
    if (outcome.kind === 'busy') {
      if (!this.legacyRunnerBusy) {
        this.log('runner', `an older fleet runner (pid ${outcome.pid}) is still busy: ${outcome.reason} — asked again every tick`, 'warn');
      }
      this.legacyRunnerBusy = true;
      this.runner.block(`an older fleet runner (pid ${outcome.pid}) hands its runs over once it is free: ${outcome.reason}`);
    } else if (this.legacyRunnerBusy) {
      this.legacyRunnerBusy = false;
      this.runner.block(null);
      if (await hasHandedOverRuns(path.join(this.opts.home, 'fleet'))) {
        void this.runner.wake();
      }
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** `service.enabled` / `service.autostart` from the engine's config; applies start with Windows when it changed. */
  private async readMode(): Promise<void> {
    const config = this.engine?.config;
    const enabled = config === undefined || config === null ? false : (await config.get<unknown>('service.enabled').catch(() => undefined)) === true;
    const autostart = enabled && config !== undefined && config !== null && (await config.get<unknown>('service.autostart').catch(() => undefined)) === true;
    const mode: ServiceMode = enabled ? 'background' : 'with-drey';
    if (mode !== this.mode) {
      this.log('service', mode === 'background' ? 'the background service is on — it outlives Drey' : 'the background service is off — it ends with Drey');
      this.mode = mode;
    }
    if (autostart !== this.autostartApplied) {
      this.autostartApplied = autostart;
      await (this.opts.applyAutostart?.(autostart) ?? Promise.resolve()).then(
        () => this.log('service', `start with Windows: ${autostart ? 'on' : 'off'}`),
        (error: unknown) => this.log('service', `start with Windows could not be ${autostart ? 'registered' : 'removed'}: ${String(error)}`, 'warn'),
      );
    }
  }

  /** With the service off: true once Drey has gone for the grace (or never came). */
  private dreyLeft(state: ServiceLiveness): boolean {
    const now = this.now();
    if (state.dreyClients > 0) {
      this.sawDrey = true;
      this.dreyGoneAt = null;
      return false;
    }
    if (!this.sawDrey) {
      return now - this.bootAt >= (this.opts.firstDreyWaitMs ?? FIRST_DREY_WAIT_MS);
    }
    this.dreyGoneAt ??= now;
    return now - this.dreyGoneAt >= (this.opts.withDreyGraceMs ?? WITH_DREY_GRACE_MS);
  }

  private liveness(): ServiceLiveness {
    const remote = this.engine?.remoteStatus();
    return {
      dreyClients: this.engine?.dreyClients() ?? 0,
      runnerAwake: this.runner.awake,
      gatewayServesDevices: remote !== undefined && remote.config.enabled && remote.devices.length > 0,
    };
  }

  private async tick(): Promise<void> {
    if (this.closing !== null) {
      return;
    }
    if (this.legacyRunnerBusy) {
      await this.retireLegacyRunnerOnce();
    }
    await this.readMode();
    await this.refreshLock();
    const state = this.liveness();
    if (this.mode === 'with-drey') {
      // Keeps the background clock fresh for a switch to background later.
      this.idle.expired({ ...state, dreyClients: 1 });
      if (this.dreyLeft(state)) {
        this.log('service', 'the background service is off and Drey has gone — stopping the live runs and leaving');
        void this.shutdown({ handover: false });
      }
      return;
    }
    this.sawDrey ||= state.dreyClients > 0;
    if (this.idle.expired(state)) {
      this.log('service', `nothing has held the service for ${Math.round(this.opts.idleMs / 1000)}s (no Drey, the runner asleep, no paired device) — leaving`);
      void this.shutdown({ handover: false });
    }
  }

  private records(): Record<ComponentName, ComponentRecord> {
    const engine = this.engine;
    const remote = engine?.remoteStatus();
    const gateway: ComponentRecord =
      remote === undefined
        ? { state: 'stopped', detail: null }
        : !remote.config.enabled
          ? { state: 'stopped', detail: 'remote access is off' }
          : remote.listening !== null
            ? {
                state: 'running',
                detail: `${remote.deviceUrl ?? remote.listening} · ${remote.devices.length} paired device${remote.devices.length === 1 ? '' : 's'}`,
                port: Number(remote.listening.slice(remote.listening.lastIndexOf(':') + 1)),
              }
            : { state: 'failed', detail: remote.error ?? 'not listening' };
    return {
      engine:
        engine === null
          ? { state: 'starting', detail: null }
          : { state: 'running', detail: this.opts.vaultPath, port: Number(new URL(engine.invokeUrl).port) },
      runner: this.runner.record(),
      gateway,
      mcp: { state: 'external', detail: 'served by Drey (until req-167)' },
    };
  }

  status(): ServiceStatus {
    const state = this.liveness();
    return {
      pid: process.pid,
      build: this.opts.build,
      startedAt: this.startedAt,
      vaultPath: this.opts.vaultPath,
      components: this.records(),
      sleep: serviceSleepVerdict(state),
      dreyClients: state.dreyClients,
      mode: this.mode,
    };
  }

  private async refreshLock(): Promise<void> {
    if (this.server === null || this.closing !== null) {
      return;
    }
    const lock: ServiceLock = {
      version: SERVICE_LOCK_VERSION,
      pid: process.pid,
      build: this.opts.build,
      startedAt: this.startedAt,
      home: this.opts.home,
      vaultPath: this.opts.vaultPath,
      port: this.port,
      token: this.token,
      mode: this.mode,
      components: this.records(),
    };
    const json = JSON.stringify(lock);
    if (json === this.lastLockJson) {
      return;
    }
    this.lastLockJson = json;
    await writeServiceLock(this.opts.home, lock).catch((error: unknown) => this.log('service', `writing service.lock failed: ${String(error)}`, 'error'));
  }

  /**
   * Leaves. `handover` (a newer build, req-51): the runner hands its runs
   * over — refused while a run is in its gate, and then the service serves
   * on. Otherwise the runner stops its live runs first (the owner's quit).
   */
  shutdown(request: { readonly handover: boolean }): Promise<ShutdownReply> {
    if (this.closing !== null) {
      return this.closing;
    }
    const closing = (async (): Promise<ShutdownReply> => {
      if (request.handover) {
        const reply = await this.runner.handOver().catch((error: unknown) => ({ ok: false as const, error: String(error) }));
        if (!reply.ok) {
          this.log('service', `handover deferred: ${reply.error}`, 'warn');
          return reply;
        }
        this.log('service', 'handed over to a newer build — leaving');
      } else {
        await this.runner.stop().catch((error: unknown) => this.log('runner', `stop failed: ${String(error)}`, 'warn'));
      }
      return { ok: true };
    })();
    this.closing = closing.then(async (reply) => {
      if (!reply.ok) {
        this.closing = null;
        return reply;
      }
      if (this.ticker !== null) {
        clearInterval(this.ticker);
      }
      await this.engine?.close().catch((error: unknown) => this.log('engine', `close failed: ${String(error)}`, 'warn'));
      await removeServiceLock(this.opts.home, process.pid).catch(() => undefined);
      this.log('service', 'stopped');
      await this.logChain;
      this.server?.close();
      setTimeout(() => this.opts.exit(0), 50).unref?.();
      return reply;
    });
    return this.closing;
  }

  private async listen(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((error: unknown) => {
        this.log('service', `control: ${error instanceof Error ? error.message : String(error)}`, 'error');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the service control port did not bind');
    }
    this.server = server;
    this.port = address.port;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!tokenMatches(req.headers.authorization ?? '', this.token)) {
      send(401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://service.invalid');
    const parts = url.pathname.split('/').filter((p) => p !== '');
    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { ok: true, pid: process.pid, build: this.opts.build });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      send(200, { ok: true, ...this.status() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/log') {
      const tail = Number(url.searchParams.get('tail') ?? '');
      const component = url.searchParams.get('component');
      const count = Number.isFinite(tail) && tail > 0 ? Math.min(Math.trunc(tail), 2000) : 300;
      const lines = component === null ? this.ring : this.ring.filter((line) => line.split(/\s+/)[2] === component);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(lines.slice(-count).join('\n'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      const body = (await readJson(req)) as { handover?: unknown };
      const handover = body.handover === true;
      this.log('service', handover ? 'a newer build asks for the handover' : 'shutdown requested');
      if (handover) {
        const reply = await this.shutdown({ handover: true });
        send(reply.ok ? 200 : 409, reply);
      } else {
        send(200, { ok: true });
        void this.shutdown({ handover: false });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/settings') {
      // `service.enabled` / `service.autostart` from a terminal (`--autostart`); Drey writes them through configSet.
      const body = (await readJson(req)) as { enabled?: unknown; autostart?: unknown };
      const config = this.engine?.config;
      if (config === undefined || config === null) {
        send(503, { ok: false, error: 'the engine is not up yet' });
        return;
      }
      if (typeof body.enabled === 'boolean') {
        await config.set('service.enabled', body.enabled);
      }
      if (typeof body.autostart === 'boolean') {
        await config.set('service.autostart', body.autostart);
      }
      await this.readMode();
      await this.refreshLock();
      send(200, { ok: true, mode: this.mode, autostart: this.autostartApplied === true });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'components' && parts.length === 3) {
      const name = parts[1] as ComponentName;
      const action = parts[2];
      if (!COMPONENT_NAMES.includes(name) || (action !== 'start' && action !== 'stop')) {
        send(404, { ok: false, error: 'not found' });
        return;
      }
      if (name !== 'runner') {
        const why: Record<Exclude<ComponentName, 'runner'>, string> = {
          engine: 'the engine runs as long as the service runs — stop the service instead',
          gateway: 'the remote gateway follows Settings → Remote access',
          mcp: 'the MCP server is served by Drey until req-167',
        };
        send(409, { ok: false, error: why[name] });
        return;
      }
      if (action === 'start') {
        const woke = await this.runner.wake();
        send(woke.ok ? 200 : 409, woke.ok ? { ok: true, record: this.runner.record() } : woke);
      } else {
        await this.runner.stop();
        send(200, { ok: true, record: this.runner.record() });
      }
      return;
    }
    send(404, { ok: false, error: 'not found' });
  }
}

function tokenMatches(header: string, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return token !== '' && given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) {
      return {};
    }
    chunks.push(chunk as Buffer);
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}
