/**
 * The provider error taxonomy (ADR-0047). Deliberately SMALL: these codes
 * cover the failure modes a caller can react to; anything finer stays in
 * the message/detail text. Cancellation is NOT part of the taxonomy --
 * providers reject with the fetch `AbortError` (or `name: 'AbortError'`
 * after a CLI kill), which `isAbortError` (`electron/llm/llm-tasks.ts`)
 * already recognises, so every existing cancel path survives untouched.
 */
export type LlmErrorCode =
  | 'disabled' // LLM features are switched off (the master switch).
  | 'no-model' // no model id selected/typed.
  | 'auth' // 401/403 -- the endpoint rejected (or required) the API key.
  | 'http' // any other non-2xx, including OpenRouter's 200-with-error-body.
  | 'bad-reply' // unparseable/empty response body.
  | 'spawn' // CLI executable missing, or it exited nonzero.
  | 'unsupported'; // a capability was used that this provider lacks.

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    /** Longer, non-localised detail (response body excerpt, exit code, ...). */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
