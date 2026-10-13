/**
 * Reads tool calls a model wrote into its reply TEXT instead of the
 * native `tool_calls` field (ADR-0071). Local models served without a
 * matching chat template do this: the call arrives as
 * `<tool_call>{"name":…,"arguments":{…}}</tool_call>` (the Hermes / Qwen
 * convention) or as a fenced JSON object of the same shape. Pure.
 *
 * Conservative on purpose — a reply that merely talks about JSON must
 * stay a reply: a call counts only when its name is one of the tools
 * offered in this request, and the fenced or bare JSON form only when
 * that object is the whole reply.
 */
import type { ChatToolCall } from './llm';

export interface TextToolCalls {
  calls: ChatToolCall[];
  /** The reply with the call markup removed — the prose the model wrote beside it, if any. */
  text: string;
}

const TAG = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
const FENCE = /^\s*```(?:json|tool_call|tool)?\s*\n([\s\S]*?)\n```\s*$/;

function toCall(
  raw: string,
  offered: ReadonlySet<string>,
  index: number,
): ChatToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const fn =
    record['function'] !== null && typeof record['function'] === 'object'
      ? (record['function'] as Record<string, unknown>)
      : record;
  const name = fn['name'];
  if (typeof name !== 'string' || !offered.has(name)) {
    return null;
  }
  const args = fn['arguments'] ?? fn['parameters'] ?? {};
  return {
    id: `text-call-${index}`,
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

/** The tool calls written into `reply`, or `null` when it holds none for an offered tool. */
export function parseTextToolCalls(
  reply: string,
  offered: ReadonlySet<string>,
): TextToolCalls | null {
  if (reply.includes('<tool_call>')) {
    const calls: ChatToolCall[] = [];
    for (const match of reply.matchAll(TAG)) {
      const call = toCall(match[1] ?? '', offered, calls.length);
      if (call !== null) {
        calls.push(call);
      }
    }
    return calls.length > 0 ? { calls, text: reply.replace(TAG, '').trim() } : null;
  }
  const fenced = FENCE.exec(reply);
  const body = fenced !== null ? (fenced[1] ?? '') : reply.trim();
  if (!body.startsWith('{')) {
    return null;
  }
  const call = toCall(body, offered, 0);
  return call !== null ? { calls: [call], text: '' } : null;
}
