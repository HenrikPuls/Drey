/**
 * Provider construction: which client serves which config id, and the
 * factory the app bootstraps the router from (ADR-0047). The remaining
 * providers (`copilot-cli`, `copilot-web`) register themselves here as
 * their milestone lands; until then their ids stay unrouted and
 * `LlmRouter.pick()` rejects with an actionable message instead of
 * pretending.
 */
import { AppConfigStore } from '../../app-config';
import { LlmClient } from '../llm-client';
import { LlmDebugLog } from '../llm-debug-log';
import { AnthropicMessagesProvider } from './anthropic-messages';
import { ClaudeCodeCliProvider } from './claude-code-cli';
import { OpenAiCompatProvider } from './openai-compat';

/**
 * One client instance per implemented provider id, built once and reused
 * for every call (the clients are stateless beyond the config/debug
 * references; provider switching happens in the router, not here).
 */
export function buildClients(config: AppConfigStore, debug: LlmDebugLog): Map<string, LlmClient> {
  const clients: LlmClient[] = [
    new OpenAiCompatProvider('lmstudio', config, debug),
    new OpenAiCompatProvider('openai-compat', config, debug),
    new OpenAiCompatProvider('openrouter', config, debug),
    new AnthropicMessagesProvider('anthropic', config, debug),
    new AnthropicMessagesProvider('zai-glm', config, debug),
    new ClaudeCodeCliProvider(config),
  ];
  return new Map(clients.map((client) => [client.id, client]));
}
