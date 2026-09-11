/**
 * `src/app/llm` — the renderer side of the LLM seams that stay BASE
 * (ADR-0044): the one shared confirmation dialog (Actions, Ask edits, MCP
 * `vault_write`) and the live request/response debug feed for Settings →
 * LLM. The actions/task services and the assistant panel are plugin-side
 * since stage 7.
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../llm`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { LlmDebugService } from './llm-debug.service';
export { ConfirmationService } from './confirmation.service';
