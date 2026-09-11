/**
 * `electron/llm` — the main-process LLM runtime that stays BASE (ADR-0044):
 * the HTTP client for the local model server, the per-generation abort
 * registry, the in-memory debug log, and the vocabulary-based tag
 * suggestion. The action engine (Actions/Ask/summary) moved into the
 * assistant plugin in stage 7 — the base facade (`ctx.llm`) is transport
 * plus the shared seams only.
 *
 * This barrel is the module's only public surface. Import from
 * `./llm` (or `../llm`), never from a file inside it — enforced by ESLint
 * (`no-restricted-imports`, see `eslint.config.mjs`). Internal files
 * import their siblings directly.
 */

export { TagSuggester } from './tag-suggest';
export { LmStudioClient } from './lm-studio-client';
export { LlmDebugLog } from './llm-debug-log';
export { CANCELLED_MESSAGE, isAbortError, LlmTaskRegistry } from './llm-tasks';
