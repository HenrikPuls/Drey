/**
 * The remote gateway's JSON API (req-66, ADR-0084), as a function from
 * a parsed request to a response — the HTTP server around it only moves
 * bytes, so every rule here is testable without a socket.
 *
 * Status codes are for the transport and access only (400 bad JSON,
 * 401/403 access, 404, 429); a board refusal is a 200 with
 * `{ ok: false, error }`, exactly as over IPC.
 */
import {
  parseAnswer,
  parseChainColumn,
  parseChainColumnStop,
  parseChainMaster,
  parseClaim,
  parseCreate,
  parsePermission,
  parseReorder,
  parseSend,
  parseStartRun,
  parseStopRun,
  parseTransition,
  type Parsed,
} from '../commands';
import { remoteActorOf, type TicketsRemotePort } from '../../shared/remote-protocol';
import { TICKET_ID_PATTERN } from '../../shared/tickets';
import type { DeviceRegistry, DeviceView, FailureLimiter, PairingCodes, RemoteDevice } from './auth';

/** The registry's part the router uses (`DeviceRegistry` fits it). */
export type DeviceAccess = Pick<DeviceRegistry, 'byToken' | 'touch' | 'add'>;
import { hostAllowed, originAllowed } from './config';

export const REMOTE_API_VERSION = 1;

export interface RemoteRequest {
  readonly method: string;
  /** The URL path without query. */
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly authorization: string | undefined;
  /** The parsed JSON body; undefined when there was none. */
  readonly body: unknown;
  /** The client address (the limiter's key). */
  readonly remote: string;
}

export interface RemoteResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface RouterDeps {
  readonly port: TicketsRemotePort;
  readonly devices: DeviceAccess;
  readonly pairing: PairingCodes;
  readonly limiter: FailureLimiter;
  readonly allowedHosts: () => ReadonlySet<string>;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  /** A device paired — Settings refreshes its list. */
  readonly onPaired: (device: DeviceView) => void;
}

const fail = (status: number, error: string): RemoteResponse => ({ status, body: { ok: false, error } });
const json = (body: unknown): RemoteResponse => ({ status: 200, body });

/** The Host check every request passes first — API, events and static files alike. */
export function hostRefusal(req: Pick<RemoteRequest, 'host'>, deps: Pick<RouterDeps, 'allowedHosts'>): RemoteResponse | null {
  return hostAllowed(req.host, deps.allowedHosts()) ? null : fail(421, 'this address is not served here');
}

/** The paired device behind the bearer token, or the refusal. */
export function authorize(req: RemoteRequest, deps: RouterDeps): { device: RemoteDevice } | { response: RemoteResponse } {
  const now = deps.now();
  if (deps.limiter.blocked(req.remote, now.getTime())) {
    return { response: fail(429, 'too many failed attempts — wait ten minutes') };
  }
  const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(req.authorization ?? '');
  const device = match === null ? null : deps.devices.byToken(match[1]!);
  if (device === null) {
    deps.limiter.fail(req.remote, now.getTime());
    return { response: fail(401, 'this device is not paired') };
  }
  void deps.devices.touch(device.id, now).catch(() => undefined);
  return { device };
}

export async function route(req: RemoteRequest, deps: RouterDeps): Promise<RemoteResponse> {
  const refused = hostRefusal(req, deps);
  if (refused !== null) {
    return refused;
  }
  if (req.method === 'GET' && req.path === '/api/health') {
    return json({ ok: true, version: REMOTE_API_VERSION });
  }
  if (req.method === 'POST' && !originAllowed(req.origin, deps.allowedHosts())) {
    return fail(403, 'this request comes from another site');
  }
  if (req.method === 'POST' && req.path === '/api/pair') {
    return pair(req, deps);
  }
  const auth = authorize(req, deps);
  if ('response' in auth) {
    return auth.response;
  }
  const device = auth.device;
  if (req.method === 'POST' && device.readOnly) {
    return fail(403, 'this device is paired read-only');
  }
  try {
    return await dispatch(req, device, deps);
  } catch (error) {
    deps.log(`remote ${device.name}: ${req.method} ${req.path} failed: ${error instanceof Error ? error.message : String(error)}`);
    return fail(500, 'the request failed on the desk — see the plugin log');
  }
}

async function pair(req: RemoteRequest, deps: RouterDeps): Promise<RemoteResponse> {
  const now = deps.now();
  if (deps.limiter.blocked(req.remote, now.getTime())) {
    return fail(429, 'too many failed attempts — wait ten minutes');
  }
  const code = (req.body as { code?: unknown } | undefined)?.code;
  const pending = typeof code === 'string' ? deps.pairing.consume(code, now.getTime()) : null;
  if (pending === null) {
    deps.limiter.fail(req.remote, now.getTime());
    deps.log(`remote: a pairing attempt from ${req.remote} failed`);
    return fail(401, 'the pairing code is wrong or has expired');
  }
  const { device, token } = await deps.devices.add(pending.deviceName, pending.readOnly, now);
  deps.log(`remote: paired "${device.name}"${device.readOnly ? ' (read-only)' : ''}`);
  deps.onPaired(device);
  return json({ ok: true, token, device });
}

async function dispatch(req: RemoteRequest, device: RemoteDevice, deps: RouterDeps): Promise<RemoteResponse> {
  const { port } = deps;
  const actor = remoteActorOf(device.name);
  const body = req.body ?? {};
  const write = <T>(what: string, parsed: Parsed<T>, run: (value: T) => Promise<unknown>): Promise<RemoteResponse> => {
    if (!parsed.ok) {
      return Promise.resolve(json(parsed));
    }
    deps.log(`remote ${device.name}: ${what}`);
    return run(parsed.value).then(json);
  };

  if (req.method === 'GET') {
    switch (req.path) {
      case '/api/me':
        return json({ ok: true, device: viewOf(device), actor });
      case '/api/board':
        return json(await port.board());
      case '/api/fleet':
        return json(await port.fleet());
      case '/api/needs':
        return json(await port.needs());
    }
    const stream = /^\/api\/runs\/([A-Za-z0-9_.-]+)\/stream$/.exec(req.path);
    if (stream !== null) {
      return json({ text: await port.stream(stream[1]!) });
    }
    return fail(404, 'no such route');
  }

  if (req.method !== 'POST') {
    return fail(405, 'only GET and POST are served');
  }
  if (req.path === '/api/tickets') {
    return write('create', parseCreate(body), (cmd) => port.create(cmd, actor));
  }
  const ticket = /^\/api\/tickets\/([^/]+)\/(move|reorder|unpin|claim|archive)$/.exec(req.path);
  if (ticket !== null) {
    const id = decodeURIComponent(ticket[1]!);
    if (!TICKET_ID_PATTERN.test(id)) {
      return fail(404, 'no such ticket id');
    }
    const withId = { ...(body as object), id };
    switch (ticket[2]) {
      case 'move':
        return write(`move ${id}`, parseTransition(withId), (cmd) => port.move(cmd, actor));
      case 'reorder':
        return write(`reorder ${id}`, parseReorder(withId), (cmd) => port.reorder(cmd));
      case 'unpin':
        return write(`unpin ${id}`, { ok: true, value: { id } }, (cmd) => port.unpin(cmd));
      case 'claim':
        return write(`claim ${id}`, parseClaim(withId), (cmd) => port.claim(cmd, actor));
      default:
        return write(`archive ${id}`, { ok: true, value: { id } }, (cmd) => port.archive(cmd, actor));
    }
  }
  if (req.path === '/api/runs') {
    return write('run start', parseStartRun(body), (cmd) => port.startRun(cmd));
  }
  const run = /^\/api\/runs\/([A-Za-z0-9_.-]+)\/(stop|send|answer|permission)$/.exec(req.path);
  if (run !== null) {
    const withRun = { ...(body as object), runId: run[1]! };
    switch (run[2]) {
      case 'stop':
        return write(`stop ${run[1]}`, parseStopRun(withRun), (cmd) => port.stopRun(cmd));
      case 'send':
        return write(`steer ${run[1]}`, parseSend(withRun), (cmd) => port.send(cmd));
      case 'answer':
        return write(`answer ${run[1]}`, parseAnswer(withRun), (cmd) => port.answer(cmd));
      default:
        return write(`permission ${run[1]}`, parsePermission(withRun), (cmd) => port.permission(cmd));
    }
  }
  switch (req.path) {
    case '/api/chain/master':
      return write('chain master', parseChainMaster(body), (cmd) => port.chainMaster(cmd.mode));
    case '/api/chain/column':
      return write('chain column', parseChainColumn(body), (cmd) => port.chainColumn(cmd.phase, cmd.mode));
    case '/api/chain/column-stop':
      return write('chain column stop', parseChainColumnStop(body), (cmd) => port.chainColumnStop(cmd.phase));
    case '/api/chain/abort':
      return write('chain abort', { ok: true, value: null }, () => port.chainAbort());
  }
  return fail(404, 'no such route');
}

function viewOf(device: RemoteDevice): DeviceView {
  const { tokenHash: _hash, ...view } = device;
  return view;
}
