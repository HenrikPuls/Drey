/**
 * The Anthropic-Messages provider (ADR-0047): one client for both presets
 * that speak this dialect -- the Anthropic API itself and Z.ai GLM's
 * Coding-Plan endpoint (`https://api.z.ai/api/anthropic`); only the base
 * URL and the key differ.
 *
 * Dialect notes that shape the code: the system prompt is a top-level
 * parameter, not a message; `max_tokens` is REQUIRED (preset default
 * 4096, overridable per call); roles alternate strictly (the adapter
 * merges); tools are `{name, description, input_schema}` with `tool_use`
 * / `tool_result` content blocks. Streaming is SSE
 * (`content_block_delta`). No generation timeout (ADR-0014).
 */
import { LlmEndpoint } from '../../../shared/app-config';
import {
  LlmChatResult,
  ChatMessage,
  AnthropicBlock,
  maskAuthorizationHeader,
  toAnthropicMessages,
  toAnthropicTools,
  truncate,
} from '../../../shared/llm';
import { LlmConnectionTest } from '../../../shared/ipc-api';
import { AppConfigStore } from '../../app-config';
import { LlmClient, LlmChatOptions } from '../llm-client';
import { LlmError } from '../llm-errors';
import { LlmDebugLog } from '../llm-debug-log';

/** GET /models is a cheap reachability probe -- fail fast if nothing is listening. */
const LIST_TIMEOUT_MS = 8_000;

/** Anthropic requires an explicit output cap on every call. */
const DEFAULT_MAX_TOKENS = 4096;

/** The protocol version header the API expects. */
const ANTHROPIC_VERSION = '2023-06-01';

/*
 * `/messages` deliberately has NO timeout (ADR-0014) -- same reasoning as
 * the OpenAI-compat provider: the user cancels explicitly.
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

/** The text payload of a `content_block_delta` frame, when it has one. */
function deltaText(frame: string): string | null {
  try {
    const json = JSON.parse(frame) as {
      type?: unknown;
      delta?: { type?: unknown; text?: unknown };
    };
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      return typeof json.delta.text === 'string' ? json.delta.text : null;
    }
  } catch {
    // Not JSON -- a keep-alive or a frame we don't understand.
  }
  return null;
}

export class AnthropicMessagesProvider implements LlmClient {
  readonly id: 'anthropic' | 'zai-glm';

  constructor(
    id: 'anthropic' | 'zai-glm',
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
    // The Messages API lives at `{base}/v1/messages`; the saved base URL is
    // the host root, so the version segment is appended here (trailing
    // slashes stripped first).
    const base = source.baseUrl.replace(/\/+$/, '');
    return { baseUrl: base, apiKey: source.apiKey };
  }

  private headers(endpoint: LlmEndpoint, extra?: Record<string, string>): Record<string, string> {
    const key = endpoint.apiKey;
    if (!key) {
      throw new LlmError('auth', 'This provider requires an API key — set one in Settings → LLM.');
    }
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      ...extra,
    };
  }

  private httpError(status: number, detail: string): LlmError {
    if (status === 401 || status === 403) {
      return new LlmError('auth', `HTTP ${status} — the endpoint rejected the API key.`);
    }
    return new LlmError('http', `HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  /**
   * Records a call refused before any HTTP happened (the auth check above
   * needs the endpoint, so it happens in `send`; a missing model is the
   * case logged here).
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
   * The single place a request leaves the app. Same debug-log contract as
   * the OpenAI-compat provider; the `x-api-key` header is masked (the log
   * never carries the real key).
   */
  private async send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ status: number; text: string }> {
    const url = `${this.endpoint().baseUrl}${path}`;
    let headers: Record<string, string>;
    try {
      headers = this.headers(this.endpoint(), init.body !== undefined ? {} : undefined);
    } catch (err) {
      this.recordNotSent(path, err instanceof Error ? err.message : String(err));
      throw err;
    }
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
          name === 'x-api-key' ? maskAuthorizationHeader(value) : value,
        ]),
      ),
      authSent: true,
      body: init.body !== undefined ? truncate(init.body) : null,
    };

    try {
      const res = await fetch(url, {
        method: init.method,
        headers,
        body: init.body,
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

  /** Model ids from `GET /v1/models` (`data[].id`). */
  async listModels(override?: LlmEndpoint): Promise<string[]> {
    const saved = this.endpoint();
    const headers = this.headers(override ?? saved);
    const url = `${(override ?? saved).baseUrl.replace(/\/+$/, '')}/v1/models`;
    const startedAt = Date.now();
    const at = stamp(new Date());
    const logged = {
      at,
      provider: this.id,
      method: 'GET' as const,
      url,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          name === 'x-api-key' ? maskAuthorizationHeader(value) : value,
        ]),
      ),
      authSent: true,
      body: null,
    };
    let status: number;
    let text: string;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text().catch(() => '');
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
    this.debug.record({
      ...logged,
      status,
      durationMs: Date.now() - startedAt,
      responseBody: truncate(text),
      error: null,
    });
    if (status === 404) {
      // A dialect host without the listing endpoint (seen on some gateway
      // deployments) -- the Settings UI falls back to typing the id.
      throw new LlmError('http', `HTTP 404 — this host does not expose a model listing; type the model id instead.`);
    }
    if (status < 200 || status >= 300) {
      throw this.httpError(status, text);
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
            : 'Connected, but the endpoint lists no models — type its id below.',
        models,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: detail.startsWith('HTTP ')
          ? `${baseUrl} — ${detail}`
          : `Could not reach ${baseUrl} — ${detail}`,
        models: [],
      };
    }
  }

  /**
   * One `/v1/messages` exchange (or tool loop). The canonical transcript
   * is adapted (`system` lifted out, tool turns as blocks); streaming is
   * SSE when the caller passed `onDelta` and no tool loop is in play.
   */
  async chat(messages: ChatMessage[], options: LlmChatOptions = {}): Promise<LlmChatResult> {
    const { llm } = this.config.get();
    if (!llm.enabled) {
      this.recordNotSent('/v1/messages', 'LLM features are disabled in settings.');
      throw new LlmError('disabled', 'LLM features are disabled in settings.');
    }
    if (!llm.model) {
      this.recordNotSent('/v1/messages', 'no model is selected in settings.');
      throw new LlmError('no-model', 'No model is selected in settings.');
    }

    const useTools =
      Array.isArray(options.tools) && options.tools.length > 0 && !!options.onToolCall;
    if (!useTools && options.onDelta) {
      return this.chatStreamed(messages, options);
    }
    return this.chatWithLoop(messages, options, useTools);
  }

  private requestBody(
    messages: ChatMessage[],
    options: LlmChatOptions,
    stream: boolean,
    toolWire: ReturnType<typeof toAnthropicTools> | null,
  ): Record<string, unknown> {
    const { model } = this.config.get().llm;
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages, options.attachments);
    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? 0.2,
      messages: anthropicMessages,
      stream,
    };
    if (system !== null) {
      body['system'] = system;
    }
    if (toolWire) {
      body['tools'] = toolWire;
    }
    return body;
  }

  /** Single streamed request (no tools in play). */
  private async chatStreamed(
    messages: ChatMessage[],
    options: LlmChatOptions,
  ): Promise<LlmChatResult> {
    const body = this.requestBody(messages, options, true, null);
    const { status, text } = await this.sendSse('/v1/messages', JSON.stringify(body), options);
    if (status < 200 || status >= 300) {
      throw this.httpError(status, text);
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
    useTools: boolean,
  ): Promise<LlmChatResult> {
    const convo: ChatMessage[] = [...messages];
    const toolTrace: ChatMessage[] = [];
    const toolWire = useTools ? toAnthropicTools(options.tools ?? []) : null;
    let toolsAllowed = toolWire !== null;
    const maxRounds = options.maxToolRounds ?? 5;

    for (let round = 0; ; round++) {
      const body = this.requestBody(convo, options, false, toolsAllowed ? toolWire : null);
      const { status, text } = await this.send('/v1/messages', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (status < 200 || status >= 300) {
        throw this.httpError(status, text);
      }

      let json: {
        content?: AnthropicBlock[];
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
        error?: { type?: unknown; message?: unknown };
      };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        // A 200 whose body is not JSON — a clean bad-reply instead of a
        // leaked SyntaxError (same stance as the OpenAI-compatible path).
        throw new LlmError(
          'bad-reply',
          'The endpoint returned a body that is not JSON.',
          text.slice(0, 200),
        );
      }
      if (json.error && typeof json.error.message === 'string') {
        throw new LlmError('http', `HTTP 200 — ${json.error.message}`);
      }
      const usage = {
        ...(typeof json.usage?.input_tokens === 'number'
          ? { inputTokens: json.usage.input_tokens }
          : {}),
        ...(typeof json.usage?.output_tokens === 'number'
          ? { outputTokens: json.usage.output_tokens }
          : {}),
      };
      const blocks = Array.isArray(json.content) ? json.content : [];

      if (toolsAllowed && round < maxRounds) {
        const toolUses = blocks.filter(
          (block): block is Extract<AnthropicBlock, { type: 'tool_use' }> =>
            block.type === 'tool_use',
        );
        if (toolUses.length > 0) {
          const textParts = blocks
            .filter((block): block is Extract<AnthropicBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text);
          const assistantTurn: ChatMessage = {
            role: 'assistant',
            content: textParts.join('') || null,
            tool_calls: toolUses.map((use) => ({
              id: use.id,
              type: 'function' as const,
              function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
            })),
          };
          convo.push(assistantTurn);
          toolTrace.push(assistantTurn);
          for (const use of toolUses) {
            const result = await options.onToolCall!(use.name, JSON.stringify(use.input ?? {}));
            const toolTurn: ChatMessage = { role: 'tool', tool_call_id: use.id, content: result };
            convo.push(toolTurn);
            toolTrace.push(toolTurn);
          }
          continue;
        }
      }

      const textOut = blocks
        .filter((block): block is Extract<AnthropicBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (textOut !== '') {
        options.onDelta?.(textOut);
        return {
          text: textOut,
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
          ...(toolTrace.length > 0 ? { toolTrace } : {}),
        };
      }
      if (toolTrace.length > 0) {
        // The loop ran tools but the model never spoke: give back what we
        // can — the live-edit turn names what happened over this empty
        // text instead of showing an error after applying the changes
        // (same stance as the OpenAI-compatible path).
        return { text: '', toolTrace };
      }
      // Silent-empty is how "no response" looked to the user — surface it.
      throw new LlmError(
        'bad-reply',
        'The endpoint returned no message content.',
        `round ${round} of ${maxRounds}`,
      );
    }
  }

  /**
   * SSE variant: same debug entry (assembled text instead of raw frames),
   * `content_block_delta` frames forwarded to `onDelta`.
   */
  private async sendSse(
    path: string,
    body: string,
    options: LlmChatOptions,
  ): Promise<{ status: number; text: string }> {
    const url = `${this.endpoint().baseUrl}${path}`;
    const headers = this.headers(this.endpoint(), { accept: 'text/event-stream' });
    const startedAt = Date.now();
    const at = stamp(new Date());
    const logged = {
      at,
      provider: this.id,
      method: 'POST' as const,
      url,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          name === 'x-api-key' ? maskAuthorizationHeader(value) : value,
        ]),
      ),
      authSent: true,
      body: truncate(body),
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      });
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
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt !== -1) {
          const frame = buffer.slice(0, newlineAt);
          buffer = buffer.slice(newlineAt + 1);
          const data = sseData(frame);
          if (data !== null && data !== '[DONE]') {
            const delta = deltaText(data);
            if (delta !== null) {
              chunks++;
              assembled += delta;
              options.onDelta?.(delta);
            }
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
}
