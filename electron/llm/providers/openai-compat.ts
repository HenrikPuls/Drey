/**
 * The OpenAI-compat provider (ADR-0047): the generalised former
 * `LmStudioClient`. One client serves `lmstudio` (the default local
 * endpoint), `openai-compat` (any user-typed URL -- Ollama, vLLM,
 * llama.cpp, Unsloth Desktop) and `openrouter` (hosted, bearer key
 * required, vendor-prefixed model slugs) -- same two endpoints, same
 * `Authorization: Bearer` convention.
 *
 * Streaming is SSE when the caller passed `onDelta` and no tool loop is
 * in play; a tool loop stays non-streamed round-by-round (the deltas then
 * arrive as one final call). `GET /models` keeps its 8 s reachability
 * deadline; generation has none (ADR-0014) -- the user cancels.
 *
 * `electron/`-only; the request/reply shaping lives in `shared/llm.ts`
 * and the pure wire adapters in `shared/llm/adapters.ts`, where the
 * Vitest suite covers the fragile part (ADR-0007).
 */
import { LlmEndpoint } from '../../../shared/app-config';
import {
  LlmChatResult,
  ChatMessage,
  buildOpenAiUserContent,
  maskAuthorizationHeader,
  toOpenAiTools,
  truncate,
} from '../../../shared/llm';
import { LlmConnectionTest } from '../../../shared/ipc-api';
import { AppConfigStore } from '../../app-config';
import { LlmClient, LlmChatOptions } from '../llm-client';
import { LlmError } from '../llm-errors';
import { LlmDebugLog } from '../llm-debug-log';

type OpenAiToolWire = ReturnType<typeof toOpenAiTools>[number];

/** GET /models is a cheap reachability probe -- fail fast if nothing is listening. */
const LIST_TIMEOUT_MS = 8_000;

/*
 * `/chat/completions` deliberately has NO timeout (ADR-0014). A local
 * model on consumer hardware routinely thinks for minutes, and any
 * deadline we pick is wrong in both directions. The user gets an explicit
 * Cancel instead (`electron/llm-tasks.ts`).
 */

/** Local `HH:mm:ss.mmm` -- debug entries are read next to each other, not sorted. */
function stamp(date: Date): string {
  const pad = (v: number, n = 2): string => String(v).padStart(n, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

/** One `data:` frame of an SSE reply, or null for comments/keep-alives. */
function sseData(chunk: string): string | null {
  const line = chunk.trim();
  return line.startsWith('data:') ? line.slice(5).trim() : null;
}

export class OpenAiCompatProvider implements LlmClient {
  readonly id: 'lmstudio' | 'openai-compat' | 'openrouter';

  constructor(
    id: 'lmstudio' | 'openai-compat' | 'openrouter',
    private readonly config: AppConfigStore,
    private readonly debug: LlmDebugLog,
  ) {
    this.id = id;
  }

  capabilities() {
    return {
      tools: true,
      streaming: true,
      sessions: false,
      modelListing: true,
      imageAttachments: true,
    };
  }

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
  private httpError(status: number, detail: string, endpoint: LlmEndpoint): LlmError {
    if (status === 401 || status === 403) {
      return new LlmError(
        'auth',
        endpoint.apiKey
          ? `HTTP ${status} — the endpoint rejected the API key.`
          : `HTTP ${status} — this endpoint requires an API key.`,
      );
    }
    return new LlmError('http', `HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
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
      provider: this.id,
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
      provider: this.id,
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
        signal: init.timeoutMs !== undefined ? AbortSignal.timeout(init.timeoutMs) : init.signal,
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
   * The streamed variant: same entry in the debug log (request body with
   * `stream: true`; the response side logs the assembled text rather than
   * the raw SSE frames), deltas forwarded to `onDelta` as they arrive.
   */
  private async sendStream(
    endpoint: LlmEndpoint,
    path: string,
    init: { method: 'POST'; body: string; signal?: AbortSignal },
    onDelta: (delta: string) => void,
  ): Promise<{ status: number; text: string }> {
    const url = `${endpoint.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.authHeaders(endpoint),
    };
    const startedAt = Date.now();
    const at = stamp(new Date());
    const logged = {
      at,
      provider: this.id,
      method: init.method,
      url,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          name === 'authorization' ? maskAuthorizationHeader(value) : value,
        ]),
      ),
      authSent: 'authorization' in headers,
      body: truncate(init.body),
    };

    try {
      const res = await fetch(url, { method: init.method, headers, body: init.body, signal: init.signal });
      if (res.status < 200 || res.status >= 300) {
        const text = await res.text().catch(() => '');
        this.debug.record({
          ...logged,
          status: res.status,
          durationMs: Date.now() - startedAt,
          responseBody: truncate(text),
          error: null,
        });
        return { status: res.status, text };
      }
      if (!res.body) {
        return { status: res.status, text: '' };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';
      let chunks = 0;
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt !== -1) {
          const frame = buffer.slice(0, newlineAt);
          buffer = buffer.slice(newlineAt + 1);
          const data = sseData(frame);
          if (data !== null && data !== '[DONE]') {
            try {
              const json = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: unknown } }>;
              };
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                chunks++;
                assembled += delta;
                onDelta(delta);
              }
            } catch {
              // A keep-alive or a frame we don't understand -- skip it.
            }
          }
          if (data === '[DONE]') {
            done = true;
          }
          newlineAt = buffer.indexOf('\n');
        }
      }
      this.debug.record({
        ...logged,
        status: res.status,
        durationMs: Date.now() - startedAt,
        responseBody: truncate(`[SSE stream, ${chunks} chunk(s)]\n${assembled}`),
        error: null,
      });
      return { status: res.status, text: assembled };
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
      throw this.httpError(status, text, endpoint);
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
   * One `/chat/completions` exchange (or tool loop), returning the
   * assistant message text. Rejects when LLM features are off, no model
   * is selected, the server errors, or `options.signal` is aborted (the
   * user pressed Cancel). No timeout -- see the note at the top.
   *
   * With `options.tools`, the reply may be one or more `tool_calls`
   * instead of prose: each is run through `options.onToolCall` and the
   * result fed back, looping up to `maxToolRounds` (default 5) until the
   * model returns text. A server that rejects the `tools` parameter
   * outright is retried once without it (capability fallback). The loop
   * runs non-streamed; when the caller passed `onDelta` the final text is
   * delivered through exactly one call. Without tools, a caller-passed
   * `onDelta` upgrades the request to SSE streaming.
   */
  async chat(messages: ChatMessage[], options: LlmChatOptions = {}): Promise<LlmChatResult> {
    const { llm } = this.config.get();
    if (!llm.enabled) {
      this.recordNotSent('/chat/completions', 'LLM features are disabled in settings.');
      throw new LlmError('disabled', 'LLM features are disabled in settings.');
    }
    if (!llm.model) {
      this.recordNotSent('/chat/completions', 'no model is selected in settings.');
      throw new LlmError('no-model', 'No model is selected in settings.');
    }

    // Always the saved endpoint -- actions and Ask run against settings the
    // user actually committed, never an in-flight Settings draft.
    const endpoint = this.endpoint();
    const useTools =
      Array.isArray(options.tools) && options.tools.length > 0 && !!options.onToolCall;

    if (!useTools && options.onDelta) {
      return this.chatStreamed(messages, options, endpoint);
    }
    return this.chatWithLoop(messages, options, endpoint, useTools);
  }

  /** Single streamed request (no tools in play). */
  private async chatStreamed(
    messages: ChatMessage[],
    options: LlmChatOptions,
    endpoint: LlmEndpoint,
  ): Promise<LlmChatResult> {
    const { model } = this.config.get().llm;
    const body: Record<string, unknown> = {
      model,
      messages: this.withAttachmentContent([...messages], options),
      temperature: options.temperature ?? 0.2,
      stream: true,
    };
    const { status, text } = await this.sendStream(
      endpoint,
      '/chat/completions',
      { method: 'POST', body: JSON.stringify(body), signal: options.signal },
      options.onDelta!,
    );
    if (status < 200 || status >= 300) {
      throw this.httpError(status, text, endpoint);
    }
    if (text === '') {
      throw new LlmError('bad-reply', 'The endpoint returned no message content.');
    }
    return { text };
  }

  /** The non-streamed path, with the tool loop when tools are in play. */
  private async chatWithLoop(
    messages: ChatMessage[],
    options: LlmChatOptions,
    endpoint: LlmEndpoint,
    useTools: boolean,
  ): Promise<LlmChatResult> {
    const { llm } = this.config.get();
    const convo: ChatMessage[] = [...messages];
    const toolWire: OpenAiToolWire[] | null = useTools ? toOpenAiTools(options.tools ?? []) : null;
    let toolsAllowed = toolWire !== null;
    const maxRounds = options.maxToolRounds ?? 5;

    for (let round = 0; ; round++) {
      const body: Record<string, unknown> = {
        model: llm.model,
        // The wire array may carry vision content parts on the last user
        // turn -- wider than the canonical `ChatMessage`, JSON either way.
        messages: this.withAttachmentContent(convo, options),
        temperature: options.temperature ?? 0.2,
        stream: false,
      };
      if (toolsAllowed && toolWire) {
        body['tools'] = toolWire;
        body['tool_choice'] = 'auto';
      }

      const { status, text } = await this.send(endpoint, '/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (status === 400 && toolsAllowed) {
        // This server doesn't understand `tools`. Drop them and retry once.
        toolsAllowed = false;
        continue;
      }
      if (status < 200 || status >= 300) {
        throw this.httpError(status, text, endpoint);
      }

      const json = JSON.parse(text) as {
        choices?: Array<{
          message?: { content?: unknown; tool_calls?: ChatMessage['tool_calls'] };
        }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        error?: { message?: unknown };
      };
      // OpenRouter reports some failures as HTTP 200 with an error body.
      if (json.error && typeof json.error.message === 'string') {
        throw new LlmError('http', `HTTP 200 — ${json.error.message}`);
      }
      const usage = {
        ...(typeof json.usage?.prompt_tokens === 'number'
          ? { inputTokens: json.usage.prompt_tokens }
          : {}),
        ...(typeof json.usage?.completion_tokens === 'number'
          ? { outputTokens: json.usage.completion_tokens }
          : {}),
      };
      const message = json.choices?.[0]?.message;
      const toolCalls = message?.tool_calls;

      if (toolsAllowed && Array.isArray(toolCalls) && toolCalls.length > 0 && round < maxRounds) {
        convo.push({
          role: 'assistant',
          content: typeof message?.content === 'string' ? message.content : null,
          tool_calls: toolCalls,
        });
        for (const call of toolCalls) {
          const result = await options.onToolCall!(
            call.function?.name ?? '',
            call.function?.arguments ?? '{}',
          );
          convo.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        continue;
      }

      if (typeof message?.content === 'string') {
        // Non-streamed: an onDelta caller still gets exactly one call.
        options.onDelta?.(message.content);
        return {
          text: message.content,
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
        };
      }
      // A model that keeps calling tools past the round cap, or returns an
      // empty message -- give back what we can rather than throw.
      if (round >= maxRounds) {
        return { text: '' };
      }
      throw new LlmError('bad-reply', 'The endpoint returned no message content.');
    }
  }

  /** Replaces the LAST user message's content with attachment parts, when attachments were passed. */
  private withAttachmentContent(convo: ChatMessage[], options: LlmChatOptions): unknown[] {
    if (!options.attachments || options.attachments.length === 0) {
      return convo;
    }
    let lastUserIndex = -1;
    for (let i = convo.length - 1; i >= 0; i--) {
      if (convo[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return convo;
    }
    return convo.map((message, index) =>
      index === lastUserIndex && message.role === 'user'
        ? {
            ...message,
            content: buildOpenAiUserContent(message.content ?? '', options.attachments),
          }
        : message,
    );
  }
}
