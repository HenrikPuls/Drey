/**
 * Test fakes for the api layer's specs (E5b): a fake desk — fetch and
 * storage — so `McClient` and `McState` run under Node with no DOM and
 * no socket. The `/api/events` stream is pushable raw SSE text.
 */

import type { McFetch, McStorage } from './client';

export class FakeStorage implements McStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The fake desk: JSON routes by `METHOD path`, plus one controllable
 * `/api/events` stream. A responder may return `{__status, __body}` to
 * answer a non-200, `{__bytes, __contentType}` to answer with raw bytes
 * (the attachment reads), or throw to answer a 500 with the error's message.
 */
export class FakeDesk {
  readonly storage = new FakeStorage();
  readonly calls: FakeCall[] = [];
  /** When set, `/api/events` answers this status instead of opening the stream. */
  eventsStatus: number | null = null;

  private readonly routes = new Map<string, (body: unknown) => unknown>();
  private events: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();

  /** Registers the JSON responder for one `METHOD path`. */
  on(method: 'GET' | 'POST', path: string, respond: (body: unknown) => unknown): void {
    this.routes.set(`${method} ${path}`, respond);
  }

  /** The recorded calls for one route, in order. */
  callsOf(method: string, path: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  /** True once the client holds an open `/api/events` stream. */
  get eventsOpen(): boolean {
    return this.events !== null;
  }

  readonly fetch: McFetch = async (path, init) => {
    const method = init?.method ?? 'GET';
    const parsed = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    this.calls.push({ method, path, body: parsed, headers: (init?.headers ?? {}) as Record<string, string> });
    if (path === '/api/events') {
      if (this.eventsStatus !== null) {
        return jsonResponse({ ok: false, error: `HTTP ${this.eventsStatus}` }, this.eventsStatus);
      }
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          this.events = c;
        },
      });
      init?.signal?.addEventListener('abort', () => {
        try {
          controller?.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // the stream is already released
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const route = this.routes.get(`${method} ${path}`);
    if (route === undefined) {
      return jsonResponse({ ok: false, error: `no route ${method} ${path}` }, 404);
    }
    try {
      const result = route(parsed) as unknown;
      if (typeof result === 'object' && result !== null && '__bytes' in result) {
        const bytes = result as { __bytes: Uint8Array<ArrayBuffer>; __contentType?: string; __status?: number };
        return new Response(bytes.__bytes, {
          status: bytes.__status ?? 200,
          headers: { 'content-type': bytes.__contentType ?? 'application/octet-stream' },
        });
      }
      if (typeof result === 'object' && result !== null && '__status' in result) {
        const special = result as { __status: number; __body: unknown };
        return jsonResponse(special.__body, special.__status);
      }
      return jsonResponse(result ?? { ok: true });
    } catch (error) {
      return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };

  /** Enqueues raw SSE text on the open `/api/events` stream. */
  pushRaw(sse: string): void {
    this.events?.enqueue(this.encoder.encode(sse));
  }

  /** One complete SSE frame. */
  pushEvent(name: string, data: unknown): void {
    this.pushRaw(`event: ${name}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  }

  /** Ends the events stream (the client reconnects). */
  endEvents(): void {
    const events = this.events;
    this.events = null;
    try {
      events?.close();
    } catch {
      // the stream is already released
    }
  }
}
