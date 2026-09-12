/**
 * `shared/llm` — the LLM / Actions code that crosses the IPC boundary: the
 * Actions model and resolver, the document-rewrite apply helpers, the
 * OpenAI-style chat message shape and JSON extraction, the classifier
 * prompt/parse pair, and the debug-log shaping.
 *
 * This barrel is the module's only public surface. Import from
 * `shared/llm`, never from a file inside it — the boundary is enforced by
 * ESLint (`no-restricted-imports`), see `eslint.config.mjs`. Internal
 * files import their siblings directly.
 */

export type { ActionContext, ActionOutcome, AskOutcome, ResolvedAction } from './actions';
export { resolveActions } from './actions';

export type {
  ChatAttachment,
  ChatMessage,
  ChatToolCall,
  LlmCapabilities,
  LlmChatResult,
  LlmUsage,
  ToolParameters,
  ToolSpec,
} from './llm';
export { extractJsonObject, parseJsonObject } from './llm';

export type {
  AnthropicBlock,
  AnthropicMessage,
  AnthropicToolsWire,
  OpenAiContentPart,
  OpenAiToolWire,
} from './adapters';
export {
  buildOpenAiUserContent,
  toAnthropicMessages,
  toAnthropicToolUse,
  toAnthropicTools,
  toOpenAiTools,
} from './adapters';

export type { TagSuggestion, TaskClassification, TaskPriority } from './classifier';
export {
  buildTagSuggestionMessages,
  buildTaskMessages,
  normalizeTagToken,
  parseSuggestedTags,
  parseTagSuggestion,
  parseTaskClassification,
} from './classifier';

export type { LlmDebugEntry } from './llm-debug';
export {
  DEBUG_BODY_LIMIT,
  maskAuthorizationHeader,
  maskSecret,
  toCurl,
  truncate,
} from './llm-debug';
