/**
 * Shared LLM plumbing used by both the classifier
 * (`specs/classifier-spec.md`) and the chat Ask mode -- the message shape
 * for the OpenAI-compatible `/chat/completions` call, and a tolerant JSON
 * extractor.
 *
 * Pure, no I/O: `electron/lm-studio-client.ts` does the HTTP, this file
 * only shapes requests and picks apart replies, so the Vitest suite covers
 * the fragile part (`electron/` is a thin sequencer, ADR-0007).
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
