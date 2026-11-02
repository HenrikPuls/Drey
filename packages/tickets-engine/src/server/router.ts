/**
 * The remote gateway's JSON API (req-66, ADR-0086), as a function from
 * a parsed request to a response — the HTTP server around it only moves
 * bytes, so every rule here is testable without a socket.
 *
 * Status codes are for the transport and access only (400 bad JSON,
 * 401/403 access, 404, 429); a board refusal is a 200 with
 * `{ ok: false, error }`, exactly as over IPC.
 */
import {
  parseAnswer,
  parseAttachment,
  parseChainColumn,
  parseChainColumnStop,
  parseChainMaster,
  parseClaim,
  parseCreate,
  parsePermission,
  parseRefine,
  parseSend,
  parseStartRun,
  parseStopRun,
  parseTransition,
  type Parsed,
} from '../core/commands';
import { remoteActorOf, type ImprovementDecision, type TicketsRemotePort } from '../contracts/remote-protocol';
import { TICKET_ID_PATTERN } from '../contracts/tickets';
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

/**
 * The chat session files live under `tickets/_meta/chat/` (core/chat-session.ts).
 * The router admits exactly that shape — no `..`, no other folders — before
 * a path reaches the port.
 */
const CHAT_FILE_PATTERN = /^tickets\/_meta\/chat\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function asObject(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function parseChatStart(body: unknown): Parsed<{ title?: string; text: string }> {
  const obj = asObject(body);
  const text = typeof obj?.['text'] === 'string' ? obj['text'].trim() : '';
  const title = obj?.['title'];
  if (obj === null || (title !== undefined && typeof title !== 'string')) {
    return { ok: false, error: 'bad chat start payload' };
  }
  if (text === '') {
    return { ok: false, error: 'a chat start needs text' };
  }
  const name = typeof title === 'string' ? title.trim() : '';
  return { ok: true, value: { title: name === '' ? undefined : name, text } };
}

function parseChatSend(file: string, body: unknown): Parsed<{ file: string; text: string }> {
  const obj = asObject(body);
  const text = typeof obj?.['text'] === 'string' ? obj['text'].trim() : '';
  if (obj === null) {
    return { ok: false, error: 'bad chat message payload' };
  }
  if (text === '') {
    return { ok: false, error: 'a chat message needs text' };
  }
  return { ok: true, value: { file, text } };
}

/** The phone edit mode's raw save: the text must be a whole ticket file (E5c). */
function parseTicketSave(body: unknown): Parsed<{ id: string; text: string; baseRevision?: string }> {
  const obj = asObject(body);
  const text = typeof obj?.['text'] === 'string' ? obj['text'] : '';
  const base = obj?.['baseRevision'];
  if (obj === null || text.trim() === '') {
    return { ok: false, error: 'a save needs the ticket text' };
  }
  if (base !== undefined && typeof base !== 'string') {
    return { ok: false, error: 'baseRevision must be a string' };
  }
  return { ok: true, value: { ...(obj as { id: string }), text, ...(typeof base === 'string' ? { baseRevision: base } : {}) } };
}

/** Send-back: the note is mandatory — a send-back never goes without why (E5c). */
function parseSendBack(body: unknown): Parsed<{ id: string; note: string }> {
  const obj = asObject(body);
  const note = typeof obj?.['note'] === 'string' ? obj['note'].trim() : '';
  if (obj === null || note === '') {
    return { ok: false, error: 'a send-back needs a note' };
  }
  return { ok: true, value: { ...(obj as { id: string }), note } };
}

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
      case '/api/personas':
        return json(await port.personas());
      case '/api/chat/sessions':
        return json(await port.chatSessions());
    }
    const ticket = /^\/api\/tickets\/([^/]+)$/.exec(req.path);
    if (ticket !== null) {
      const id = decodeURIComponent(ticket[1]!);
      return TICKET_ID_PATTERN.test(id) ? json(await port.ticket(id)) : fail(404, 'no such ticket id');
    }
    // The E6 improvements card; the persona id is pinned by the personaRef
    // grammar (lowercase letters, digits, dashes) before it reaches the port.
    const improvements = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})\/improvements$/.exec(req.path);
    if (improvements !== null) {
      return json(await port.personaImprovements(improvements[1]!));
    }
    const stream = /^\/api\/runs\/([A-Za-z0-9_.-]+)\/stream$/.exec(req.path);
    if (stream !== null) {
      return json({ text: await port.stream(stream[1]!) });
    }
    const changes = /^\/api\/tickets\/([^/]+)\/worktree-changes$/.exec(req.path);
    if (changes !== null) {
      const id = decodeURIComponent(changes[1]!);
      return TICKET_ID_PATTERN.test(id) ? json(await port.ticketWorktreeChanges(id)) : fail(404, 'no such ticket id');
    }
    const diff = /^\/api\/tickets\/([^/]+)\/diff$/.exec(req.path);
    if (diff !== null) {
      const id = decodeURIComponent(diff[1]!);
      return TICKET_ID_PATTERN.test(id) ? json(await port.ticketDiff(id)) : fail(404, 'no such ticket id');
    }
    const chatSession = /^\/api\/chat\/sessions\/(.+)$/.exec(req.path);
    if (chatSession !== null) {
      const file = decodeURIComponent(chatSession[1]!);
      return CHAT_FILE_PATTERN.test(file) ? json(await port.chatOpen(file)) : fail(404, 'no such chat session');
    }
    return fail(404, 'no such route');
  }

  if (req.method !== 'POST') {
    return fail(405, 'only GET and POST are served');
  }
  if (req.path === '/api/tickets') {
    // The create's priority reads against the board's configured
    // vocabulary (unknown ids fall back to its default, as always).
    const priorities = (await port.board()).priorities;
    return write('create', parseCreate(body, priorities), (cmd) => port.create(cmd, actor));
  }
  if (req.path === '/api/attachments') {
    return write('attachment', parseAttachment(body), (cmd) => port.saveAttachment(cmd, actor));
  }
  const ticket = /^\/api\/tickets\/([^/]+)\/(move|claim|archive|refine|save|accept|send-back)$/.exec(req.path);
  if (ticket !== null) {
    const id = decodeURIComponent(ticket[1]!);
    if (!TICKET_ID_PATTERN.test(id)) {
      return fail(404, 'no such ticket id');
    }
    const withId = { ...(body as object), id };
    switch (ticket[2]) {
      case 'move':
        return write(`move ${id}`, parseTransition(withId), (cmd) => port.move(cmd, actor));
      case 'claim':
        return write(`claim ${id}`, parseClaim(withId), (cmd) => port.claim(cmd, actor));
      case 'refine': {
        // The header's priority validates against the board's configured
        // vocabulary, not a hard-coded list.
        const priorities = (await port.board()).priorities;
        return write(`refine ${id}`, parseRefine(withId, priorities), (cmd) => port.refine(cmd, actor));
      }
      case 'save':
        return write(`save ${id}`, parseTicketSave(withId), (cmd) => port.ticketSave(cmd, actor));
      case 'accept':
        return write(`accept ${id}`, { ok: true, value: { id } }, (cmd) => port.ticketAccept(cmd, actor));
      case 'send-back':
        return write(`send-back ${id}`, parseSendBack(withId), (cmd) => port.ticketSendBack(cmd, actor));
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
  if (req.path === '/api/chat/sessions') {
    return write('chat start', parseChatStart(body), (cmd) => port.chatStart(cmd));
  }
  const chatMessage = /^\/api\/chat\/sessions\/(.+)\/messages$/.exec(req.path);
  if (chatMessage !== null) {
    const file = decodeURIComponent(chatMessage[1]!);
    if (!CHAT_FILE_PATTERN.test(file)) {
      return fail(404, 'no such chat session');
    }
    return write('chat send', parseChatSend(file, body), (cmd) => port.chatSend(cmd));
  }
  const chatDecision = /^\/api\/chat\/sessions\/(.+)\/proposals\/(p-\d+)\/(confirm|dismiss)$/.exec(req.path);
  if (chatDecision !== null) {
    const file = decodeURIComponent(chatDecision[1]!);
    if (!CHAT_FILE_PATTERN.test(file)) {
      return fail(404, 'no such chat session');
    }
    const input = { file, id: chatDecision[2]! };
    return write(
      `chat ${chatDecision[3]}`,
      { ok: true, value: input },
      (cmd) => (chatDecision[3] === 'confirm' ? port.chatConfirm(cmd) : port.chatDismiss(cmd)),
    );
  }

  // E6: the 1:1's decision — apply/dismiss one open proposal of one
  // persona; the path pins both ids (personaRef grammar, imp-<n>).
  const improvement = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})\/improvements\/(imp-\d+)\/(apply|dismiss)$/.exec(req.path);
  if (improvement !== null) {
    const decision: ImprovementDecision = improvement[3] === 'apply' ? 'accepted' : 'dismissed';
    return write(
      `improvement ${improvement[2]} ${decision}`,
      { ok: true, value: { persona: improvement[1]!, proposal: improvement[2]!, decision } },
      (cmd) => port.personaImprovementDecide(cmd),
    );
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
