/**
 * The plan status of the tickets whose documents are open (E13-9): what
 * the marks under the `## Plan` heading read. The engine answers per
 * ticket; the store asks again when the buffer's text changed (the owner's
 * unsaved edits count, so the text rides along) or when a turn ended, and
 * tells its listeners when an answer differs.
 */
import { isPlanStatus, type PlanStatusLike } from './shape';

export interface PlanStatusStore {
  /** The last usable answer for a ticket, or null. */
  get(id: string): PlanStatusLike | null;
  /** Asks (soon) for the status of `id`, marking the given buffer text; the same text twice asks once. */
  want(id: string, text: string): void;
  /** Asks again at once, whatever was asked before (a turn ended). */
  refresh(id: string): void;
  subscribe(listener: () => void): () => void;
}

export interface PlanStatusDeps {
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
  /** The wait before an edit is asked about; specs pass 0. */
  readonly delayMs?: number;
}

export function createPlanStatusStore(deps: PlanStatusDeps): PlanStatusStore {
  const answers = new Map<string, PlanStatusLike | null>();
  const askedText = new Map<string, string>();
  const latestText = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const ask = (id: string): void => {
    const text = latestText.get(id);
    askedText.set(id, text ?? '');
    void deps
      .invoke('mcPlanStatus', text === undefined ? { ticket: id } : { ticket: id, text })
      .then((reply) => {
        const next = isPlanStatus(reply) ? reply : null;
        if (JSON.stringify(next) !== JSON.stringify(answers.get(id) ?? null)) {
          answers.set(id, next);
          notify();
        }
      })
      .catch(() => undefined);
  };

  return {
    get: (id) => answers.get(id) ?? null,
    want: (id, text) => {
      latestText.set(id, text);
      if (askedText.get(id) === text || timers.has(id)) {
        return;
      }
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          ask(id);
        }, deps.delayMs ?? 500),
      );
    },
    refresh: (id) => {
      const timer = timers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(id);
      }
      ask(id);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
