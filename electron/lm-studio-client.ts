/**
 * Thin HTTP client for the local OpenAI-compatible LLM server
 * (`specs/roadmap.md` "Tech Stack"). LM Studio is the documented default,
 * hence the class name, but nothing here is LM-Studio-specific: the same
 * two endpoints and the same `Authorization: Bearer` convention drive
 * Unsloth Desktop (`sk-unsloth-…` keys, `http://127.0.0.1:8888/v1`),
 * llama.cpp, vLLM and Ollama. LM Studio simply ignores the auth header;
 * Unsloth rejects **both** `GET /models` and `POST /chat/completions`
 * without it.
 *
 * No model id is ever hard-coded -- the one in use comes from
 * `AppConfigStore` (`llm.model`), which the Settings screen fills from a
 * live `GET /models` or lets the user type (CLAUDE.md: "never assume a
 * specific model is loaded").
 *
 * `electron/`-only; the request/reply shaping lives in `shared/llm.ts` and
 * `shared/classifier.ts` where the Vitest suite covers it.
 */
import { LlmEndpoint } from '../shared/app-config';
import { LlmConnectionTest } from '../shared/ipc-api';
import { ChatMessage } from '../shared/llm';
import { maskAuthorizationHeader, truncate } from '../shared/llm-debug';
import { AppConfigStore } from './app-config';
import { LlmDebugLog } from './llm-debug-log';

/** GET /models is a cheap reachability probe -- fail fast if nothing is listening. */
const LIST_TIMEOUT_MS = 8_000;

/*
 * `/chat/completions` deliberately has NO timeout. A local model on
 * consumer hardware routinely thinks for minutes, and any deadline we pick
 * is wrong in both directions: short enough to be useful as a hang
 * detector is short enough to kill real work, and long enough not to kill
 * real work is useless as a hang detector. The user gets an explicit
 * Cancel instead (`electron/llm-tasks.ts`), which is honest about who
 * decides when waiting is over.
 */

/** Local `HH:mm:ss.mmm` -- debug entries are read next to each other, not sorted. */
function stamp(date: Date): string {
  const pad = (v: number, n = 2): string => String(v).padStart(n, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

export class LmStudioClient {
  constructor(
    private readonly config: AppConfigStore,
    private readonly debug: LlmDebugLog,
  ) {}

  /** The saved endpoint, or the caller's unsaved override (Settings "Test connection"). */
  private endpoint(override?: LlmEndpoint): LlmEndpoint {
    const { baseUrl, apiKey } = this.config.get().llm;
    const source = override ?? { baseUrl, apiKey };
    return { baseUrl: source.baseUrl.replace(/\/+$/, ''), apiKey: source.apiKey };
  }

  /**
   * `Authorization: Bearer <key>` when a key is configured, nothing
   * otherwise -- sending an empty bearer would make a server that doesn't
   * need auth reject a request it would otherwise have served.
   */
  private authHeaders(endpoint: LlmEndpoint): Record<string, string> {
    return endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {};
  }

  /**
   * Turns an HTTP failure into something actionable in the Settings pane --
   * 401/403 almost always means the API key, not the URL.
   */
  private describeHttpError(status: number, detail: string, endpoint: LlmEndpoint): string {
    if (status === 401 || status === 403) {
      return endpoint.apiKey
        ? `HTTP ${status} — the endpoint rejected the API key.`
        : `HTTP ${status} — this endpoint requires an API key.`;
    }
    return `HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  }

  /**
   * Records a call that was refused *before* any HTTP happened (no model
   * selected, master switch off). Without this the log is silent about
   * exactly the cases where nothing reaches the server, which is the most
   * confusing failure of all -- "I pressed the button and nothing appeared".
   */
  private recordNotSent(path: string, reason: string): void {
    this.debug.record({
      at: stamp(new Date()),
      method: 'POST',
      url: `${this.endpoint().baseUrl}${path}`,
      headers: {},
      authSent: false,
      body: null,
      status: null,
      durationMs: 0,
      responseBody: null,
      error: `Not sent — ${reason}`,
    });
  }

  /**
   * The single place a request actually leaves the app. Every call is
   * recorded in the debug log -- URL, headers (bearer masked), body,
   * status, timing, response -- so the LLM settings pane can show exactly
   * what went out and hand back a runnable `curl`. Returns the response
   * text alongside the status; JSON parsing is the caller's job.
   */
  private async send(
    endpoint: LlmEndpoint,
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ status: number; text: string }> {
    const url = `${endpoint.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...this.authHeaders(endpoint),
    };
    const startedAt = Date.now();
    const at = stamp(new Date());

    const logged = {
      at,
      method: init.method,
      url,
      // Masked copy -- the real key must never reach the renderer or a screenshot.
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          name === 'authorization' ? maskAuthorizationHeader(value) : value,
        ]),
      ),
      authSent: 'authorization' in headers,
      body: init.body !== undefined ? truncate(init.body) : null,
    };

    try {
      const res = await fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        // A deadline where one makes sense (the /models probe), the
        // caller's cancellation where it does not (chat).
        signal:
          init.timeoutMs !== undefined ? AbortSignal.timeout(init.timeoutMs) : init.signal,
      });
      const text = await res.text().catch(() => '');
      this.debug.record({
        ...logged,
        status: res.status,
        durationMs: Date.now() - startedAt,
        responseBody: truncate(text),
        error: null,
      });
      return { status: res.status, text };
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.debug.record({
        ...logged,
        status: null,
        durationMs: Date.now() - startedAt,
        responseBody: null,
        error: message,
      });
      throw err;
    }
  }

  /**
   * Model ids advertised by the endpoint (`data[].id`). Throws on any
   * transport/HTTP error. `override` lets the Settings screen probe the
   * URL/key currently typed in, before they are saved.
   */
  async listModels(override?: LlmEndpoint): Promise<string[]> {
    const endpoint = this.endpoint(override);
    const { status, text } = await this.send(endpoint, '/models', {
      method: 'GET',
      timeoutMs: LIST_TIMEOUT_MS,
    });
    if (status < 200 || status >= 300) {
      throw new Error(this.describeHttpError(status, text, endpoint));
    }
    const json = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
    return (json.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /** Never rejects -- turns any failure into `{ ok: false, message }` for the Settings UI. */
  async testConnection(override?: LlmEndpoint): Promise<LlmConnectionTest> {
    const { baseUrl } = this.endpoint(override);
    try {
      const models = await this.listModels(override);
      return {
        ok: true,
        message:
          models.length > 0
            ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`
            : 'Connected, but the server lists no models — load one, or type its id below.',
        models,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        // An HTTP status means we DID reach it -- don't claim otherwise.
        message: detail.startsWith('HTTP ')
          ? `${baseUrl} — ${detail}`
          : `Could not reach ${baseUrl} — ${detail}`,
        models: [],
      };
    }
  }

  /**
   * One non-streamed `/chat/completions` round-trip, returning the
   * assistant message text. Rejects when LLM features are off, no model is
   * selected, the server errors, or `options.signal` is aborted (the user
   * pressed Cancel). There is no timeout -- see the note at the top.
   */
  async chat(
    messages: ChatMessage[],
    options: { temperature?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const { llm } = this.config.get();
    if (!llm.enabled) {
      this.recordNotSent('/chat/completions', 'LLM features are disabled in settings.');
      throw new Error('LLM features are disabled in settings.');
    }
    if (!llm.model) {
      this.recordNotSent('/chat/completions', 'no model is selected in settings.');
      throw new Error('No model is selected in settings.');
    }

    // Always the saved endpoint -- actions and Ask run against settings the
    // user actually committed, never an in-flight Settings draft.
    const endpoint = this.endpoint();
    const { status, text } = await this.send(endpoint, '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: llm.model,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: false,
      }),
      signal: options.signal,
    });
    if (status < 200 || status >= 300) {
      throw new Error(this.describeHttpError(status, text, endpoint));
    }
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('The endpoint returned no message content.');
    }
    return content;
  }
}
