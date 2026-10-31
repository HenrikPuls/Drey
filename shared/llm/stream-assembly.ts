/**
 * Pure SSE-frame accumulators for a streamed round of the tool loop
 * (ADR-0071 later change): both HTTP providers send a tool-carrying
 * request with `stream: true` and feed every parsed event payload into
 * one of these sinks. `push` returns the TEXT delta to forward (the
 * loop owns the forwarding, so it can tell a streamed round from a
 * non-streamed one); `result()` hands the round's reply to the loop in
 * the canonical shape — the assembled text, the tool calls, and whether
 * the output limit cut the reply off.
 *
 * Loose-server tolerance mirrors `toChatToolCall`: a missing id becomes
 * `call-<index>`, object arguments are stringified, and arguments that
 * never arrived are `{}`. Unknown frames and events are skipped — a
 * keep-alive or a vendor extension must never break a round.
 */
import type { ChatToolCall } from './llm';

/** One streamed round's reply, in the canonical shape (`ModelReply` minus usage). */
export interface AssembledReply {
  text: string;
  toolCalls: ChatToolCall[];
  /** The reply stopped at the output limit. */
  truncated: boolean;
}

/** What both sinks look like to a provider's SSE read loop. */
export interface StreamSink {
  /**
   * One parsed event payload. Returns the text delta this frame carries
   * (to be forwarded as it arrives), or `null` when it carries none.
   */
  push(payload: unknown): string | null;
  /** The assembled reply; call once the stream ended. */
  result(): AssembledReply;
}

/** `arguments` of a call whose fragments never carried any: `{}`, as `toChatToolCall` builds it. */
function defaultArguments(args: string): string {
  return args === '' ? '{}' : args;
}

type TextBlock = { kind: 'text'; text: string };
type ToolBlock = { kind: 'tool_use'; id?: string; name?: string; json: string };

/**
 * The OpenAI-compat shape: `choices[0].delta.content` text plus
 * `delta.tool_calls[]` fragments merged by `index` — id and name arrive
 * once (in the first fragment), `arguments` is concatenated across the
 * rest. `finish_reason: "length"` marks a reply the output limit cut.
 */
export function createOpenAiChunkSink(): StreamSink {
  let text = '';
  let truncated = false;
  const calls = new Map<number, { id?: string; name?: string; args: string }>();

  const push = (payload: unknown): string | null => {
    if (payload === null || typeof payload !== 'object') {
      return null;
    }
    const choice = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choice) || choice.length === 0) {
      return null;
    }
    const first = choice[0] as {
      delta?: { content?: unknown; tool_calls?: unknown };
      finish_reason?: unknown;
    };
    if (first.finish_reason === 'length') {
      truncated = true;
    }
    for (const raw of Array.isArray(first.delta?.tool_calls) ? first.delta.tool_calls : []) {
      if (raw === null || typeof raw !== 'object') {
        continue;
      }
      const fragment = raw as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const index = typeof fragment.index === 'number' ? fragment.index : 0;
      const merged = calls.get(index) ?? { args: '' };
      if (typeof fragment.id === 'string' && fragment.id !== '' && merged.id === undefined) {
        merged.id = fragment.id;
      }
      if (
        typeof fragment.function?.name === 'string' &&
        fragment.function.name !== '' &&
        merged.name === undefined
      ) {
        merged.name = fragment.function.name;
      }
      const args = fragment.function?.arguments;
      if (typeof args === 'string') {
        merged.args += args;
      } else if (args !== undefined && args !== null) {
        // A loose server sends the whole object in one fragment.
        merged.args += JSON.stringify(args);
      }
      calls.set(index, merged);
    }
    const delta = first.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      text += delta;
      return delta;
    }
    return null;
  };

  const result = (): AssembledReply => ({
    text,
    toolCalls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, merged]) => ({
        id: merged.id ?? `call-${index}`,
        type: 'function',
        function: {
          name: merged.name ?? '',
          arguments: defaultArguments(merged.args),
        },
      })),
    truncated,
  });

  return { push, result };
}

/**
 * The Anthropic-Messages shape: a `content_block_start` opens a `text`
 * or `tool_use` block per `index`; `content_block_delta` appends
 * `text_delta` text or `input_json_delta.partial_json` to the block the
 * index names; `message_delta` carries the stop reason
 * (`max_tokens` = cut off by the output limit).
 */
export function createAnthropicEventSink(): StreamSink {
  type Block = TextBlock | ToolBlock;
  let truncated = false;
  const blocks = new Map<number, Block>();
  const order: number[] = [];

  const lazy = (index: number, create: () => Block): Block => {
    if (!blocks.has(index)) {
      // A delta without its start (a server that skips the events it
      // considers noise): the block is created on demand.
      blocks.set(index, create());
      order.push(index);
    }
    return blocks.get(index)!;
  };

  const push = (payload: unknown): string | null => {
    if (payload === null || typeof payload !== 'object') {
      return null;
    }
    const event = payload as {
      type?: unknown;
      index?: unknown;
      content_block?: { type?: unknown; text?: unknown; id?: unknown; name?: unknown };
      delta?: { type?: unknown; text?: unknown; partial_json?: unknown; stop_reason?: unknown };
    };
    if (event.type === 'content_block_start' && typeof event.index === 'number') {
      const started = event.content_block;
      if (started?.type === 'tool_use') {
        blocks.set(event.index, {
          kind: 'tool_use',
          ...(typeof started.id === 'string' && started.id !== '' ? { id: started.id } : {}),
          ...(typeof started.name === 'string' && started.name !== '' ? { name: started.name } : {}),
          json: '',
        });
      } else {
        blocks.set(event.index, { kind: 'text', text: typeof started?.text === 'string' ? started.text : '' });
      }
      if (!order.includes(event.index)) {
        order.push(event.index);
      }
      if (started?.type === 'text' && typeof started.text === 'string' && started.text.length > 0) {
        return started.text;
      }
      return null;
    }
    if (event.type === 'content_block_delta' && typeof event.index === 'number') {
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        const target = lazy(event.index, (): TextBlock => ({ kind: 'text', text: '' }));
        if (target.kind !== 'text') {
          return null;
        }
        target.text += event.delta.text;
        return event.delta.text.length > 0 ? event.delta.text : null;
      }
      if (
        event.delta?.type === 'input_json_delta' &&
        typeof event.delta.partial_json === 'string'
      ) {
        const target = lazy(event.index, (): ToolBlock => ({ kind: 'tool_use', json: '' }));
        if (target.kind !== 'tool_use') {
          return null;
        }
        target.json += event.delta.partial_json;
        return null;
      }
      return null;
    }
    if (event.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') {
      truncated = true;
    }
    return null;
  };

  const result = (): AssembledReply => {
    const ordered = order.map((index) => blocks.get(index)!);
    const text = ordered
      .filter((block): block is TextBlock => block.kind === 'text')
      .map((block) => block.text)
      .join('');
    let n = 0;
    const toolCalls: ChatToolCall[] = ordered
      .filter((block): block is ToolBlock => block.kind === 'tool_use')
      .map((block) => ({
        id: block.id ?? `call-${n++}`,
        type: 'function',
        function: { name: block.name ?? '', arguments: defaultArguments(block.json) },
      }));
    return { text, toolCalls, truncated };
  };

  return { push, result };
}
