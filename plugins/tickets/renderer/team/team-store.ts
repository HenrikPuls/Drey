/**
 * The persona directory the desk surfaces share (E13-8): one fetch of the
 * engine's `personas` (the phone's `GET /api/personas`: budget, today's
 * cost, phases, pause), refreshed on every board / fleet change but at
 * most once per `MIN_GAP_MS`, so a chatty fleet does not hammer the
 * engine. The Board's persona names and the Team tab and Capacity band
 * all read it; nothing here knows about the DOM.
 */
import type { PersonaView } from '../../shared/remote-protocol';
import type { DeskDeps } from '../desk-deps';

const MIN_GAP_MS = 4_000;

export interface TeamStore {
  personas(): readonly PersonaView[];
  /** The persona's display name; the id itself while the directory has not loaded. */
  nameOf(id: string | null): string;
  /** True once the directory arrived (an empty team is a valid answer). */
  loaded(): boolean;
  /** The last fetch failed; '' = fine. */
  error(): string;
  /** Pulls now (an action's follow-up), regardless of the gap. */
  refresh(): Promise<void>;
  /** Listens for a new directory; the store pulls while anyone listens. */
  subscribe(listener: () => void): () => void;
}

export function createTeamStore(deps: DeskDeps, now: () => number = Date.now): TeamStore {
  let personas: readonly PersonaView[] = [];
  let loaded = false;
  let error = '';
  let lastAt = 0;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;

  const pull = async (): Promise<void> => {
    if (inFlight !== null) {
      return inFlight;
    }
    lastAt = now();
    inFlight = (async () => {
      try {
        const reply = await deps.invoke('personas');
        personas = Array.isArray(reply) ? (reply as PersonaView[]) : [];
        loaded = true;
        error = '';
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        inFlight = null;
      }
      for (const listener of [...listeners]) {
        listener();
      }
    })();
    return inFlight;
  };

  const onChange = (): void => {
    if (now() - lastAt >= MIN_GAP_MS) {
      void pull();
    }
  };

  return {
    personas: () => personas,
    nameOf: (id) => {
      if (id === null || id === '') {
        return '';
      }
      return personas.find((persona) => persona.id === id)?.title ?? id;
    },
    loaded: () => loaded,
    error: () => error,
    refresh: pull,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribe = deps.subscribe(onChange);
        void pull();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
  };
}
