/**
 * The per-call provider pick (ADR-0047): re-reads `llm.provider` from the
 * config on EVERY call, so switching providers in Settings applies on the
 * next request -- no restart, no re-construction. A provider id without a
 * registered client (a preset whose milestone hasn't landed, or a
 * removed/copilot-web build) rejects with an actionable message instead
 * of silently falling back to a different backend.
 */
import { LlmEndpoint } from '../../shared/app-config';
import type { LlmProviderId } from '../../shared/app-config';
import { LlmCapabilities, LlmChatResult, ChatMessage } from '../../shared/llm';
import { LlmConnectionTest } from '../../shared/ipc-api';
import { AppConfigStore } from '../app-config';
import { LlmClient, LlmChatOptions } from './llm-client';
import { LlmError } from './llm-errors';

export class LlmRouter implements LlmClient {
  constructor(
    private readonly config: AppConfigStore,
    private readonly clients: Map<string, LlmClient>,
  ) {}

  /** The active provider id -- what the debug log and errors should name. */
  get id(): LlmProviderId {
    return this.config.get().llm.provider;
  }

  capabilities(): LlmCapabilities {
    return this.pick().capabilities();
  }

  listModels(override?: LlmEndpoint): Promise<string[]> {
    return this.pick().listModels(override);
  }

  /** Never rejects -- the pick happens lazily inside try/catch via the client. */
  async testConnection(override?: LlmEndpoint): Promise<LlmConnectionTest> {
    try {
      return await this.pick().testConnection(override);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        models: [],
      };
    }
  }

  chat(messages: ChatMessage[], options?: LlmChatOptions): Promise<LlmChatResult> {
    return this.pick().chat(messages, options);
  }

  private pick(): LlmClient {
    const provider = this.config.get().llm.provider;
    const client = this.clients.get(provider);
    if (client === undefined) {
      throw new LlmError(
        'unsupported',
        `The "${provider}" provider is not available in this build.`,
      );
    }
    return client;
  }
}
