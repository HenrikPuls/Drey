/**
 * Mission Control's connection to the desk (E5b, extended E5c): JSON calls
 * with the device token, the live event stream read with `fetch` (an
 * EventSource cannot send the bearer header), reconnecting with backoff
 * and at once when the document returns to visibility, the ticket
 * screen's reads — attachment bytes as object URLs and best-effort raw
 * JSON GETs — and the chat composer's uploads (`POST /api/attachments`).
 * Mirrors the proven phone client
 * (`plugins/tickets/remote/api.ts`, req-66).
 *
 * The fetch, the token storage and the object-URL factory are injected
 * so the specs run under Node with fakes; the token lives under the same
 * key the legacy client uses, so one pairing serves both apps.
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

/**
 * The object-URL seam: `attachment` hands the bytes to `createObjectUrl`
 * and the caller releases the handle through `release`. Both default to
 * the guarded `URL.createObjectURL`/`revokeObjectURL` — and to no-ops
 * where the platform has neither (the Node specs inject fakes).
 */
export type McObjectUrlFactory = (blob: Blob) => string | null;
export type McObjectUrlRevoker = (url: string) => void;

export interface McClientOptions {
  readonly fetch?: McFetch;
  readonly storage?: McStorage;
  readonly createObjectUrl?: McObjectUrlFactory;
  readonly revokeObjectUrl?: McObjectUrlRevoker;
}

/** The boot hints the URL carries: `#pair=CODE` from the desk, `#token=BEARER` from Drey itself (E5c). */
export interface McBootHints {
  /** `#pair=CODE` — the pairing code the desk shows (req-66). */
  readonly pairCode: string | null;
  /** `#token=BEARER` — Drey's embedded client lands its device token this way, no pairing. */
  readonly token: string | null;
}

const PAIR_HASH_RE = /^#pair=([A-Za-z0-9-]+)$/;
const TOKEN_HASH_RE = /^#token=([A-Za-z0-9._~+-]+={0,2})$/;

/** The largest upload the desk accepts decoded — its own cap, mirrored for a fail-fast refusal. */
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/** Standard base64 of raw bytes — chunked so a wide file does not blow the call stack. */
function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const CHUNK = 0x8000;
  for (let at = 0; at < view.length; at += CHUNK) {
    binary += String.fromCharCode(...view.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

/** Reads one location hash for the boot hints; an empty hash yields none. */
export function bootHintsFromHash(hash: string): McBootHints {
  return {
    pairCode: PAIR_HASH_RE.exec(hash)?.[1] ?? null,
    token: TOKEN_HASH_RE.exec(hash)?.[1] ?? null,
  };
}

/** The shell's boot hints from `location.hash`; none where there is no DOM. */
export function bootHintsFromLocation(): McBootHints {
  return typeof location === 'undefined' ? { pairCode: null, token: null } : bootHintsFromHash(location.hash);
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

/**
 * The attachment-upload reply (`uploadAttachments`): on success the paths
 * the desk stored (each like `tickets/attachments/img-…png`), else the
 * first refusal's sentence.
 */
export type McUploadReply =
  | { readonly ok: true; readonly stored: readonly string[] }
  | { readonly ok: false; readonly error: string };

const defaultStorage = (): McStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const defaultCreateObjectUrl: McObjectUrlFactory = (blob) => {
  try {
    return typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' ? null : URL.createObjectURL(blob);
  } catch {
    return null;
  }
};

const defaultRevokeObjectUrl: McObjectUrlRevoker = (url) => {
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  } catch {
    // the URL is already gone
  }
};

export class McClient {
  private readonly fetchFn: McFetch;
  private readonly store: McStorage | null;
  private readonly createObjectUrlFn: McObjectUrlFactory;
  private readonly revokeObjectUrlFn: McObjectUrlRevoker;

  constructor(options: McClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((path, init) => fetch(path, init));
    this.store = options.storage ?? defaultStorage();
    this.createObjectUrlFn = options.createObjectUrl ?? defaultCreateObjectUrl;
    this.revokeObjectUrlFn = options.revokeObjectUrl ?? defaultRevokeObjectUrl;
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

  /** A byte read carries no JSON content type — just the bearer when there is one. */
  private bearerHeaders(): Record<string, string> {
    const token = this.token();
    return token === null ? {} : { Authorization: `Bearer ${token}` };
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
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
   * A best-effort JSON GET: the parsed body, or null on any failure — the
   * read pattern the state slices already use (`request(...).catch(() =>
   * null)`), extracted for the ticket screen's diff/changes reads (E5c).
   */
  async raw<T>(path: string): Promise<T | null> {
    return await this.request<T>('GET', path).catch(() => null);
  }

  /**
   * One attachment's bytes (`GET /api/attachments/<name>`, bearer) as an
   * object URL; null where the platform cannot create object URLs (the
   * Node specs) — and it throws `ApiError` when the desk has no such
   * file. The caller owns the handle: `release` revokes it.
   */
  async attachment(name: string): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`/api/attachments/${encodeURIComponent(name)}`, {
        headers: this.bearerHeaders(),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(0, 'The desk does not answer.');
    }
    if (!res.ok) {
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      const message = (data as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof message === 'string' ? message : `HTTP ${res.status}`);
    }
    return this.createObjectUrlFn(await res.blob());
  }

  /** Revokes one object URL `attachment` handed out. */
  release(url: string): void {
    this.revokeObjectUrlFn(url);
  }

  /**
   * Uploads picked files to `POST /api/attachments`, one JSON request per
   * file with `{ dataBase64 }` — the body the desk's `parseAttachment`
   * reads (no multipart): strict base64 of the raw bytes; the extension
   * is derived server-side from what the bytes are, never from a name the
   * client sent. The desk stores each image under `tickets/attachments/`
   * and answers `{ ok, file }`; the first refusal — a non-image, the 6 MB
   * cap, a dead desk — stops the run and surfaces its error.
   */
  async uploadAttachments(files: File[]): Promise<McUploadReply> {
    const stored: string[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return { ok: false, error: 'the image is larger than 6 MB' };
      }
      let body: Record<string, unknown>;
      try {
        body = await this.request<Record<string, unknown>>('POST', '/api/attachments', {
          dataBase64: base64Of(await file.arrayBuffer()),
        });
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error && error.message.trim() !== '' ? error.message : 'the desk refused the upload',
        };
      }
      if (body['ok'] === true && typeof body['file'] === 'string') {
        stored.push(body['file']);
        continue;
      }
      return { ok: false, error: typeof body['error'] === 'string' ? body['error'] : 'the desk stored no attachment' };
    }
    return { ok: true, stored };
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
