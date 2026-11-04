/**
 * Which model Mission Control talks to, and how (D-1, milestone 131). The
 * engine does not own an LLM client — Drey's plugin pushes the assistant
 * settings (ADR-0047) into the engine config as `chat.*` keys — so this
 * module is the engine's whole knowledge of providers: three config keys
 * become one resolved spec or one honest failure, the two HTTP dialects
 * the bridge can speak (OpenAI-compatible, Anthropic Messages) build and
 * read their wire here, and the settings screen's "Test connection"
 * probes the same spec the chat turn would use.
 *
 * The provider ids mirror `LlmProviderId` (`shared/config/schema.ts`);
 * the engine package cannot import Drey's config module, so the small
 * table is copied and `chat-model.spec.ts` pins it against the source.
 */
import { toAnthropicMessages, type ChatMessage } from '../../../../shared/llm';
import type { ChatFailureCode, ChatModelFailure } from '../contracts/chat';

export const CHAT_KEYS = {
  baseUrl: 'chat.baseUrl',
  apiKey: 'chat.apiKey',
  model: 'chat.model',
  provider: 'chat.provider',
  enabled: 'chat.enabled',
} as const;

export type ChatDialect = 'openai' | 'anthropic';

interface ProviderInfo {
  readonly label: string;
  /** null = a provider the bridge cannot speak (no HTTP endpoint of a known dialect). */
  readonly dialect: ChatDialect | null;
}

/** Drey's provider ids, with the dialect each speaks (shared/config/schema.ts `PROVIDER_PRESETS`). */
const PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  lmstudio: { label: 'LM Studio', dialect: 'openai' },
  'openai-compat': { label: 'OpenAI-compatible server', dialect: 'openai' },
  openrouter: { label: 'OpenRouter', dialect: 'openai' },
  anthropic: { label: 'Anthropic API', dialect: 'anthropic' },
  'zai-glm': { label: 'Z.ai GLM', dialect: 'anthropic' },
  'claude-code': { label: 'Claude Code (CLI)', dialect: null },
  'copilot-cli': { label: 'GitHub Copilot CLI', dialect: null },
  'copilot-web': { label: 'Copilot (web)', dialect: null },
};

/** The provider ids the table knows — the spec compares it with Drey's presets. */
export const CHAT_PROVIDER_IDS: readonly string[] = Object.keys(PROVIDERS);

/** An engine configured before the provider key existed (or run alone) speaks OpenAI-compatible. */
const DEFAULT_PROVIDER = 'openai-compat';

/** The Anthropic API requires an explicit output cap on every call. */
const ANTHROPIC_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';
/** Reachability probes fail fast; generation has its own (long) turn timeout. */
const TEST_TIMEOUT_MS = 8_000;

/** The resolved connection: what a turn or a test sends, and to whom. */
export interface ChatModelSpec {
  readonly provider: string;
  readonly providerLabel: string;
  readonly dialect: ChatDialect;
  /** Trailing slashes stripped. */
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly model: string;
}

export interface ChatModelConfig {
  get<T>(key: string): Promise<T | undefined>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function providerLabelOf(provider: string): string {
  return PROVIDERS[provider]?.label ?? provider;
}

/** Builds a failure; the message names provider, endpoint and reason in one line. */
export function chatFailure(
  code: ChatFailureCode,
  provider: string,
  baseUrl: string | null,
  model: string | null,
  reason: string,
): ChatModelFailure {
  const providerLabel = providerLabelOf(provider);
  const where = baseUrl === null || baseUrl === '' ? providerLabel : `${providerLabel} at ${baseUrl}`;
  return { code, provider, providerLabel, baseUrl, model, reason, message: `${where}: ${reason}` };
}

/** Reads the engine config into a spec, or the reason Mission Control has no model yet. */
export async function resolveChatModel(config: ChatModelConfig): Promise<{ readonly ok: true; readonly spec: ChatModelSpec } | { readonly ok: false; readonly failure: ChatModelFailure }> {
  const [baseUrl, apiKey, model, provider, enabled] = await Promise.all([
    config.get<string>(CHAT_KEYS.baseUrl),
    config.get<string>(CHAT_KEYS.apiKey),
    config.get<string>(CHAT_KEYS.model),
    config.get<string>(CHAT_KEYS.provider),
    config.get<boolean>(CHAT_KEYS.enabled),
  ]);
  const id = text(provider) === '' ? DEFAULT_PROVIDER : text(provider);
  const base = text(baseUrl).replace(/\/+$/, '');
  const modelId = text(model);
  const key = text(apiKey) === '' ? null : text(apiKey);
  if (enabled === false) {
    return {
      ok: false,
      failure: chatFailure('not-configured', id, base, modelId, 'the assistant is switched off in Drey (Settings → Assistant).'),
    };
  }
  const info = PROVIDERS[id];
  if (info === undefined || info.dialect === null) {
    return {
      ok: false,
      failure: chatFailure(
        'unsupported',
        id,
        null,
        modelId === '' ? null : modelId,
        `Mission Control cannot talk to this provider (it has no HTTP endpoint it can speak). Pick LM Studio, an OpenAI-compatible server, OpenRouter, the Anthropic API or Z.ai GLM in Drey → Settings → Assistant.`,
      ),
    };
  }
  if (base === '' || modelId === '') {
    return {
      ok: false,
      failure: chatFailure(
        'not-configured',
        id,
        base === '' ? null : base,
        modelId === '' ? null : modelId,
        base === '' ? 'no endpoint is set — pick the assistant model in Drey → Settings → Assistant.' : 'no model is selected — pick the assistant model in Drey → Settings → Assistant.',
      ),
    };
  }
  return { ok: true, spec: { provider: id, providerLabel: info.label, dialect: info.dialect, baseUrl: base, apiKey: key, model: modelId } };
}

/** One chat request in the spec's dialect. */
export function chatRequest(
  spec: ChatModelSpec,
  messages: readonly { readonly role: string; readonly content: string }[],
): { readonly url: string; readonly headers: Record<string, string>; readonly body: string } {
  if (spec.dialect === 'openai') {
    return {
      url: `${spec.baseUrl}/chat/completions`,
      headers: {
        'content-type': 'application/json',
        ...(spec.apiKey === null ? {} : { authorization: `Bearer ${spec.apiKey}` }),
      },
      body: JSON.stringify({ model: spec.model, stream: true, messages }),
    };
  }
  const canonical: ChatMessage[] = messages.map((m) => ({
    role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const adapted = toAnthropicMessages(canonical);
  return {
    url: `${spec.baseUrl}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(spec.apiKey === null ? {} : { 'x-api-key': spec.apiKey }),
    },
    body: JSON.stringify({
      model: spec.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      stream: true,
      ...(adapted.system === null ? {} : { system: adapted.system }),
      messages: adapted.messages,
    }),
  };
}

/** The text delta of one SSE `data:` payload in the dialect; null when it carries none. */
export function deltaOf(dialect: ChatDialect, data: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (dialect === 'anthropic') {
    const delta = obj['delta'];
    if (obj['type'] !== 'content_block_delta' || typeof delta !== 'object' || delta === null) {
      return null;
    }
    const d = delta as Record<string, unknown>;
    return d['type'] === 'text_delta' && typeof d['text'] === 'string' ? d['text'] : null;
  }
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first: unknown = choices[0];
  const delta = typeof first === 'object' && first !== null ? (first as Record<string, unknown>)['delta'] : undefined;
  const content = typeof delta === 'object' && delta !== null ? (delta as Record<string, unknown>)['content'] : undefined;
  return typeof content === 'string' ? content : null;
}

/** The short reason a thrown fetch error carries (`ECONNREFUSED`, `ENOTFOUND`, …), never a bare "fetch failed". */
export function causeOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    const message = (cause as { message?: unknown }).message;
    if (typeof code === 'string' && code !== '') {
      return code === 'ECONNREFUSED' ? 'connection refused — nothing is listening there' : code === 'ENOTFOUND' ? 'the host name does not resolve' : code;
    }
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }
  return error.message;
}

/** What an HTTP refusal means for the owner, in one clause. */
export function httpReason(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  const tail = snippet === '' ? '' : ` (${snippet})`;
  if (status === 401 || status === 403) {
    return `the endpoint rejected the API key (HTTP ${status}).`;
  }
  if (status === 404) {
    return `the endpoint answered HTTP 404${tail} — the URL or the model id is wrong.`;
  }
  return `the endpoint answered HTTP ${status}${tail}.`;
}

export interface ChatTestResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * The settings screen's "Test connection": resolves the config like a
 * turn would, then asks the endpoint for its model list (a cheap GET that
 * costs no tokens). A host without the listing but reachable counts as
 * reachable — Drey lets the model id be typed by hand for such hosts.
 */
export async function testChatModel(config: ChatModelConfig, transport: typeof fetch = fetch): Promise<ChatTestResult> {
  const resolved = await resolveChatModel(config);
  if (!resolved.ok) {
    return { ok: false, message: resolved.failure.message };
  }
  const { spec } = resolved;
  const url = spec.dialect === 'openai' ? `${spec.baseUrl}/models` : `${spec.baseUrl}/v1/models`;
  const headers: Record<string, string> =
    spec.dialect === 'openai'
      ? spec.apiKey === null
        ? {}
        : { authorization: `Bearer ${spec.apiKey}` }
      : { 'anthropic-version': ANTHROPIC_VERSION, ...(spec.apiKey === null ? {} : { 'x-api-key': spec.apiKey }) };
  try {
    const response = await transport(url, { method: 'GET', headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    const body = await response.text().catch(() => '');
    if (response.ok) {
      const ids = modelIds(body);
      const known = ids.length === 0 || ids.includes(spec.model);
      return {
        ok: true,
        message: known
          ? `Connected to ${spec.providerLabel} at ${spec.baseUrl}. Model ${spec.model}${ids.length === 0 ? ' (the endpoint lists no models).' : ' is available.'}`
          : `Connected to ${spec.providerLabel} at ${spec.baseUrl}, but it does not list the model ${spec.model}. Pick another in Drey → Settings → Assistant.`,
      };
    }
    if (response.status === 404 || response.status === 405) {
      return { ok: true, message: `Reached ${spec.providerLabel} at ${spec.baseUrl} — it exposes no model list, so the model ${spec.model} is untested.` };
    }
    return { ok: false, message: chatFailure('refused', spec.provider, spec.baseUrl, spec.model, httpReason(response.status, body)).message };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'no answer within 8 seconds.' : `could not be reached — ${causeOf(error)}.`;
    return { ok: false, message: chatFailure('unreachable', spec.provider, spec.baseUrl, spec.model, reason).message };
  }
}

function modelIds(body: string): string[] {
  try {
    const data = (JSON.parse(body) as { data?: unknown }).data;
    return Array.isArray(data)
      ? data.flatMap((entry): string[] => {
          const id = typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined;
          return typeof id === 'string' ? [id] : [];
        })
      : [];
  } catch {
    return [];
  }
}
