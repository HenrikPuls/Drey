/**
 * IPC contract, LLM part: the model list, the connection test, the
 * debug log, streamed text and cancellation (ADR-0047, ADR-0014)
 * (`shared/ipc-api.ts` is the barrel).
 */
import type { LlmEndpoint } from '../app-config';
import type { LlmCapabilities, LlmDebugEntry } from '../llm';

/** Result of `llm:test-connection` / the model-list probe (`GET /models`). */
export interface LlmConnectionTest {
  ok: boolean;
  /** Human-readable success or failure detail for the Settings screen. */
  message: string;
  /** Model ids from the endpoint; `[]` on failure. */
  models: string[];
}

/**
 * One streamed-LLM-text push (ADR-0047), tagged with the renderer-minted
 * `taskId` of the chat that produced it. A provider that cannot stream
 * sends its full text as exactly one event.
 */
export interface LlmDeltaEvent {
  taskId: string;
  text: string;
}

/** The LLM transport as the renderer sees it. */
export interface LlmIpc {
  /**
   * Live `GET /models`. Uses the saved LLM endpoint unless `override` is
   * given — the Settings screen passes the URL/key currently typed in, so
   * loading models doesn't force a save first. Rejects on transport/HTTP error.
   */
  listLlmModels(override?: LlmEndpoint): Promise<string[]>;

  /** Probe the LLM endpoint (saved, or `override`); never rejects (failure is `{ ok: false }`). */
  testLlmConnection(override?: LlmEndpoint): Promise<LlmConnectionTest>;

  /**
   * Every LLM HTTP exchange this session, oldest first — what the LLM
   * settings pane's debug log shows. Bearer tokens are already masked.
   * In-memory only (it carries note content), capped at 50 entries.
   */
  getLlmDebugLog(): Promise<LlmDebugEntry[]>;

  /** Empties the debug log. */
  clearLlmDebugLog(): Promise<void>;

  /**
   * Subscribes to new debug entries as requests happen (main -> renderer
   * push, same shape as `onOpenDailyNote`). Returns an unsubscribe.
   */
  onLlmDebugEntry(listener: (entry: LlmDebugEntry) => void): () => void;

  /**
   * Streamed LLM text (ADR-0047): one push per delta, tagged with the
   * renderer-minted `taskId` of the chat that produced it. A provider
   * that cannot stream sends its full text as exactly one event.
   */
  onLlmDelta(listener: (event: LlmDeltaEvent) => void): () => void;

  /**
   * The ACTIVE provider's capabilities, re-pushed after every app-config
   * write (a provider switch changes them). Lets plugins keep a
   * synchronously-readable capability cache for UI gating.
   */
  onLlmCapabilitiesChanged(listener: (capabilities: LlmCapabilities) => void): () => void;

  /**
   * Aborts a running generation. `taskId` is minted by the **renderer**
   * (`crypto.randomUUID`) and passed into the call being started, because
   * the UI has to be able to offer Cancel before that call returns.
   * Resolves `true` when something was actually aborted.
   *
   * This is why `/chat/completions` carries no timeout: a local model can
   * legitimately think for minutes, so the user decides when waiting is
   * over, not a constant (`electron/llm-tasks.ts`). The registry is base
   * even after the assistant conversion (ADR-0044 stage 7): any surface
   * that passed a `taskId` can cancel it.
   */
  cancelLlmTask(taskId: string): Promise<boolean>;
}
