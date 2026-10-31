/**
 * The narrow contract every LLM backend implements (ADR-0047): extracted
 * from `LmStudioClient`'s public surface so the hosted dialects (OpenRouter
 * via the same OpenAI-compat client, Anthropic Messages for the Anthropic
 * API and Z.ai GLM), the CLI backends (Claude Code headless, GitHub
 * Copilot CLI) and the removable `copilot-web` scraper can all stand in,
 * with `LlmRouter` picking one per call.
 *
 * Main-process only: the renderer never sees this type. It deliberately
 * does NOT live in `shared/llm/` -- `LlmConnectionTest` is declared in
 * `shared/ipc-api.ts`, which already type-imports from `shared/llm`, so a
 * `shared/llm/llm-client.ts` would close a file-level import cycle for no
 * gain (the same note the ADR-0040 branch recorded).
 */
import { LlmEndpoint } from '../../shared/app-config';
import type { LlmProviderId } from '../../shared/app-config';
import {
  ChatAttachment,
  LlmCapabilities,
  LlmChatResult,
  ChatMessage,
  ToolCallEvent,
  ToolSpec,
} from '../../shared/llm';
import { LlmConnectionTest } from '../../shared/ipc-api';

/** The option bag `chat()` accepts; every field is optional and every provider honours its capability subset. */
export interface LlmChatOptions {
  temperature?: number;
  /**
   * ADR-0014: the ONLY cancellation path. No provider applies a generation
   * timeout -- the user cancels instead. Rejects with the fetch
   * `AbortError` (CLI providers kill their process tree and reject with
   * `name: 'AbortError'`), so `isAbortError` keeps working everywhere.
   */
  signal?: AbortSignal;
  /** Canonical tool descriptions; ignored by providers with `tools: false`. */
  tools?: ToolSpec[];
  /** Runs one tool call; the resolved text goes back to the model as the tool result. */
  onToolCall?: (name: string, argsJson: string) => Promise<string>;
  /** Round budget of the tool loop (`DEFAULT_TOOL_ROUNDS` when absent); see `tool-loop.ts`. */
  maxToolRounds?: number;
  /** Progress of the tool loop: one `start` and one `end` per tool call. */
  onToolEvent?: (event: ToolCallEvent) => void;
  /**
   * Incremental text. Without a tool loop the provider streams it — one
   * that cannot stream MUST still call this exactly once with the full
   * text when a callback was passed, so callers never branch on
   * capability to render the reply. With a tool loop the LOOP forwards:
   * every streamed round's deltas as they arrive, and exactly one call
   * with the full text when the final round did not stream.
   */
  onDelta?: (delta: string) => void;
  /** Continue a provider-side session (Claude Code `--resume`) instead of replaying history. */
  sessionRef?: string;
  /** Images attached to the LAST user message; ignored unless `capabilities().imageAttachments`. */
  attachments?: ChatAttachment[];
  /** Hard output cap (Anthropic `max_tokens`); providers with one use their preset default when absent. */
  maxOutputTokens?: number;
}

export interface LlmClient {
  /** The config id this client serves; the router never asks a client for a foreign provider. */
  readonly id: LlmProviderId;
  /** Runtime truth about what this backend supports (Settings renders a static preset copy). */
  capabilities(): LlmCapabilities;
  /**
   * Model ids the backend advertises. `override` lets Settings probe an
   * unsaved endpoint. A backend with no notion of model listing (CLI/web)
   * returns `[]`.
   */
  listModels(override?: LlmEndpoint): Promise<string[]>;
  /** Never rejects -- any failure becomes `{ ok: false, message }`. */
  testConnection(override?: LlmEndpoint): Promise<LlmConnectionTest>;
  /**
   * One round-trip (or one tool loop) returning the assistant text plus,
   * when the backend has them, a session handle and usage. Honours
   * `options.signal` for cancellation (rejecting with an `AbortError`).
   */
  chat(messages: ChatMessage[], options?: LlmChatOptions): Promise<LlmChatResult>;
}
