/**
 * The board's command layer (req-66, ADR-0084): one parser per command
 * that turns an untrusted payload into a typed request or a refusal.
 * The IPC handlers and the remote gateway's routes both call these, so
 * the two transports can never validate differently. Pure — no I/O.
 */
import {
  questionAnswersOf,
  type ChainMaster,
  type ColumnMode,
  type HandoverMode,
  type PermissionDecision,
  type PermissionMode,
  type QuestionAnswers,
} from './fleet/protocol';
import { TICKET_PRIORITIES, type TicketPriority } from '../shared/tickets';

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
  readonly repo: string | null;
  readonly description: string;
}

export function parseCreate(payload: unknown): Parsed<CreateCommand> {
  const p = record(payload);
  const title = typeof p['title'] === 'string' ? p['title'].trim() : '';
  if (title === '') {
    return refuse('the title is empty');
  }
  const priority = TICKET_PRIORITIES.includes(p['priority'] as TicketPriority)
    ? (p['priority'] as TicketPriority)
    : 'normal';
  const repo = typeof p['repo'] === 'string' && p['repo'].trim() !== '' ? p['repo'].trim() : null;
  const description = typeof p['description'] === 'string' ? p['description'] : '';
  return ok({ title, priority, repo, description });
}

export interface TransitionCommand {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly index: number | null;
}

export function parseTransition(payload: unknown): Parsed<TransitionCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string' || typeof p['from'] !== 'string' || typeof p['to'] !== 'string') {
    return refuse('bad transition payload');
  }
  const index = p['index'];
  return ok({
    id: p['id'],
    from: p['from'],
    to: p['to'],
    index: typeof index === 'number' && index >= 0 ? Math.floor(index) : null,
  });
}

export interface ReorderCommand {
  readonly phase: string;
  readonly id: string;
  readonly index: number;
}

export function parseReorder(payload: unknown): Parsed<ReorderCommand> {
  const p = record(payload);
  if (typeof p['phase'] !== 'string' || typeof p['id'] !== 'string' || typeof p['index'] !== 'number') {
    return refuse('bad reorder payload');
  }
  return ok({ phase: p['phase'], id: p['id'], index: Math.floor(p['index']) });
}

export interface TicketIdCommand {
  readonly id: string;
}

/** The commands that name one ticket and nothing else (`unpin`, `archive`). */
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

export interface StartRunCommand {
  readonly ticketId: string;
  readonly workerChoice: string | null;
  readonly permissionMode: PermissionMode;
  readonly handover: HandoverMode | 'auto' | null;
}

export function parseStartRun(payload: unknown): Parsed<StartRunCommand> {
  const p = record(payload);
  if (typeof p['id'] !== 'string') {
    return refuse('bad fleet start payload');
  }
  const h = p['handover'];
  const handover = h === 'fresh' || h === 'resume' || h === 'resume-compact' || h === 'auto' ? h : null;
  const worker = p['worker'];
  return ok({
    ticketId: p['id'],
    workerChoice: typeof worker === 'string' && worker.trim() !== '' ? worker.trim() : null,
    permissionMode: p['permissionMode'] === 'bypass' ? 'bypass' : 'accept-edits',
    handover,
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

export function parseRefine(payload: unknown): Parsed<RefineCommand> {
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
    if (!TICKET_PRIORITIES.includes(rawHeader['priority'] as TicketPriority)) {
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
