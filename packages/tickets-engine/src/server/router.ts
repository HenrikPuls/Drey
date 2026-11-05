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
  parseFlowDraft,
  parseFlowEdit,
  parseFlowSave,
  parsePlanPartsEdit,
  parsePlanRelease,
  parseRefine,
  parseSend,
  parseStartRun,
  parseStopRun,
  parseTransition,
  type Parsed,
} from '../core/commands';
import { remoteActorOf, type ImprovementDecision, type TicketsRemotePort } from '../contracts/remote-protocol';
import { parseReviewComments, sendBackNoteOf, type ReviewComment } from '../core/review-feedback';
import type { PersonaRouter } from '../core/persona';
import { TICKET_ID_PATTERN } from '../contracts/tickets';
import { parseRevoke, parseSettingsPatch, type SettingsAccess } from './settings';
import type { DeviceRegistry, DeviceView, FailureLimiter, PairingCodes, RemoteDevice } from './auth';
import type { PairingView } from './service';

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
  /** The settings screen's engine half (E12-3); absent on a host without one (404). */
  readonly settings?: SettingsAccess;
  /** Pairing from a paired device (D-2); absent on a host without it (404). */
  readonly pairingAccess?: PairingAccess;
}

/** What a pairing call answers: the waiting pairing (or none) and whether a phone could open its link. */
export interface PairingReply {
  readonly ok: true;
  readonly pairing: PairingView | null;
  /** The device address is this computer's loopback — "set the device address first". */
  readonly needsPublicUrl: boolean;
}

/** The pairing half the router calls; the remote service implements it. */
export interface PairingAccess {
  current(): PairingReply;
  start(name: string, readOnly: boolean): PairingReply;
  cancel(): PairingReply;
}

function parsePairingStart(body: unknown): Parsed<{ name: string; readOnly: boolean }> {
  const obj = asObject(body);
  const name = obj?.['name'];
  const readOnly = obj?.['readOnly'];
  if (obj === null || (name !== undefined && typeof name !== 'string')) {
    return { ok: false, error: 'bad pairing payload' };
  }
  if (readOnly !== undefined && typeof readOnly !== 'boolean') {
    return { ok: false, error: 'readOnly is true or false' };
  }
  return { ok: true, value: { name: (name ?? '').trim().slice(0, 40), readOnly: readOnly === true } };
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

function parseChatStart(body: unknown): Parsed<{ title?: string; text: string; ticket?: string }> {
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
  const ticket = obj['ticket'];
  if (ticket !== undefined && !(typeof ticket === 'string' && TICKET_ID_PATTERN.test(ticket))) {
    return { ok: false, error: 'ticket must be a ticket id' };
  }
  return { ok: true, value: { title: name === '' ? undefined : name, text, ...(ticket === undefined ? {} : { ticket: ticket as string }) } };
}

function parseChatSend(file: string, body: unknown): Parsed<{ file: string; text: string; planEdits?: boolean }> {
  const obj = asObject(body);
  const text = typeof obj?.['text'] === 'string' ? obj['text'].trim() : '';
  if (obj === null) {
    return { ok: false, error: 'bad chat message payload' };
  }
  if (text === '') {
    return { ok: false, error: 'a chat message needs text' };
  }
  const planEdits = obj['planEdits'];
  if (planEdits !== undefined && typeof planEdits !== 'boolean') {
    return { ok: false, error: 'planEdits is true or false' };
  }
  return { ok: true, value: { file, text, ...(planEdits === undefined ? {} : { planEdits }) } };
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

/**
 * Send-back: a send-back never goes without why (E5c) — a note, or (E11-3)
 * line comments, which then stand in for the note.
 */
function parseSendBack(body: unknown): Parsed<{ id: string; note: string; comments?: readonly ReviewComment[] }> {
  const obj = asObject(body);
  const comments = parseReviewComments(obj?.['comments']);
  let note = typeof obj?.['note'] === 'string' ? obj['note'].trim() : '';
  if (obj === null || (note === '' && comments.length === 0)) {
    return { ok: false, error: 'a send-back needs a note' };
  }
  if (note === '') {
    note = sendBackNoteOf('', comments.length);
  }
  const { comments: _raw, ...rest } = obj as { id: string; comments?: unknown };
  return { ok: true, value: { ...rest, note, ...(comments.length > 0 ? { comments } : {}) } };
}

/** The answer to a Needs-you decision (E14-6): the key it closes (optional when one is open) and the answer text. */
function parseAnswerNeed(body: unknown): Parsed<{ id: string; key?: string; text?: string }> {
  const obj = asObject(body);
  if (obj === null) {
    return { ok: false, error: 'bad answer payload' };
  }
  const key = typeof obj['key'] === 'string' ? obj['key'].trim() : '';
  const text = typeof obj['text'] === 'string' ? obj['text'].trim() : '';
  if (key === '' && text === '') {
    return { ok: false, error: 'an answer needs a key or a text' };
  }
  return { ok: true, value: { id: (obj as { id: string }).id, ...(key === '' ? {} : { key }), ...(text === '' ? {} : { text: text.slice(0, 4000) }) } };
}

/** One owner message into a persona's coaching thread (U4, concept §4.5). */
function parseThreadSend(body: unknown): Parsed<{ text: string }> {
  const obj = asObject(body);
  const text = typeof obj?.['text'] === 'string' ? obj['text'].trim() : '';
  if (obj === null) {
    return { ok: false, error: 'bad thread message payload' };
  }
  if (text === '') {
    return { ok: false, error: 'a thread message needs text' };
  }
  return { ok: true, value: { text } };
}

/** One owner-taught memory entry (U4, concept §4.4). */
function parseMemoryAppend(body: unknown): Parsed<{ text: string }> {
  const obj = asObject(body);
  const text = typeof obj?.['text'] === 'string' ? obj['text'].trim() : '';
  if (obj === null) {
    return { ok: false, error: 'bad memory entry payload' };
  }
  if (text === '') {
    return { ok: false, error: 'a memory entry needs text' };
  }
  return { ok: true, value: { text } };
}

/** The pin toggle: one entry's index in the GET list, and the wanted state. */
function parseMemoryPin(body: unknown): Parsed<{ index: number; pinned: boolean }> {
  const obj = asObject(body);
  const index = obj?.['index'];
  const pinned = obj?.['pinned'];
  if (obj === null || typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return { ok: false, error: 'the pin needs the entry index (a 0-based integer)' };
  }
  if (typeof pinned !== 'boolean') {
    return { ok: false, error: 'the pin needs pinned: true or false' };
  }
  return { ok: true, value: { index, pinned } };
}

/** The persona PATCH's writable keys (U4, concept §4.5) — only sent keys are written. */
export interface PersonaPatchInput {
  title?: string;
  role?: string;
  worker?: string;
  model?: string;
  pool?: string[];
  router?: PersonaRouter;
  color?: string;
  skills?: string[];
  prompt?: string;
}

const PERSONA_PATCH_KEYS: readonly (keyof PersonaPatchInput)[] = [
  'title',
  'role',
  'worker',
  'model',
  'pool',
  'router',
  'color',
  'skills',
  'prompt',
];

function parsePersonaPatch(body: unknown): Parsed<PersonaPatchInput> {
  const obj = asObject(body);
  if (obj === null) {
    return { ok: false, error: 'bad persona patch payload' };
  }
  const out: PersonaPatchInput = {};
  let any = false;
  for (const key of PERSONA_PATCH_KEYS) {
    const value = obj[key];
    if (value === undefined) {
      continue;
    }
    if (key === 'pool' || key === 'skills') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return { ok: false, error: `${key} is a list of names` };
      }
      out[key] = value.map((v) => (v as string).trim());
    } else if (typeof value !== 'string') {
      return { ok: false, error: `${key} is a string` };
    } else if (key === 'router') {
      out[key] = value as PersonaRouter;
    } else {
      out[key] = value;
    }
    any = true;
  }
  if (!any) {
    return { ok: false, error: `the patch carries none of the writable keys: ${PERSONA_PATCH_KEYS.join(', ')}` };
  }
  return { ok: true, value: out };
}

/** The chain's persona pause (U4): which persona, and whether it is paused. */
function parseChainPersonaPause(body: unknown): Parsed<{ persona: string; paused: boolean }> {
  const obj = asObject(body);
  const persona = typeof obj?.['persona'] === 'string' ? obj['persona'].trim() : '';
  const paused = obj?.['paused'];
  if (obj === null || persona === '') {
    return { ok: false, error: 'the persona pause needs a persona id' };
  }
  if (typeof paused !== 'boolean') {
    return { ok: false, error: 'the paused flag is true or false' };
  }
  return { ok: true, value: { persona, paused } };
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
  if ((req.method === 'POST' || req.method === 'PATCH') && !originAllowed(req.origin, deps.allowedHosts())) {
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
  if ((req.method === 'POST' || req.method === 'PATCH') && device.readOnly) {
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
      case '/api/settings':
        return deps.settings === undefined ? fail(404, 'no such route') : json(await deps.settings.read(device.id));
      case '/api/pairing':
        // The waiting code is a credential: a read-only device may not even look at it.
        if (device.readOnly) {
          return fail(403, 'this device is paired read-only');
        }
        return deps.pairingAccess === undefined ? fail(404, 'no such route') : json(deps.pairingAccess.current());
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
    // U4: the persona chat and memory reads; the persona id is pinned by
    // the personaRef grammar before it reaches the port.
    const thread = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})\/thread$/.exec(req.path);
    if (thread !== null) {
      return json(await port.personaThread(thread[1]!));
    }
    const memory = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})\/memory$/.exec(req.path);
    if (memory !== null) {
      return json(await port.personaMemory(memory[1]!));
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
    const planStatus = /^\/api\/tickets\/([^/]+)\/plan$/.exec(req.path);
    if (planStatus !== null) {
      const id = decodeURIComponent(planStatus[1]!);
      return TICKET_ID_PATTERN.test(id) ? json(await port.planStatus(id)) : fail(404, 'no such ticket id');
    }
    const parts = /^\/api\/tickets\/([^/]+)\/parts$/.exec(req.path);
    if (parts !== null) {
      const id = decodeURIComponent(parts[1]!);
      return TICKET_ID_PATTERN.test(id) ? json(await port.planParts(id)) : fail(404, 'no such ticket id');
    }
    const flow = /^\/api\/tickets\/([^/]+)\/flow(?:\/(\d{1,3}))?$/.exec(req.path);
    if (flow !== null) {
      const id = decodeURIComponent(flow[1]!);
      return TICKET_ID_PATTERN.test(id) ? json(await port.flow({ id, part: flow[2] === undefined ? null : Number(flow[2]) })) : fail(404, 'no such ticket id');
    }
    const estimate = /^\/api\/estimate\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(req.path);
    if (estimate !== null) {
      const [gate, persona, model] = [1, 2, 3].map((i) => decodeURIComponent(estimate[i]!));
      return json({ ok: true, estimate: await port.estimate({ gate: gate!, persona: persona!, model: model! }) });
    }
    const file = /^\/api\/tickets\/([^/]+)\/file\/(.+)$/.exec(req.path);
    if (file !== null) {
      const id = decodeURIComponent(file[1]!);
      if (!TICKET_ID_PATTERN.test(id)) {
        return fail(404, 'no such ticket id');
      }
      const reply = await port.ticketFile(id, decodeURIComponent(file[2]!));
      return reply.ok ? json(reply) : fail(404, reply.error);
    }
    const chatSession = /^\/api\/chat\/sessions\/(.+)$/.exec(req.path);
    if (chatSession !== null) {
      const file = decodeURIComponent(chatSession[1]!);
      return CHAT_FILE_PATTERN.test(file) ? json(await port.chatOpen(file)) : fail(404, 'no such chat session');
    }
    return fail(404, 'no such route');
  }

  if (req.method === 'PATCH') {
    // U4: the persona setup's PATCH — the only PATCH route; the path pins
    // the persona id, the body carries only the keys being written.
    const persona = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})$/.exec(req.path);
    if (persona !== null) {
      return write(`persona patch ${persona[1]}`, parsePersonaPatch(body), (value) =>
        port.personaPatch({ persona: persona[1]!, ...value }));
    }
    return fail(405, 'only GET, POST and PATCH are served');
  }
  if (req.method !== 'POST') {
    return fail(405, 'only GET, POST and PATCH are served');
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
  const ticket = /^\/api\/tickets\/([^/]+)\/(move|claim|archive|refine|save|accept|send-back|answer|parts|release|flow-edit|flow-save|flow-draft)$/.exec(req.path);
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
      case 'answer':
        return write(`answer ${id}`, parseAnswerNeed(withId), (cmd) => port.ticketAnswerNeed(cmd, actor));
      case 'parts':
        return write(`parts ${id}`, parsePlanPartsEdit(withId), (cmd) => port.planPartsEdit(cmd, actor));
      case 'release':
        return write(`release ${id}`, parsePlanRelease(withId), (cmd) => port.planRelease(cmd, actor));
      case 'flow-edit':
        return write(`flow-edit ${id}`, parseFlowEdit(withId), (cmd) => port.flowEdit(cmd));
      case 'flow-save':
        return write(`flow-save ${id}`, parseFlowSave(withId), (cmd) => port.flowSave(cmd, actor));
      case 'flow-draft':
        return write(`flow-draft ${id}`, parseFlowDraft(withId), (cmd) => port.flowDraft(cmd));
      default:
        return write(`archive ${id}`, { ok: true, value: { id } }, (cmd) => port.archive(cmd, actor));
    }
  }
  if (req.path === '/api/runs') {
    return write('run start', parseStartRun(body), (cmd) => port.startRun(cmd));
  }
  const run = /^\/api\/runs\/([A-Za-z0-9_.-]+)\/(stop|send|answer|permission|handoff)$/.exec(req.path);
  if (run !== null) {
    const withRun = { ...(body as object), runId: run[1]! };
    switch (run[2]) {
      case 'stop':
        return write(`stop ${run[1]}`, parseStopRun(withRun), (cmd) => port.stopRun(cmd));
      case 'handoff':
        return write(`hand off ${run[1]}`, { ok: true, value: { runId: run[1]! } }, (cmd) => port.handoffRun(cmd));
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

  // E10-3: the owner's tap on Paul's split proposal — keep as one ticket or split.
  const shapeDecision = /^\/api\/chat\/sessions\/(.+)\/split\/(keep|split)$/.exec(req.path);
  if (shapeDecision !== null) {
    const file = decodeURIComponent(shapeDecision[1]!);
    if (!CHAT_FILE_PATTERN.test(file)) {
      return fail(404, 'no such chat session');
    }
    return write(
      `shape ${shapeDecision[2]}`,
      { ok: true, value: { file, choice: shapeDecision[2] as 'keep' | 'split' } },
      (cmd) => port.chatShapeDecide(cmd),
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

  // U4: the persona chat's append, the memory's append and pin toggle —
  // the id pinned by the personaRef grammar in the path.
  const thread = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})\/thread$/.exec(req.path);
  if (thread !== null) {
    const id = thread[1]!;
    return write(`persona ${id} thread`, parseThreadSend(body), (value) => port.personaThreadAppend({ persona: id, text: value.text }));
  }
  const memoryPin = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})\/memory\/pin$/.exec(req.path);
  if (memoryPin !== null) {
    const id = memoryPin[1]!;
    return write(`persona ${id} memory pin`, parseMemoryPin(body), (value) => port.personaMemoryPin({ persona: id, ...value }));
  }
  const memory = /^\/api\/personas\/([a-z0-9][a-z0-9-]{0,63})\/memory$/.exec(req.path);
  if (memory !== null) {
    const id = memory[1]!;
    return write(`persona ${id} memory`, parseMemoryAppend(body), (value) => port.personaMemoryAppend({ persona: id, text: value.text }));
  }

  // D-2: a paired, not read-only device starts or cancels the one waiting
  // pairing (the read-only refusal happened above for every POST). The
  // code still only pairs through POST /api/pair, once, within its TTL.
  if ((req.path === '/api/pairing/start' || req.path === '/api/pairing/cancel') && deps.pairingAccess !== undefined) {
    const access = deps.pairingAccess;
    if (req.path === '/api/pairing/cancel') {
      deps.log(`remote ${device.name} (${device.id}): pairing cancelled`);
      return json(access.cancel());
    }
    const parsed = parsePairingStart(body);
    if (!parsed.ok) {
      return json(parsed);
    }
    deps.log(
      `remote ${device.name} (${device.id}): pairing started for "${parsed.value.name}"${parsed.value.readOnly ? ' (read-only)' : ''}`,
    );
    return json(access.start(parsed.value.name, parsed.value.readOnly));
  }

  if (req.path === '/api/settings/chat/test' && deps.settings !== undefined) {
    deps.log(`remote ${device.name}: settings chat test`);
    return json(await deps.settings.testChat());
  }
  if ((req.path === '/api/settings/engine' || req.path === '/api/settings/devices/revoke') && deps.settings !== undefined) {
    const settings = deps.settings;
    if (req.path === '/api/settings/engine') {
      return write('settings engine', parseSettingsPatch(body), (value) => settings.patch(value, device.id));
    }
    return write('settings device revoke', parseRevoke(body), (value) => settings.revoke(value.id, device.id));
  }

  switch (req.path) {
    case '/api/chain/master':
      return write('chain master', parseChainMaster(body), (cmd) => port.chainMaster(cmd.mode));
    case '/api/chain/column':
      return write('chain column', parseChainColumn(body), (cmd) => port.chainColumn(cmd.phase, cmd.mode));
    case '/api/chain/column-stop':
      return write('chain column stop', parseChainColumnStop(body), (cmd) => port.chainColumnStop(cmd.phase));
    case '/api/chain/persona-pause':
      return write('chain persona pause', parseChainPersonaPause(body), (cmd) => port.chainPersonaPause(cmd));
    case '/api/chain/abort':
      return write('chain abort', { ok: true, value: null }, () => port.chainAbort());
  }
  return fail(404, 'no such route');
}

function viewOf(device: RemoteDevice): DeviceView {
  const { tokenHash: _hash, ...view } = device;
  return view;
}
