/**
 * The chat intent envelope's pure helpers (E5a, ADR-0088 later change).
 * The LLM answers a mission turn with one strict JSON envelope; this
 * module validates it — never a guess, invalid commands drop out
 * visibly (the house parse discipline: hand-rolled shape checks, no
 * schema library). The chat proposes only what the board already does;
 * the union in contracts/chat.ts is the entire write surface.
 */
import {
  DEFAULT_PRIORITY_CONFIG,
  TICKET_ID_PATTERN,
  type PriorityConfig,
  type TicketPriority,
} from '../contracts/tickets';
import type { ChatCommand, ChatQuestionOption } from '../contracts/chat';

/** The parsed envelope — what a mission turn amounted to. */
export interface ChatEnvelope {
  /** The mission's spoken reply; '' when the envelope carries only commands. */
  readonly say: string;
  /** The thinking trace for the stream; null when absent. */
  readonly thought: string | null;
  /** The validated commands (proposal cards), in order. */
  readonly commands: readonly ChatCommand[];
  /** A shape turn's extra fields (E10-3); every one absent on a plain turn. */
  readonly plan?: string;
  readonly question?: { readonly text: string; readonly options: readonly ChatQuestionOption[] };
  readonly splitReason?: string;
  /** Repository paths the model wants to read before it answers. */
  readonly read?: readonly string[];
}

/** At most this many files are read per round, and this many choices a question keeps. */
export const MAX_READ_PATHS = 6;
const MAX_OPTIONS = 4;

/**
 * Reads the envelope from the model's reply. Returns null when the text
 * holds no JSON object at all — the caller then answers with an honest
 * fallback instead of guessing. Commands that fail validation are
 * dropped; a say line mentioning them keeps the owner informed.
 *
 * `priorities` is the board's configured vocabulary (the snapshot's
 * `priorities`) — priority fields validate against it, not against a
 * hard-coded list. Defaults to the shipped vocabulary, so every existing
 * caller keeps working.
 */
export function parseEnvelope(
  reply: string,
  priorities: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
): ChatEnvelope | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const say = typeof obj['say'] === 'string' ? obj['say'].trim() : '';
  const thoughtRaw = obj['thought'];
  const thought = typeof thoughtRaw === 'string' && thoughtRaw.trim() !== '' ? thoughtRaw.trim() : null;
  const commands: ChatCommand[] = [];
  if (Array.isArray(obj['commands'])) {
    for (const entry of obj['commands'] as unknown[]) {
      const command = validateChatCommand(entry, priorities);
      if (command !== null) {
        commands.push(command);
      }
    }
  }
  const plan = typeof obj['plan'] === 'string' && obj['plan'].trim() !== '' ? obj['plan'] : null;
  const question = questionOf(obj['question']);
  const splitReason = splitReasonOf(obj['split']);
  const read = readPathsOf(obj['read']);
  return {
    say,
    thought,
    commands,
    ...(plan === null ? {} : { plan }),
    ...(question === null ? {} : { question }),
    ...(splitReason === null ? {} : { splitReason }),
    ...(read.length === 0 ? {} : { read }),
  };
}

/** The shape turn's question: text plus 2–4 labelled choices (one may be `recommended`); null when unusable. */
function questionOf(value: unknown): { readonly text: string; readonly options: readonly ChatQuestionOption[] } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const text = textOf(obj['text']);
  if (text === null || !Array.isArray(obj['options'])) {
    return null;
  }
  const options: ChatQuestionOption[] = [];
  for (const entry of obj['options'] as unknown[]) {
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null;
    const label = typeof entry === 'string' ? textOf(entry) : record === null ? null : textOf(record['label']);
    if (label === null || options.some((o) => o.label === label)) {
      continue;
    }
    const recommended = record !== null && record['recommended'] === true && !options.some((o) => o.recommended);
    options.push({ label, recommended });
  }
  return options.length < 2 ? null : { text, options: options.slice(0, MAX_OPTIONS) };
}

/** `{"split": {"reason": "…"}}` — Paul is ready to settle; the reason is required. */
function splitReasonOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return textOf((value as Record<string, unknown>)['reason']);
}

function readPathsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of value as unknown[]) {
    const path = typeof entry === 'string' ? entry.trim() : '';
    if (path !== '' && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths.slice(0, MAX_READ_PATHS);
}

/**
 * The one validator every command passes — the session reader reuses
 * it, so a hand-edited command block reads exactly like a model's.
 * Unknown kinds, wrong field types and bad priorities refuse to null.
 * `priorities` names the vocabulary priority fields must come from.
 */
export function validateChatCommand(
  raw: unknown,
  priorities: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
): ChatCommand | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  if (kind === 'createTicket') {
    const title = textOf(obj['title']);
    const phase = textOf(obj['phase']);
    const priority = priorityOf(obj['priority'], priorities);
    if (title === null || phase === null || priority === null) {
      return null;
    }
    return {
      kind: 'createTicket',
      title,
      description: textOf(obj['description']) ?? '',
      priority,
      phase,
    };
  }
  if (kind === 'transition') {
    const id = ticketIdOf(obj['id']);
    const from = textOf(obj['from']);
    const to = textOf(obj['to']);
    if (id === null || from === null || to === null) {
      return null;
    }
    return { kind: 'transition', id, from, to };
  }
  if (kind === 'setPriority') {
    const id = ticketIdOf(obj['id']);
    const priority = priorityOf(obj['priority'], priorities);
    if (id === null || priority === null) {
      return null;
    }
    return { kind: 'setPriority', id, priority };
  }
  if (kind === 'promote') {
    const id = ticketIdOf(obj['id']);
    if (id === null) {
      return null;
    }
    return { kind: 'promote', id };
  }
  if (kind === 'setChain') {
    const id = ticketIdOf(obj['id']);
    const chain = chainOf(obj['chain']);
    if (id === null || chain === null) {
      return null;
    }
    return { kind: 'setChain', id, chain };
  }
  if (kind === 'setBlockedBy') {
    const id = ticketIdOf(obj['id']);
    const blockedBy = blockersOf(obj['blockedBy']);
    if (id === null || blockedBy === null) {
      return null;
    }
    return { kind: 'setBlockedBy', id, blockedBy };
  }
  return null;
}

/** The setChain payload's shape check: a list of non-empty strings (the
 *  grammar and the pipeline semantics validate at execution). */
function chainOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const chain: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return null;
    }
    chain.push(entry.trim());
  }
  return chain;
}

/**
 * The setBlockedBy payload's shape check (T-0050): a list of ticket ids
 * against the id grammar; an empty list is legal — it clears the
 * blockers. Existence on the board is NOT checked here (an unknown id is
 * the dependency pass's honest no-blocker), only the shape is.
 */
function blockersOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !TICKET_ID_PATTERN.test(entry.trim())) {
      return null;
    }
    ids.push(entry.trim());
  }
  return ids;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function ticketIdOf(value: unknown): string | null {
  const text = textOf(value);
  return text !== null && /^T-\d{4,}$/.test(text) ? text : null;
}

function priorityOf(value: unknown, priorities: PriorityConfig): TicketPriority | null {
  return typeof value === 'string' && (priorities.order as readonly string[]).includes(value)
    ? (value as TicketPriority)
    : null;
}
