/**
 * `electron/llm` — the main-process LLM runtime that stays BASE (ADR-0044):
 * the provider abstraction with its per-call router (ADR-0047), the
 * per-generation abort registry, the in-memory debug log, and the
 * vocabulary-based tag suggestion. The action engine (Actions/Ask/summary)
 * moved into the assistant plugin in stage 7 — the base facade (`ctx.llm`)
 * is transport plus the shared seams only.
 *
 * This barrel is the module's only public surface. Import from
 * `./llm` (or `../llm`), never from a file inside it — enforced by ESLint
 * (`no-restricted-imports`, see `eslint.config.mjs`). Internal files
 * import their siblings directly.
 */

export { TagSuggester } from './tag-suggest';
export { LlmDebugLog } from './llm-debug-log';
export { CANCELLED_MESSAGE, isAbortError, LlmTaskRegistry } from './llm-tasks';
export type { LlmChatOptions, LlmClient } from './llm-client';
export { LlmError } from './llm-errors';
export type { LlmErrorCode } from './llm-errors';
export { LlmRouter } from './llm-router';
export { buildClients } from './providers';
