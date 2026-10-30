/**
 * The phone client's connection to the desk (req-66): JSON calls with
 * the device token, and the live event stream read with `fetch` (an
 * EventSource cannot send the bearer header), reconnecting with backoff
 * and at once when the app comes back to the foreground.
 */
import { SseParser } from './sse';

const TOKEN_KEY = 'drey.remote.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  token(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  setToken(token: string): boolean {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      return true;
    } catch {
      return false;
    }
  }

  clearToken(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
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
      res = await fetch(path, {
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

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** Follows `/api/events` until stopped; `onState` reports the connection. */
  listen(handlers: {
    readonly onEvent: (name: string) => void;
    readonly onState: (connected: boolean) => void;
    readonly onUnauthorized: () => void;
  }): () => void {
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
          const res = await fetch('/api/events', { headers: this.headers(), signal: controller.signal, cache: 'no-store' });
          if (res.status === 401) {
            handlers.onUnauthorized();
            return;
          }
          if (res.ok && res.body !== null) {
            handlers.onState(true);
            delay = 1000;
            // A reconnect may have missed changes: catch up once.
            handlers.onEvent('board');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const parser = new SseParser();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) {
                break;
              }
              for (const event of parser.push(decoder.decode(value, { stream: true }))) {
                handlers.onEvent(event.event);
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
      if (document.visibilityState === 'visible') {
        delay = 1000;
        controller?.abort();
        wake?.();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    void loop();
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      controller?.abort();
      wake?.();
    };
  }
}
