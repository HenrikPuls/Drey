/**
 * Pure adapters between the canonical shapes (`ChatMessage`, `ToolSpec`,
 * `ChatAttachment` -- this module) and the two HTTP wire dialects
 * (ADR-0047). No I/O: this is exactly the fragile part ADR-0007 wants
 * under the Vitest suite, so it lives in `shared/llm` rather than beside
 * the providers. The providers apply these, then do the HTTP.
 */
import { ChatAttachment, ChatMessage, ChatToolCall, ToolSpec } from './llm';

// -- OpenAI -----------------------------------------------------------------

/** The OpenAI `tools` entry: a thin wrapper around the canonical spec. */
export interface OpenAiToolWire {
  type: 'function';
  function: { name: string; description: string; parameters: ToolSpec['parameters'] };
}

export function toOpenAiTools(specs: readonly ToolSpec[]): OpenAiToolWire[] {
  return specs.map((spec) => ({
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.parameters },
  }));
}

/** One OpenAI content part: text, or a data-URL image for vision models. */
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Builds the `content` for the LAST user message: the plain string when no
 * attachments were passed (the shape every text-only server expects), or a
 * mixed part array -- images first, then the text -- for vision models.
 */
export function buildOpenAiUserContent(
  text: string,
  attachments?: readonly ChatAttachment[],
): string | OpenAiContentPart[] {
  if (!attachments || attachments.length === 0) {
    return text;
  }
  return [
    ...attachments.map(
      (attachment): OpenAiContentPart => ({
        type: 'image_url',
        image_url: { url: `data:${attachment.mediaType};base64,${attachment.base64}` },
      }),
    ),
    { type: 'text', text },
  ];
}

// -- Anthropic Messages ------------------------------------------------------

/** Anthropic content blocks: the subset this app emits. */
export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: AnthropicBlock[] };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export interface AnthropicToolsWire {
  name: string;
  description: string;
  input_schema: ToolSpec['parameters'];
}

export function toAnthropicTools(specs: readonly ToolSpec[]): AnthropicToolsWire[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }));
}

/** Parsed `arguments` JSON, or `{}` when the model sent unparseable/empty args. */
function parseToolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toAnthropicToolUse(call: ChatToolCall): AnthropicBlock {
  return {
    type: 'tool_use',
    id: call.id,
    name: call.function.name,
    input: parseToolInput(call.function.arguments),
  };
}

/**
 * Maps the canonical OpenAI-shaped transcript onto Anthropic Messages:
 * `system` messages lift out into the top-level `system` string (the API
 * takes it as a parameter, not a message), `tool` turns become
 * `tool_result` blocks inside a user message, and assistant `tool_calls`
 * become `tool_use` blocks with parsed `input`. Consecutive same-role
 * entries are merged -- Anthropic requires strictly alternating roles, and
 * a [tool_use -> tool_result] exchange otherwise collapses into
 * [assistant, user, user]. Images ride on the final user turn (the one
 * being answered).
 */
export function toAnthropicMessages(
  messages: readonly ChatMessage[],
  attachments?: readonly ChatAttachment[],
): { system: string | null; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    out.push({ role, content: blocks });
  };

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  for (const message of messages) {
    const isLastUserTurn =
      message === lastMessage && message.role === 'user' && !!message.content;
    switch (message.role) {
      case 'system':
        if (message.content !== null && message.content !== '') {
          systemParts.push(message.content);
        }
        break;
      case 'user': {
        const blocks: AnthropicBlock[] = [];
        if (isLastUserTurn && attachments && attachments.length > 0) {
          for (const attachment of attachments) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: attachment.mediaType,
                data: attachment.base64,
              },
            });
          }
        }
        if (message.content !== null && message.content !== '') {
          blocks.push({ type: 'text', text: message.content });
        }
        if (blocks.length > 0) {
          push('user', blocks);
        }
        break;
      }
      case 'assistant': {
        const blocks: AnthropicBlock[] = [];
        if (message.content !== null && message.content !== '') {
          blocks.push({ type: 'text', text: message.content });
        }
        for (const call of message.tool_calls ?? []) {
          blocks.push(toAnthropicToolUse(call));
        }
        if (blocks.length > 0) {
          push('assistant', blocks);
        }
        break;
      }
      case 'tool': {
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id ?? '',
            content: [{ type: 'text', text: message.content ?? '' }],
          },
        ]);
        break;
      }
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : null, messages: out };
}

// -- CLI dialects ------------------------------------------------------------

/**
 * Flattens the canonical transcript into one prompt string for a CLI
 * backend that has no message-array wire format (`claude -p`, `copilot -p`):
 * system parts become an `Instructions:` block, the turns a `User:` /
 * `Assistant:` transcript. Drey-side tool activity survives as bracketed
 * lines (the call with its arguments, the result with its id) so a replayed
 * conversation keeps its tool context in readable form.
 */
export function flattenMessages(messages: readonly ChatMessage[]): string {
  const system: string[] = [];
  const turns: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        if (message.content !== null && message.content !== '') {
          system.push(message.content);
        }
        break;
      case 'user':
        if (message.content !== null && message.content !== '') {
          turns.push(`User: ${message.content}`);
        }
        break;
      case 'assistant': {
        const parts: string[] = [];
        if (message.content !== null && message.content !== '') {
          parts.push(message.content);
        }
        for (const call of message.tool_calls ?? []) {
          parts.push(`[tool call ${call.function.name}(${call.function.arguments})]`);
        }
        if (parts.length > 0) {
          turns.push(`Assistant: ${parts.join('\n')}`);
        }
        break;
      }
      case 'tool':
        turns.push(`Tool result (${message.tool_call_id ?? 'unknown'}): ${message.content ?? ''}`);
        break;
    }
  }
  const blocks: string[] = [];
  if (system.length > 0) {
    blocks.push(`Instructions:\n${system.join('\n\n')}`);
  }
  if (turns.length > 0) {
    blocks.push(turns.join('\n\n'));
  }
  return blocks.join('\n\n');
}
