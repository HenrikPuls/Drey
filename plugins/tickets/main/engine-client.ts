import type { EngineBoardService } from '../../../packages/tickets-engine/src/services/board-service';
import type { FleetClient } from '../../../packages/tickets-engine/src/services/fleet-client';
import type { RemoteService } from '../../../packages/tickets-engine/src/server/service';

/**
 * The Drey plugin's client of the standalone tickets engine (ADR-0088,
 * E2b). One loopback channel: `POST /api/invoke {method, payload}` against
 * an explicit method allowlist, bearer-token only, plus the `/api/events`
 * SSE stream for live updates. The service proxies make the ~50 IPC
 * handlers read exactly as before — `board.createTicket(...)` forwards by
 * method name, so activate() keeps its shape.
 */

export interface EngineEndpoints {
  readonly invokeUrl: string;
  readonly token: string;
}

export class EngineError extends Error {}

export class EngineClient {
  constructor(private readonly endpoints: EngineEndpoints) {}

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoints.invokeUrl}/api/health`, {
        headers: { authorization: `Bearer ${this.endpoints.token}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async invoke(method: string, payload?: unknown): Promise<unknown> {
    const response = await fetch(`${this.endpoints.invokeUrl}/api/invoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.endpoints.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method, ...(payload === undefined ? {} : { payload }) }),
    });
    const body = (await response.json().catch(() => ({ ok: false, error: 'the engine returned no JSON' }))) as {
      ok?: boolean;
      value?: unknown;
      error?: string;
    };
    if (!response.ok || body.ok !== true) {
      throw new EngineError(body.error ?? `the engine answered ${response.status}`);
    }
    return body.value;
  }

  /** The engine's live-update stream (board | fleet | remote), debounced per kind. */
  onEvent(listener: (what: 'board' | 'fleet' | 'remote') => void, debounceMs = 200): () => void {
    let closed = false;
    let current: AbortController | null = null;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const fire = (what: 'board' | 'fleet' | 'remote'): void => {
      if (timers.has(what)) {
        return;
      }
      timers.set(
        what,
        setTimeout(() => {
          timers.delete(what);
          listener(what);
        }, debounceMs),
      );
    };
    const connect = async (): Promise<void> => {
      while (!closed) {
        current = new AbortController();
        try {
          const response = await fetch(`${this.endpoints.invokeUrl}/api/events`, {
            headers: { authorization: `Bearer ${this.endpoints.token}` },
            signal: current.signal,
          });
          if (!response.ok || response.body === null) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            continue;
          }
          let buffer = '';
          const decoder = new TextDecoder();
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
              for (const line of frame.split('\n')) {
                if (line.startsWith('data: ')) {
                  fire((JSON.parse(line.slice(6)) as { change: 'board' | 'fleet' | 'remote' }).change);
                }
              }
            }
          }
        } catch {
          // dropped — reconnect below
        }
        if (!closed) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    };
    void connect();
    return () => {
      closed = true;
      current?.abort();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }

  /** A proxy that forwards every method call as an invoke, typed as the real service. */
  private proxy<T extends object>(): T {
    return new Proxy(
      {},
      {
        get: (_target, prop: string | symbol) => {
          if (prop === 'then' || typeof prop !== 'string') {
            return undefined; // never look thenable
          }
          return (input?: unknown) => this.invoke(prop, input);
        },
      },
    ) as T;
  }

  board = (): EngineBoardService => this.proxy<EngineBoardService>();

  fleet = (): FleetClient => this.proxy<FleetClient>();

  remote = (): RemoteService => this.proxy<RemoteService>();
}
