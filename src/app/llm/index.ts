/**
 * `src/app/llm` — the renderer side of the LLM / Actions feature, mirroring
 * `electron/llm/` and `shared/llm/`:
 *
 *   - `ActionsService`      — drains `EditorService.pendingActions` (on-save
 *                             Action outcomes) through the confirmation flow
 *   - `LlmTaskService`      — one in-flight generation per surface, with
 *                             cancel + a "thinking…/took Ns" status line
 *   - `LlmDebugService`     — the live request/response feed for Settings → LLM
 *   - `ConfirmationService` — the ADR-0011 unified confirmation dialog state
 *                             (Actions, Ask edits, MCP `vault_write`)
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../llm`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { ActionsService } from './actions.service';
export { LlmTaskService } from './llm-task.service';
export { LlmDebugService } from './llm-debug.service';
export { ConfirmationService } from './confirmation.service';
