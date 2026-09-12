/**
 * Shared LLM plumbing used by both the classifier
 * (`specs/classifier-spec.md`) and the chat Ask mode -- the message shape
 * for the OpenAI-compatible `/chat/completions` call, the provider-neutral
 * result/tool/capability shapes behind the `LlmClient` abstraction
 * (ADR-0047), and a tolerant JSON extractor.
 *
 * Pure, no I/O: the providers in `electron/llm/providers/` do the HTTP
 * (and the spawning), this file only shapes requests and picks apart
 * replies, so the Vitest suite covers the fragile part (`electron/` is a
 * thin sequencer, ADR-0007). Must stay free of `shared/ipc-api.ts`
 * imports -- that file type-imports this one.
 */

/** An OpenAI-style tool call the model asked for. */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * One message in an OpenAI-compatible chat request. `content` is `null`
 * on an assistant turn that only carries `tool_calls`; a `tool` turn
 * carries the tool's result plus the `tool_call_id` it answers.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/*
 * Provider-neutral shapes (ADR-0047). `ChatMessage` above stays the
 * canonical internal message format -- OpenAI-shaped, because it is the
 * native dialect of the largest provider family and the currency on both
 * sides of the plugin IPC; the Anthropic conversion is a pure adapter in
 * `electron/llm/providers/tool-adapters.ts`. These types describe
 * everything that travels AROUND the messages: tools, attachments, and
 * what comes back.
 */

/** JSON-Schema object describing a tool's parameters. The vault tool defs already conform. */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * Canonical tool description handed to `chat()`. OpenAI's wire format is a
 * thin wrapper around exactly this; Anthropic renames `parameters` to
 * `input_schema`; CLI providers render it as text (or ignore it -- they
 * declare `tools: false`). MCP tools arrive namespaced:
 * `mcp__<serverId>__<toolName>`.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParameters;
}

/**
 * An image attached to the outgoing user turn, already resolved to bytes
 * by the caller (providers stay vault-ignorant: they embed what they are
 * given and never touch the file system). The chat note references the
 * source file by path separately -- this shape is wire-only.
 */
export interface ChatAttachment {
  kind: 'image';
  /** `image/png` | `image/jpeg` | `image/webp` | `image/gif`. */
  mediaType: string;
  /** Raw file bytes, base64-encoded. */
  base64: string;
}

/** Token accounting, opportunistically filled by the provider when its API reports usage. */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * What a completed `chat()` returns. `text` is `''` when the model
 * returned nothing usable (the old plain-string contract, kept).
 * `sessionRef` carries a provider-side conversation handle (Claude Code's
 * session id) out of the call; passing it back via
 * `options.sessionRef` continues that conversation instead of replaying
 * history. `usage` feeds future context-window policy.
 */
export interface LlmChatResult {
  text: string;
  sessionRef?: string;
  usage?: LlmUsage;
}

/**
 * What a provider can and cannot do. Providers DECLARE their gaps instead
 * of the interface growing per-provider flags; callers degrade by
 * capability (e.g. tools are not offered to a provider with
 * `tools: false`).
 */
export interface LlmCapabilities {
  /** `options.tools` is honoured -- Drey runs the tool loop. */
  readonly tools: boolean;
  /** `onDelta` fires incrementally (non-streamers still call it once). */
  readonly streaming: boolean;
  /** `options.sessionRef` is honoured and the result carries `sessionRef`. */
  readonly sessions: boolean;
  /** `listModels()` talks to a real endpoint (CLI/web providers: `false`). */
  readonly modelListing: boolean;
  /** `options.attachments` images are sent as vision content parts. */
  readonly imageAttachments: boolean;
}

/**
 * Small local models occasionally wrap their JSON in a ```json fence or
 * surround it with a sentence of prose, even when told not to
 * (`specs/classifier-spec.md`, "enforcing structured output"). This pulls
 * out the first balanced top-level `{...}` object and returns it, or
 * `null` when there is nothing parseable. It does NOT `JSON.parse` -- the
 * caller does, so it can validate the shape it expects.
 */
export function extractJsonObject(reply: string): string | null {
  if (!reply) {
    return null;
  }
  const start = reply.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < reply.length; i++) {
    const ch = reply[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return reply.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** `extractJsonObject` + `JSON.parse`, returning `null` on any failure. */
export function parseJsonObject(reply: string): Record<string, unknown> | null {
  const raw = extractJsonObject(reply);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
