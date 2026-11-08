import { settleCommitStepsOnFleet } from './settle-on-fleet';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { parseFlowDraft, parseFlowEdit, parseFlowSave, type Parsed, parsePlanPartsEdit } from '../core/commands';
import { TicketsGit } from '../core/tickets-git';
import type { ChatBridge } from '../contracts/chat';
import { NOTES_VAULT_KEY } from '../contracts/notes';
import { remoteActorOf, type ChatChangePayload } from '../contracts/remote-protocol';
import type { VerifyHarness } from '../contracts/verify';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools } from '../fleet/protocol';
import { EngineBoardService } from '../services/board-service';
import { ChatService } from '../services/chat-service';
import { AGGREGATOR_SYSTEM_PROMPT, createChatBridge } from '../services/chat-llm';
import { FleetClient, type RunnerLocator } from '../services/fleet-client';
import { RunnerComponent } from '../service/runner-component';
import { ImprovementsService } from '../services/improvements-service';
import { NotesService } from '../services/notes-service';
import { VerifyService } from '../services/verify-service';
import { VideoService } from '../services/video-service';
import { FilePlanShadowStore } from '../services/plan-shadow';
import { FleetEventWriter, statusPathFor } from '../fleet/event-writer';
import type { FleetEvents } from '../fleet/orchestrator';
import { ChangeHub, DreyTicketsPort, type PathsChange } from './drey-port';
import { DreyPresence } from './drey-presence';
import { FileConfigStore } from './file-config';
import { RemoteService, type RemoteStatus } from './service';
import { parseSettingsPatch } from './settings';
import { FsEngineHost } from './standalone-host';
import { createPlaywrightVerifyHarness } from './verify-harness';

/**
 * The tickets engine (ADR-0088, E2b): the whole board service, the fleet
 * client and the remote gateway composed over one tickets vault on disk —
 * no Drey. Since req-164 it is the always-on component of Drey Service
 * (`../service/`, ADR-0092): the Drey plugin starts the service or adopts a
 * live one through `service.lock`; both then talk to the engine over the
 * invoke channel, and phones talk to it through the gateway's pairing.
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
  /** The verify step's harness; the Playwright driver by default (the specs' seam). */
  readonly verifyHarness?: VerifyHarness;
  /** The Mission Control chat's LLM bridge; `createChatBridge` by default (the specs' seam). */
  readonly chatBridge?: ChatBridge;
  /**
   * The Crew runner (req-164): Drey Service hands its runner component; a
   * spec may hand a fixed locator. Absent, the engine makes its own
   * in-process runner component over `<home>/fleet`.
   */
  readonly runner?: RunnerLocator;
  /**
   * How long after the last Drey event stream closed the engine asks the
   * runner to retire if idle (req-110); 5 s by default, longer than the
   * client's 2 s reconnect.
   */
  readonly dreyGoneGraceMs?: number;
}

export interface Engine {
  /** The loopbase for the invoke channel, e.g. http://127.0.0.1:41231. */
  readonly invokeUrl: string;
  /** The local bearer token every invoke call carries. */
  readonly token: string;
  config: FileConfigStore;
  invoke(method: string, payload?: unknown): Promise<unknown>;
  onEvent(listener: (what: 'board' | 'fleet' | 'remote' | 'chat', payload?: ChatChangePayload) => void): () => void;
  /** The files engine writes touched (D-3): the plugin-only paths channel. */
  onPaths(listener: (change: PathsChange) => void): () => void;
  /** Drey instances holding the event stream now (req-164: the service's "is a Drey here"). */
  dreyClients(): number;
  /** The remote gateway's state (the service's gateway row and its sleep verdict). */
  remoteStatus(): RemoteStatus;
  /** Settles once the startup housekeeping that runs behind `createEngine` (the videos folder, the retired config key) has finished. */
  readonly ready: Promise<void>;
  /** Stops the engine; resolves only after the startup housekeeping ended, so no file is written after it. */
  close(): Promise<void>;
}

/** Method names the invoke channel exposes. Everything else stays internal. */
const BOARD_METHODS = [
  'snapshot', 'storeListing', 'refresh', 'readTicket', 'refineTicket', 'setPriority', 'setTrack', 'saveAttachment',
  'createTicket', 'transition', 'archive', 'unarchive', 'acceptTicket', 'sendBack', 'answerNeed', 'ticketComments', 'archivedTickets', 'launchVersion',
  'changesOf', 'worktreeChangesOf', 'removeWorktreeForTicket', 'worktreeCleanup', 'worktreeBootSweep',
  'worktreesStatus', 'chainRefusal', 'setClaim', 'startRun', 'setColumnConfig', 'listPrompts', 'savePrompt',
  'restoreShippedPrompts', 'listRepos', 'saveRepos', 'pickFolder', 'scanRepos', 'listProjects',
  'switchProject', 'openTicketsFolder', 'folderStatus', 'numberFolders', 'reorderPhases', 'editPhase',
  'personaLearn', 'listPersonas', 'verifyTicket', 'verifyStatus', 'estimateOf',
  'chatSessions', 'chatOpen', 'chatSend', 'chatStart', 'chatConfirm', 'chatDismiss', 'chatShapeDecide', 'chatPlanStatus',
  'ticketDocument', 'saveDocument', 'setHumanName',
  'initialize', 'onVaultEvent',
] as const;

const FLEET_METHODS = ['runs', 'start', 'chainStatus', 'stop', 'send', 'answerPermission', 'answerQuestion', 'stream', 'setMaster', 'setAutopilot', 'setColumn', 'stopColumn', 'abortAll', 'startPolling', 'attach', 'control', 'log', 'status', 'retireIfIdle'] as const;

// The team's reads and controls (E13-8): the remote port's own methods, so
// Drey's Team tab and Capacity band show exactly what the phone shows.
// None of these names is in the board or fleet tables (a later register() wins).
const TEAM_METHODS = [
  'personas', 'handoffRun', 'chainPersonaPause', 'chainAutopilot', 'personaThread', 'personaThreadAppend',
  'personaMemory', 'personaMemoryAppend', 'personaMemoryPin', 'planParts',
  // The Persona page (board 7k): the phone's setup write and improvements card.
  'personaPatch', 'personaImprovements', 'personaImprovementDecide',
] as const;

// pair/revoke take primitive args; the invoke channel carries one object
// payload, so both get explicit adapters below (the generic register would
// hand the whole payload where a string is expected).
const REMOTE_METHODS = ['status', 'configure', 'init', 'localClient', 'cancelPairing'] as const;

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
  const runner =
    opts.runner ??
    new RunnerComponent({
      root: fleetRoot,
      storeBacked: async () => (await config.get<string>('backend')) === 'dricket',
      log: (line) => log(line),
      onChange: () => undefined,
    });
  const fleet = new FleetClient({
    root: fleetRoot,
    runner,
    log,
    onFleetChanged: () => hub.emit('fleet'),
  });
  // req-110: when the last Drey instance's event stream has been closed for
  // the grace span, the runner is asked to retire if idle — the runner keeps
  // itself for a live run or an On/Paused Autopilot.
  const presence = new DreyPresence(() => {
    void fleet.retireIfIdle().then(
      (reply) => {
        if (!reply.ok) {
          log(`the fleet runner could not be asked to retire: ${reply.error}`, 'warn');
        }
      },
      (error: unknown) => log(`the fleet runner could not be asked to retire: ${String(error)}`, 'warn'),
    );
  }, opts.dreyGoneGraceMs ?? 5_000);
  // E7: one shared event writer for the engine process — the board stamps
  // ledger phase/merged/archived lines, the verify service proof_ready
  // lines; the append-only files ride the next regular commit.
  const events = new FleetEventWriter({ vaultPath: opts.vaultPath, log });
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
    { events },
  );
  board.onChanged(() => hub.emit('board'));

  // E4: the machine verification step — the harness runs the ticket
  // worktree's built app headless; the service persists the proofs and
  // moves the ticket to the owner's checkpoint.
  const videos = new VideoService({ board, host, git, config, log });
  const verify = new VerifyService({
    board,
    host,
    harness: opts.verifyHarness ?? createPlaywrightVerifyHarness(),
    config,
    git,
    actor: `verify@${hostname().toLowerCase()}`,
    events,
    videos,
    log,
  });
  // The engine listens only after the board was checked for verify
  // candidates (and the scan's startup IO has settled).
  await verify.initialScan;
  // E11-1: the videos folder and its ignore rule exist from the start (E11-1c: nothing is ever deleted).
  const startupWork = videos.prepare().then(() => undefined, () => undefined);

  // E5a: the Mission Control chat — sessions under `tickets/_meta/chat/`,
  // one mission turn per owner message, every mutation a proposal card
  // that executes only on the owner's confirm, through the same board
  // methods the invoke channel exposes. The stream rides the hub as
  // 'chat' changes carrying { file, event }.
  const chat = new ChatService({
    board,
    host,
    git,
    bridge: opts.chatBridge ?? createChatBridge({ config }),
    shadows: new FilePlanShadowStore(path.join(opts.home, 'plan-shadow.json')),
    modelName: () => config.get<string>('chat.model'),
    actor: `chat@${hostname().toLowerCase()}`,
    log,
    onEvent: (file, event) => hub.emit('chat', { file, event }),
  });

  const remotePort = new DreyTicketsPort(board, fleet, hub, { allowBypass: () => remoteService.allowBypass() }, chat);
  // req-100: the active vault's notes for paired devices. Drey keeps the key on
  // its active vault; without Drey it is the last one it named, or the hosted vault.
  const notes = new NotesService({
    root: async () => {
      const named = await config.get<unknown>(NOTES_VAULT_KEY);
      return typeof named === 'string' && path.isAbsolute(named) ? named : opts.vaultPath;
    },
    log,
  });
  notes.onChanged(({ vaultPath, changed }) => hub.emitPaths({ vaultPath, changed, deleted: [] }));
  const remoteService: RemoteService = new RemoteService({
    config,
    port: remotePort,
    clientDir: opts.clientDir,
    notes,
    // E5c: the proof card's gallery — attachment bytes straight from the
    // vault, authorized per device token (the gateway stays vault-agnostic).
    attachments: async (name) => {
      const vault = await board.detect();
      if (vault === null) {
        return null;
      }
      try {
        return await fsp.readFile(path.join(vault.path, 'tickets', 'attachments', name));
      } catch {
        return null;
      }
    },
    // E12-3: the settings screen's "Include the n existing videos" count.
    countVideos: async () => (await videos.status()).count,
    videos: (name) => videos.stat(name),
    videosChanged: async (includeExisting) => {
      await videos.applyInGit(includeExisting);
    },
    log,
    onChanged: () => hub.emit('remote'),
  });
  await remoteService.init();

  // E6: the self-improvement loop — the aggregator watches the fleet's
  // settled runs per persona; when the friction pile crosses the
  // threshold it compacts findings into proposals through the LLM bridge
  // (its own system prompt), and the board persists them in one commit.
  const improvements = new ImprovementsService({
    // The board speaks the house command objects; the service speaks
    // positional args — the seam adapts.
    board: {
      listPersonaIds: () => board.listPersonaIds(),
      improvementInput: (personaId) => board.improvementInput(personaId),
      applyAggregation: (personaId, drafts, now) =>
        board.applyAggregation({ id: personaId, drafts, now: now.toISOString() }),
    },
    bridge: createChatBridge({ config, systemPrompt: AGGREGATOR_SYSTEM_PROMPT }),
    onRunsSettled: (listener) => hub.subscribe((what) => {
      if (what === 'fleet') {
        listener();
      }
    }),
    log,
  });
  await improvements.start();
  const stopSettling = settleCommitStepsOnFleet(
    (listener) => hub.subscribe((what) => listener(what)),
    () => board.settleCommitSteps(),
    log,
  );

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
  // The verify service answers the two verify methods — register() picks
  // exactly the names an object carries, the rest of BOARD_METHODS is the board's.
  register(verify, BOARD_METHODS);
  register(fleet, FLEET_METHODS);
  register(remoteService, REMOTE_METHODS);
  register(remotePort, TEAM_METHODS);
  table.set('pair', (payload) => {
    // Tolerant on the wire: `{ deviceName, readOnly }` from a proper caller,
    // or a bare string when a proxy passes the first positional argument.
    const message =
      typeof payload === 'string'
        ? ({ deviceName: payload } as { deviceName?: unknown; readOnly?: unknown })
        : ((payload ?? {}) as { deviceName?: unknown; readOnly?: unknown });
    return Promise.resolve(remoteService.pair(typeof message.deviceName === 'string' ? message.deviceName : '', message.readOnly === true));
  });
  table.set('revoke', (payload) => {
    const message = (payload ?? {}) as { id?: unknown };
    return remoteService.revoke(typeof message.id === 'string' ? message.id : '');
  });
  // The chat service speaks the ChatServicePort names (sessions/open/send/…);
  // the invoke channel exposes them under the chat* names from BOARD_METHODS.
  // The Flow tab (E13-11): the same flow calls the phone's editor makes over
  // HTTP, parsed by the same functions the router uses (one grammar, one guard).
  table.set('flow', (payload) => {
    const message = (payload ?? {}) as { id?: unknown; part?: unknown };
    const part = typeof message.part === 'number' ? message.part : null;
    return typeof message.id === 'string' ? remotePort.flow({ id: message.id, part }) : Promise.resolve({ ok: false, error: 'bad flow payload' });
  });
  const flowWrite = <T extends object>(parse: (p: unknown) => Parsed<T>, run: (cmd: T) => Promise<unknown>) => (payload: unknown): Promise<unknown> => {
    const cmd = parse(payload);
    return cmd.ok ? run(cmd.value) : Promise.resolve(cmd);
  };
  // The Parts block in the ticket (E13-10): the list edit the phone makes, same parser.
  table.set('planPartsEdit', flowWrite(parsePlanPartsEdit, (cmd) => remotePort.planPartsEdit(cmd, remoteActorOf('Drey'))));
  table.set('flowEdit', flowWrite(parseFlowEdit, (cmd) => remotePort.flowEdit(cmd)));
  table.set('flowDraft', flowWrite(parseFlowDraft, (cmd) => remotePort.flowDraft(cmd)));
  table.set('flowSave', flowWrite(parseFlowSave, (cmd) => remotePort.flowSave(cmd, remoteActorOf('Drey'))));
  // The settings page's engine half (E13-12): what the phone's Settings reads
  // and writes (`videos.*`, E12-3), behind the same guard (turning videos in
  // git on needs the confirmation).
  table.set('settingsRead', () => remoteService.settings().read('drey'));
  table.set('settingsPatch', (payload) => {
    const patch = parseSettingsPatch(payload);
    return patch.ok ? remoteService.settings().patch(patch.value, 'drey') : Promise.resolve(patch);
  });
  table.set('chatSessions', () => chat.sessions());
  table.set('chatOpen', (payload) => {
    if (typeof payload !== 'string') {
      throw new Error('chatOpen expects a session file path');
    }
    return chat.open(payload);
  });
  table.set('chatSend', (payload) => chat.send(payload as { readonly file: string; readonly text: string; readonly context?: string }));
  table.set('chatStart', (payload) => chat.start(payload as { readonly title?: string; readonly text: string; readonly ticket?: string; readonly context?: string }));
  table.set('chatPlanStatus', (payload) => {
    // A ticket id, or { ticket, text } to mark the open buffer instead of the file (E13-9).
    if (typeof payload === 'string') {
      return chat.planStatus(payload);
    }
    const message = (payload ?? {}) as { ticket?: unknown; text?: unknown };
    if (typeof message.ticket !== 'string') {
      throw new Error('chatPlanStatus expects a ticket id');
    }
    return chat.planStatus(message.ticket, typeof message.text === 'string' ? message.text : undefined);
  });
  table.set('chatConfirm', (payload) => chat.confirm(payload as { readonly file: string; readonly id: string }));
  table.set('chatDismiss', (payload) => chat.dismiss(payload as { readonly file: string; readonly id: string }));
  table.set('chatShapeDecide', (payload) => chat.shapeDecide(payload as { readonly file: string; readonly choice: 'keep' | 'split' }));
  // The Review tab's reads (E13-7): the branch's diff and one file of it --
  // the same board-service calls the phone's proof card reaches over HTTP.
  // The service takes positional arguments, the invoke channel one object.
  table.set('ticketDiff', (payload) => {
    const message = (payload ?? {}) as { id?: unknown };
    return board.ticketDiff(typeof message.id === 'string' ? message.id : '');
  });
  table.set('ticketFile', (payload) => {
    const message = (payload ?? {}) as { id?: unknown; path?: unknown };
    return board.ticketFile(typeof message.id === 'string' ? message.id : '', typeof message.path === 'string' ? message.path : '');
  });
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
      // bearer-only. Events: board | fleet | remote | chat (chat carries
      // the { file, event } stream payload).
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
      const detach = presence.attach();
      const unsubscribe = hub.subscribe((what, payload) => {
        res.write(`data: ${JSON.stringify(payload === undefined ? { change: what } : { change: what, ...payload })}\n\n`);
      });
      const unsubscribePaths = hub.subscribePaths((change) => {
        res.write(`data: ${JSON.stringify({ change: 'paths', ...change })}\n\n`);
      });
      const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 25_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
        unsubscribePaths();
        detach();
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
    ready: startupWork,
    invoke: (method, payload) => {
      const fn = table.get(method);
      if (fn === undefined) {
        return Promise.reject(new Error(`no such method: ${method}`));
      }
      return fn(payload);
    },
    onEvent: (listener) => hub.subscribe((what, payload) => listener(what, payload)),
    onPaths: (listener) => hub.subscribePaths(listener),
    dreyClients: () => presence.connected,
    remoteStatus: () => remoteService.status(),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      presence.dispose();
      fleet.dispose();
      stopSettling();
      improvements.dispose();
      verify.dispose();
      board.dispose();
      await remoteService.stop();
      await startupWork;
      await board.idle();
      await git.idle();
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
