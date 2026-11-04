/**
 * The board's command layer (req-66, ADR-0086): one parser per command
 * that turns an untrusted payload into a typed request or a refusal.
 * The IPC handlers and the remote gateway's routes both call these, so
 * the two transports can never validate differently. Pure — no I/O.
 */
import {
  questionAnswersOf,
  type ChainMaster,
  type ColumnMode,
  type HandoverMode,
  type InteractiveMode,
  type PermissionDecision,
  type PermissionMode,
  type QuestionAnswers,
} from '../fleet/protocol';
import type { PlanPartsEdit, PlanReleaseScope } from '../contracts/plan-approval';
import { DEFAULT_PRIORITY_CONFIG, titleFromDescription, type PriorityConfig, type TicketPriority, type TicketTrack } from '../contracts/tickets';

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function refuse<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function record(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
}

export interface CreateCommand {
  readonly title: string;
  readonly priority: TicketPriority;
  /** The primary work repo. */
  readonly repo: string | null;
  /** Every work repo, primary first (req-72); absent = just the primary. */
  readonly repos?: readonly string[];
  readonly description: string;
  /** The owner's raw words a tidied create came from (req-75 W5c);
   *  present only when tidy-up changed the fields. */
  readonly raw?: string;
}

/**
 * Parses a create payload. `priorities` is the board's configured
 * vocabulary (the snapshot's `priorities`): a priority outside it is not
 * refused but falls back to the vocabulary's default, exactly as the
 * shipped parser fell back to `normal` — the board's own validation
 * still guards the write.
 */
export function parseCreate(payload: unknown, priorities: PriorityConfig = DEFAULT_PRIORITY_CONFIG): Parsed<CreateCommand> {
  const p = record(payload);
  const given = typeof p['title'] === 'string' ? p['title'].trim() : '';
  const description = typeof p['description'] === 'string' ? p['description'] : '';
  // An empty title is no longer refused when the description carries one:
  // its first line becomes the title (req-75 W5b — a dictated description
  // alone is enough). Both empty still refuse.
  const title = given !== '' ? given : titleFromDescription(description);
  if (title === '') {
    return refuse('the title is empty');
  }
  const priority = priorities.order.includes(p['priority'] as TicketPriority)
    ? (p['priority'] as TicketPriority)
    : priorities.default;
  const repo = typeof p['repo'] === 'string' && p['repo'].trim() !== '' ? p['repo'].trim() : null;
  const repos = p['repos'];
  // The raw words travel with a tidied create (req-75 W5c) — kept
  // only when a non-empty string, dropped otherwise.
  const raw = typeof p['raw'] === 'string' && p['raw'].trim() !== '' ? p['raw'] : undefined;
  return ok({
    title,
    priority,
    repo,
    ...(Array.isArray(repos) && repos.every((r): r is string => typeof r === 'string') ? { repos } : {}),
    description,
    ...(raw !== undefined ? { raw } : {}),
  });
}

export interface TransitionCommand {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** A move between phases. An `index` in the payload (an older remote
 *  client's drop position) is ignored — there are no pins (req-75). */
export function parseTransition(payload: unknown): Parsed<TransitionCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string' || typeof p['from'] !== 'string' || typeof p['to'] !== 'string') {
    return refuse('bad transition payload');
  }
  return ok({ id: p['id'], from: p['from'], to: p['to'] });
}

export interface TicketIdCommand {
  readonly id: string;
}

/** The commands that name one ticket and nothing else (`archive`). */
export function parseTicketId(payload: unknown, what: string): Parsed<TicketIdCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string') {
    return refuse(`bad ${what} payload`);
  }
  return ok({ id: p['id'] });
}

export interface ClaimCommand {
  readonly id: string;
  readonly mode: 'takeover' | 'release';
}

export function parseClaim(payload: unknown): Parsed<ClaimCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string' || (p['mode'] !== 'takeover' && p['mode'] !== 'release')) {
    return refuse('bad claim payload');
  }
  return ok({ id: p['id'], mode: p['mode'] });
}

/** The Work row menu's triage pick (req-75 W1b): `auto`, `shape`, or null (not triaged). */
export interface SetTrackCommand {
  readonly id: string;
  readonly track: TicketTrack | null;
}

export function parseSetTrack(payload: unknown): Parsed<SetTrackCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string') {
    return refuse('bad track payload');
  }
  const track = p['track'];
  if (track !== null && track !== 'auto' && track !== 'shape') {
    return refuse('track must be auto, shape or null');
  }
  return ok({ id: p['id'], track });
}

export interface UnarchiveCommand {
  readonly id: string;
  readonly to: string;
}

export function parseUnarchive(payload: unknown): Parsed<UnarchiveCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string' || typeof p['to'] !== 'string') {
    return refuse('bad unarchive payload');
  }
  return ok({ id: p['id'], to: p['to'] });
}

/** The Ready card's "Send back…" (req-75 W3): one ticket, one note. */
export interface SendBackCommand {
  readonly id: string;
  /** Trimmed, at most 500 characters — the Log line's budget. */
  readonly note: string;
}

export function parseSendBack(payload: unknown): Parsed<SendBackCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string') {
    return refuse('bad send back payload');
  }
  const note = typeof p['note'] === 'string' ? p['note'].trim() : '';
  if (note === '') {
    return refuse('the send-back note is empty');
  }
  return ok({ id: p['id'], note: note.slice(0, 500) });
}

export interface PlanPartsEditCommand {
  readonly id: string;
  readonly edit: PlanPartsEdit;
}

const PERSONA_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The plan to approve's list edit (E10-4): `{op:'persona', index, persona|null}`, `{op:'move', from, to}`, `{op:'delete', index}`. */
export function parsePlanPartsEdit(payload: unknown): Parsed<PlanPartsEditCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string') {
    return refuse('bad parts payload');
  }
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 200 ? v : null);
  switch (p['op']) {
    case 'persona': {
      const index = int(p['index']);
      const persona = p['persona'];
      if (index === null || (persona !== null && (typeof persona !== 'string' || !PERSONA_ID.test(persona)))) {
        return refuse('bad persona edit');
      }
      return ok({ id: p['id'], edit: { op: 'persona', index, persona: persona as string | null } });
    }
    case 'move': {
      const from = int(p['from']);
      const to = int(p['to']);
      return from === null || to === null ? refuse('bad move') : ok({ id: p['id'], edit: { op: 'move', from, to } });
    }
    case 'delete': {
      const index = int(p['index']);
      return index === null ? refuse('bad delete') : ok({ id: p['id'], edit: { op: 'delete', index } });
    }
    default:
      return refuse('parts op must be persona, move or delete');
  }
}

export interface PlanReleaseCommand {
  readonly id: string;
  readonly scope: PlanReleaseScope;
}

/** The approval (E10-4): `scope` is `all` (the default) or `first`. */
export function parsePlanRelease(payload: unknown): Parsed<PlanReleaseCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string') {
    return refuse('bad release payload');
  }
  const scope = p['scope'] ?? 'all';
  return scope === 'all' || scope === 'first' ? ok({ id: p['id'], scope }) : refuse('release scope must be all or first');
}

export interface StartRunCommand {
  readonly ticketId: string;
  readonly workerChoice: string | null;
  readonly permissionMode: PermissionMode;
  readonly handover: HandoverMode | 'auto' | null;
  /** The owner drives the run as an interactive dialog (req-65); null = a normal run. */
  readonly interactive: InteractiveMode | null;
}

export function parseStartRun(payload: unknown): Parsed<StartRunCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string') {
    return refuse('bad fleet start payload');
  }
  const h = p['handover'];
  const handover = h === 'fresh' || h === 'resume' || h === 'resume-compact' || h === 'auto' ? h : null;
  const worker = p['worker'];
  const i = p['interactive'];
  return ok({
    ticketId: p['id'],
    workerChoice: typeof worker === 'string' && worker.trim() !== '' ? worker.trim() : null,
    permissionMode: p['permissionMode'] === 'bypass' ? 'bypass' : 'accept-edits',
    handover,
    interactive: i === 'plan' || i === 'refine' ? i : null,
  });
}

export interface StopRunCommand {
  readonly runId: string;
  readonly reason: string | null;
}

export function parseStopRun(payload: unknown): Parsed<StopRunCommand> {
  const p = record(payload);
  if (typeof p['runId'] !== 'string') {
    return refuse('bad fleet stop payload');
  }
  const reason = p['reason'];
  return ok({
    runId: p['runId'],
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
  });
}

export interface SendCommand {
  readonly runId: string;
  readonly text: string;
}

export function parseSend(payload: unknown): Parsed<SendCommand> {
  const p = record(payload);
  if (typeof p['runId'] !== 'string' || typeof p['text'] !== 'string' || p['text'].trim() === '') {
    return refuse('bad fleet send payload');
  }
  return ok({ runId: p['runId'], text: p['text'].trim() });
}

export interface PermissionCommand {
  readonly runId: string;
  readonly decision: PermissionDecision;
}

export function parsePermission(payload: unknown): Parsed<PermissionCommand> {
  const p = record(payload);
  const d = p['decision'];
  if (typeof p['runId'] !== 'string' || (d !== 'once' && d !== 'always' && d !== 'reject')) {
    return refuse('bad fleet permission payload');
  }
  return ok({ runId: p['runId'], decision: d });
}

export interface AnswerCommand {
  readonly runId: string;
  readonly answers: QuestionAnswers;
}

export function parseAnswer(payload: unknown): Parsed<AnswerCommand> {
  const p = record(payload);
  const answers = questionAnswersOf(p['answers']);
  if (typeof p['runId'] !== 'string' || answers === null) {
    return refuse('bad fleet answer payload');
  }
  return ok({ runId: p['runId'], answers });
}

export function parseChainMaster(payload: unknown): Parsed<{ readonly mode: ChainMaster }> {
  const mode = record(payload)['mode'];
  if (mode !== 'run' && mode !== 'halted') {
    return refuse('the master mode is "run" or "halted"');
  }
  return ok({ mode });
}

export function parseChainColumn(payload: unknown): Parsed<{ readonly phase: string; readonly mode: ColumnMode }> {
  const p = record(payload);
  if (typeof p['phase'] !== 'string' || (p['mode'] !== 'playing' && p['mode'] !== 'held')) {
    return refuse('bad chain column payload');
  }
  return ok({ phase: p['phase'], mode: p['mode'] });
}

export function parseChainColumnStop(payload: unknown): Parsed<{ readonly phase: string }> {
  const p = record(payload);
  if (typeof p['phase'] !== 'string') {
    return refuse('bad chain column payload');
  }
  return ok({ phase: p['phase'] });
}

/** An image a paired device uploads (req-66 R8): the decoded bytes and
 * the extension derived from what the bytes are — never from a name
 * the client sent. */
export interface AttachmentCommand {
  readonly bytes: Buffer;
  readonly ext: 'png' | 'jpeg' | 'gif' | 'webp';
}

/** The longest image the desk accepts (the gateway's body cap sits above it). */
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;

const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/;

function sniffImage(bytes: Buffer): AttachmentCommand['ext'] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'gif';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  return null;
}

export function parseAttachment(payload: unknown): Parsed<AttachmentCommand> {
  const data = record(payload)['dataBase64'];
  if (typeof data !== 'string' || data === '' || data.length % 4 === 1 || !BASE64_STRICT.test(data)) {
    return refuse('the image data is missing or not base64');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return refuse('the image is larger than 6 MB');
  }
  const ext = sniffImage(bytes);
  return ext === null ? refuse('the file is not a PNG, JPEG, GIF or WebP image') : ok({ bytes, ext });
}

/** The chain controls' one reply shape: the new status, or "not running". */
export function chainResult<S>(
  status: S | null,
): { readonly ok: true; readonly status: S } | { readonly ok: false; readonly error: string } {
  return status === null ? { ok: false, error: 'the fleet runner is not running' } : { ok: true, status };
}

/** The longest section text a refine accepts (a ticket, not a novel). */
export const MAX_SECTION_CHARS = 20_000;

export interface RefineCommand {
  readonly id: string;
  /** The revision the device read (`revisionOf`); a changed file refuses. */
  readonly baseRevision: string;
  readonly sections: Partial<Record<'description' | 'plan' | 'acceptance', string>>;
  readonly header: { readonly title?: string; readonly priority?: TicketPriority; readonly repo?: string };
}

export function parseRefine(payload: unknown, priorities: PriorityConfig = DEFAULT_PRIORITY_CONFIG): Parsed<RefineCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string' || typeof p['baseRevision'] !== 'string' || !/^[0-9a-f]{16}$/.test(p['baseRevision'])) {
    return refuse('bad refine payload');
  }
  const rawSections = record(p['sections']);
  const sections: Partial<Record<'description' | 'plan' | 'acceptance', string>> = {};
  for (const key of ['description', 'plan', 'acceptance'] as const) {
    const value = rawSections[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.length > MAX_SECTION_CHARS) {
      return refuse(`the ${key} text is not usable`);
    }
    sections[key] = value;
  }
  const rawHeader = record(p['header']);
  const header: { title?: string; priority?: TicketPriority; repo?: string } = {};
  if (rawHeader['title'] !== undefined) {
    const title = typeof rawHeader['title'] === 'string' ? rawHeader['title'].trim() : '';
    if (title === '' || title.length > 200) {
      return refuse('the title is empty or too long');
    }
    header.title = title;
  }
  if (rawHeader['priority'] !== undefined) {
    if (!priorities.order.includes(rawHeader['priority'] as TicketPriority)) {
      return refuse('unknown priority');
    }
    header.priority = rawHeader['priority'] as TicketPriority;
  }
  if (rawHeader['repo'] !== undefined) {
    if (typeof rawHeader['repo'] !== 'string') {
      return refuse('bad repository');
    }
    header.repo = rawHeader['repo'].trim();
  }
  if (Object.keys(sections).length === 0 && Object.keys(header).length === 0) {
    return refuse('nothing to refine');
  }
  return ok({ id: p['id'], baseRevision: p['baseRevision'], sections, header });
}
