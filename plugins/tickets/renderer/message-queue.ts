/**
 * The busy worker's message queue (req-75 W4c): what the owner typed while
 * the worker was in a turn, kept until that turn ends. Pure model — the
 * composer owns the sending and the localStorage mirror.
 */

/** One message waiting for the worker's next idle turn. */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly string[];
  /** When it was queued (ISO). */
  readonly at: string;
}

/** The queue's internal, mutable shape. */
type QueueEntry = { id: string; text: string; attachments: string[]; at: string };

export interface MessageQueue {
  list(): readonly QueuedMessage[];
  add(text: string, attachments: readonly string[], nowIso: string): QueuedMessage;
  edit(id: string, text: string): void;
  remove(id: string): void;
  /** The entry to send next, or null. */
  head(): QueuedMessage | null;
  /** Serialized for storage; `restore` accepts unknown input and drops anything malformed. */
  toJSON(): string;
}

/** A run state in which the worker can still take a message (protocol's live states). */
export const LIVE_RUN_STATES: readonly string[] = ['starting', 'running', 'stopping'];

/** Whether the composer may send the head now: the run is live, standing idle and not waiting on the owner. */
export function readyToFlush(run: { state: string; turn?: 'busy' | 'idle'; waiting?: unknown | null } | null): boolean {
  return run !== null && LIVE_RUN_STATES.includes(run.state) && run.turn === 'idle' && (run.waiting ?? null) === null;
}

const isEntry = (value: unknown): value is QueuedMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    v['id'] !== '' &&
    typeof v['text'] === 'string' &&
    Array.isArray(v['attachments']) &&
    v['attachments'].every((a) => typeof a === 'string') &&
    typeof v['at'] === 'string' &&
    v['at'] !== ''
  );
};

/** Accepts a stored string or an already-parsed value; anything malformed goes, valid entries stay. */
const restoreEntries = (restore: unknown): QueueEntry[] => {
  let source: unknown = restore;
  if (typeof restore === 'string') {
    try {
      source = JSON.parse(restore) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(source)
    ? source.filter(isEntry).map((entry) => ({ ...entry, attachments: [...entry.attachments] }))
    : [];
};

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createMessageQueue(restore?: unknown): MessageQueue {
  // Mutable inside; the interface hands out read-only entries.
  const entries: QueueEntry[] = restore === undefined ? [] : restoreEntries(restore);
  return {
    list: () => [...entries],
    add: (text, attachments, nowIso) => {
      const entry = { id: newId(), text, attachments: [...attachments], at: nowIso };
      entries.push(entry);
      return entry;
    },
    edit: (id, text) => {
      const entry = entries.find((e) => e.id === id);
      if (entry !== undefined) {
        entry.text = text;
      }
    },
    remove: (id) => {
      const at = entries.findIndex((e) => e.id === id);
      if (at >= 0) {
        entries.splice(at, 1);
      }
    },
    head: () => entries[0] ?? null,
    toJSON: () => JSON.stringify(entries),
  };
}
