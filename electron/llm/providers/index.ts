/**
 * `electron/llm/providers` — the LLM backends behind the `LlmClient`
 * interface (ADR-0047): the two HTTP dialects (OpenAI-compat for
 * lmstudio/openai-compat/openrouter, Anthropic Messages for
 * anthropic/zai-glm), the CLI base + the Claude Code backend, and the
 * preset factory the router is built from.
 *
 * This barrel is the directory's only public surface. Import from
 * `./providers`, never from a file inside it — enforced by ESLint
 * (`no-restricted-imports`, see `eslint.config.mjs`). Internal files
 * import their siblings directly.
 */

export { OpenAiCompatProvider } from './openai-compat';
export { AnthropicMessagesProvider } from './anthropic-messages';
export { ClaudeCodeCliProvider } from './claude-code-cli';
export { buildClients } from './presets';
