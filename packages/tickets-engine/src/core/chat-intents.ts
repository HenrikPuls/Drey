/**
 * The chat intent envelope's pure helpers (E5a, ADR-0088 later change).
 * The LLM answers a mission turn with one strict JSON envelope; this
 * module validates it — never a guess, invalid commands drop out
 * visibly (the house parse discipline: hand-rolled shape checks, no
 * schema library). The chat proposes only what the board already does;
 * the union in contracts/chat.ts is the entire write surface.
 */
import { TICKET_PRIORITIES, type TicketPriority } from '../contracts/tickets';
import type { ChatCommand } from '../contracts/chat';

/** The parsed envelope — what a mission turn amounted to. */
export interface ChatEnvelope {
  /** The mission's spoken reply; '' when the envelope carries only commands. */
  readonly say: string;
  /** The thinking trace for the stream; null when absent. */
  readonly thought: string | null;
  /** The validated commands (proposal cards), in order. */
  readonly commands: readonly ChatCommand[];
}

/**
 * Reads the envelope from the model's reply. Returns null when the text
 * holds no JSON object at all — the caller then answers with an honest
 * fallback instead of guessing. Commands that fail validation are
 * dropped; a say line mentioning them keeps the owner informed.
 */
export function parseEnvelope(reply: string): ChatEnvelope | null {
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
      const command = validateChatCommand(entry);
      if (command !== null) {
        commands.push(command);
      }
    }
  }
  return { say, thought, commands };
}

/**
 * The one validator every command passes — the session reader reuses
 * it, so a hand-edited command block reads exactly like a model's.
 * Unknown kinds, wrong field types and bad priorities refuse to null.
 */
export function validateChatCommand(raw: unknown): ChatCommand | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  if (kind === 'createTicket') {
    const title = textOf(obj['title']);
    const phase = textOf(obj['phase']);
    const priority = priorityOf(obj['priority']);
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
    const priority = priorityOf(obj['priority']);
    if (id === null || priority === null) {
      return null;
    }
    return { kind: 'setPriority', id, priority };
  }
  return null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function ticketIdOf(value: unknown): string | null {
  const text = textOf(value);
  return text !== null && /^T-\d{4,}$/.test(text) ? text : null;
}

function priorityOf(value: unknown): TicketPriority | null {
  return typeof value === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(value)
    ? (value as TicketPriority)
    : null;
}
