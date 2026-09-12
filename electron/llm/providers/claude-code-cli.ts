/**
 * The Claude Code CLI provider (ADR-0047): headless `claude -p` with
 * `--output-format stream-json`, the session id from the `init` event and
 * `--resume` for continuation.
 *
 * Deliberate boundaries:
 * - **No Drey tool loop.** `-p` runs Claude Code's own agent loop with its
 *   own tools; a Drey-side loop would run the same tools twice. The
 *   default headless permission posture auto-denies its write-class tools
 *   (reads allowed), which is the safe default -- `--allowedTools` /
 *   `--permission-mode` knobs are a later, explicit decision (roadmap
 *   open question).
 * - Model access and authentication are the CLI's own (its login/config);
 *   `--model` is passed through when one is set in Drey's settings, and
 *   is optional -- without it the CLI's default model answers.
 * - The prompt (flattened transcript) rides stdin, never argv; the model
 *   id and session ref are the only user-controlled argv members and are
 *   strict-token validated (`isValidCliToken`).
 */
import type { LlmCapabilities } from '../../../shared/llm';
import { AppConfigStore } from '../../app-config';
import { LlmChatOptions } from '../llm-client';
import { LlmError } from '../llm-errors';
import { CliEventSink, CliLineHandler, CliProviderBase, isValidCliToken } from './cli-base';

/** Loose shapes of the stream-json dialect; everything else is ignored. */
interface StreamEvent {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  result?: unknown;
  event?: {
    type?: unknown;
    delta?: { type?: unknown; text?: unknown };
  };
  message?: {
    content?: Array<{ type?: unknown; text?: unknown }>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

export class ClaudeCodeCliProvider extends CliProviderBase {
  readonly id = 'claude-code' as const;

  constructor(private readonly config: AppConfigStore) {
    super();
  }

  capabilities(): LlmCapabilities {
    return {
      tools: false,
      streaming: true,
      sessions: true,
      modelListing: false,
      imageAttachments: false,
    };
  }

  protected readonly exe = 'claude';

  protected buildArgs(options: LlmChatOptions): string[] {
    const { llm } = this.config.get();
    if (!llm.enabled) {
      throw new LlmError('disabled', 'LLM features are disabled in settings.');
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (options.onDelta) {
      args.push('--include-partial-messages');
    }
    if (llm.model !== null) {
      if (!isValidCliToken(llm.model)) {
        throw new LlmError('no-model', `"${llm.model}" is not a usable model id for the CLI.`);
      }
      args.push('--model', llm.model);
    }
    if (options.sessionRef !== undefined) {
      if (!isValidCliToken(options.sessionRef)) {
        throw new LlmError('unsupported', `"${options.sessionRef}" is not a usable session id.`);
      }
      args.push('--resume', options.sessionRef);
    }
    return args;
  }

  protected handleLine: CliLineHandler = (line, sink) => {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return; // A non-JSON line (banner noise) -- skip it.
    }
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && typeof event.session_id === 'string') {
          sink.sessionRef(event.session_id);
        }
        break;
      case 'stream_event': {
        const delta = event.event?.delta;
        if (
          event.event?.type === 'content_block_delta' &&
          delta?.type === 'text_delta' &&
          typeof delta.text === 'string'
        ) {
          sink.delta(delta.text);
        }
        break;
      }
      case 'assistant': {
        const text = (event.message?.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('');
        if (text !== '') {
          // Authoritative complete turn -- replaces the streamed fragments.
          sink.setText(text);
        }
        this.sinkUsage(event.message?.usage, sink);
        break;
      }
      case 'result': {
        if (event.is_error === true) {
          const detail = typeof event.result === 'string' ? event.result : String(event.subtype ?? 'error');
          throw new LlmError('bad-reply', `The claude CLI reported an error: ${detail.slice(0, 300)}`);
        }
        if (typeof event.result === 'string') {
          sink.setText(event.result);
        }
        if (typeof event.session_id === 'string') {
          sink.sessionRef(event.session_id);
        }
        this.sinkUsage(event.usage, sink);
        break;
      }
      default:
        break; // tool_use / user / progress events are claude's own loop -- out of scope.
    }
  };

  private sinkUsage(
    usage: { input_tokens?: unknown; output_tokens?: unknown } | undefined,
    sink: CliEventSink,
  ): void {
    if (!usage) {
      return;
    }
    const out: { inputTokens?: number; outputTokens?: number } = {};
    if (typeof usage.input_tokens === 'number') {
      out.inputTokens = usage.input_tokens;
    }
    if (typeof usage.output_tokens === 'number') {
      out.outputTokens = usage.output_tokens;
    }
    if (Object.keys(out).length > 0) {
      sink.usage(out);
    }
  }
}
