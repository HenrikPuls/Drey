/**
 * Mission Control's connection to the desk (E5b): JSON calls with the
 * device token, and the live event stream read with `fetch` (an
 * EventSource cannot send the bearer header), reconnecting with backoff
 * and at once when the document returns to visibility. Mirrors the
 * proven phone client (`plugins/tickets/remote/api.ts`, req-66).
 *
 * The fetch and the token storage are injected so the specs run under
 * Node with fakes; the token lives under the same key the legacy client
 * uses, so one pairing serves both apps.
 */
import { SseParser } from './sse';

/** The localStorage key the device token lives under (shared with the legacy client). */
export const TOKEN_KEY = 'drey.remote.token';

/** The storage seam: exactly `localStorage`'s slice the client uses. */
export interface McStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type McFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface McClientOptions {
  readonly fetch?: McFetch;
  readonly storage?: McStorage;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One event off the `/api/events` stream: the frame's name and raw data payload. */
export interface McStreamEvent {
  readonly name: string;
  readonly data: string;
}

export interface McEventHandlers {
  readonly onEvent: (event: McStreamEvent) => void;
  readonly onState: (connected: boolean) => void;
  readonly onUnauthorized: () => void;
}

export type PairReply = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly error: string };

const defaultStorage = (): McStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export class McClient {
  private readonly fetchFn: McFetch;
  private readonly store: McStorage | null;

  constructor(options: McClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((path, init) => fetch(path, init));
    this.store = options.storage ?? defaultStorage();
  }

  token(): string | null {
    try {
      return this.store?.getItem(TOKEN_KEY) ?? null;
    } catch {
      return null;
    }
  }

  setToken(token: string): boolean {
    try {
      this.store?.setItem(TOKEN_KEY, token);
      return true;
    } catch {
      return false;
    }
  }

  clearToken(): void {
    try {
      this.store?.removeItem(TOKEN_KEY);
    } catch {
      // nothing stored to clear
    }
  }

  private headers(): Record<string, string> {
    const token = this.token();
    return { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) };
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(path, {
        method,
        headers: this.headers(),
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, 'The desk does not answer.');
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message = (data as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof message === 'string' ? message : `HTTP ${res.status}`);
    }
    return data as T;
  }

  /** Exchanges a pairing code for the device token; stores it on success. */
  async pair(code: string): Promise<PairReply> {
    try {
      const data = await this.request<{ ok?: unknown; token?: unknown; error?: unknown }>('POST', '/api/pair', { code });
      if (data?.ok === true && typeof data.token === 'string' && this.setToken(data.token)) {
        return { ok: true, token: data.token };
      }
      return { ok: false, error: typeof data?.error === 'string' ? data.error : 'Pairing failed.' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Pairing failed.' };
    }
  }

  /**
   * Follows `/api/events` until stopped: parses the `event:`/`data:`
   * frames, reports the connection state, reconnects with a 1s → 30s
   * backoff, reconnects at once when the document returns to visibility,
   * and reports `onUnauthorized` (then gives up) when the desk answers
   * 401. Returns the stop function.
   */
  listen(handlers: McEventHandlers): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let wake: (() => void) | null = null;
    let delay = 1000;

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });

    const loop = async (): Promise<void> => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await this.fetchFn('/api/events', {
            headers: this.headers(),
            signal: controller.signal,
            cache: 'no-store',
          });
          if (res.status === 401) {
            handlers.onUnauthorized();
            return;
          }
          if (res.ok && res.body !== null) {
            handlers.onState(true);
            delay = 1000;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const parser = new SseParser();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) {
                break;
              }
              for (const event of parser.push(decoder.decode(value, { stream: true }))) {
                handlers.onEvent({ name: event.event, data: event.data });
              }
            }
          }
        } catch {
          // aborted or dropped — reconnect below
        }
        if (stopped) {
          return;
        }
        handlers.onState(false);
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    };

    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        delay = 1000;
        controller?.abort();
        wake?.();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    void loop();
    return () => {
      stopped = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
      controller?.abort();
      wake?.();
    };
  }
}
