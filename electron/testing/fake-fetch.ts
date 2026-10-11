/**
 * A scripted stand-in for the global `fetch`, for the main-process specs
 * that talk HTTP (the LLM providers). Replies are handed out in order; every
 * request is recorded so a spec can assert on what actually went out.
 *
 * Spec-only: nothing in the app imports this.
 */
import { vi } from 'vitest';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The parsed JSON body, or null for a request without one. */
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

/** One scripted reply: a ready `Response`, or an error `fetch` rejects with. */
export type ScriptedReply = Response | Error;

export function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function textReply(text: string, status = 200): Response {
  return new Response(text, { status });
}

/**
 * A streamed reply delivered in exactly the given pieces, so a spec decides
 * where the network happens to cut the SSE frames.
 */
export function streamReply(pieces: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export interface FakeFetch {
  requests: RecordedRequest[];
  /** Restores the real `fetch`. */
  restore(): void;
}

/** Installs the fake; a request beyond the scripted replies fails the test. */
export function installFakeFetch(replies: readonly ScriptedReply[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];
  vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    requests.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      signal: init.signal ?? null,
    });
    const reply = queue.shift();
    if (reply === undefined) {
      return Promise.reject(new Error(`Unexpected request #${requests.length} to ${String(input)}`));
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  return { requests, restore: () => vi.unstubAllGlobals() };
}
