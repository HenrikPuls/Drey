/**
 * `electron/llm` — the main-process LLM / Actions runtime: the HTTP client
 * for the local model server, the classifier wrapper, the per-generation
 * abort registry, the in-memory debug log, and the `ActionRunner` that
 * sequences them for Actions, Ask, and the note summary.
 *
 * This barrel is the module's only public surface. Import from
 * `./llm` (or `../llm`), never from a file inside it — enforced by ESLint
 * (`no-restricted-imports`, see `eslint.config.mjs`). Internal files
 * import their siblings directly.
 */

export { ActionRunner } from './action-runner';
export { ClassifierService } from './classifier';
export { LmStudioClient } from './lm-studio-client';
export { LlmDebugLog } from './llm-debug-log';
export { CANCELLED_MESSAGE, isAbortError, LlmTaskRegistry } from './llm-tasks';
