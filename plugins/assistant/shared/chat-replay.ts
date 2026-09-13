/**
 * The replay builder (ADR-0048): a chat note is the conversation's source
 * of truth, so a follow-up sends the FULL persisted history — that is the
 * bug-10(b) resolution. Tool calls/results stored as `drey-tool` entries
 * replay as real `assistant(tool_calls)` / `tool` message pairs, and an
 * applied edit replays with its document so the model knows what it
 * changed. Providers with `sessions` capability (claude-code `--resume`)
 * skip all of this and send only the new turn — that decision lives in
 * `main/chat-engine.ts`; this module is the pure full-replay half.
 *
 * Attachment BODIES are never persisted in the note (paths are): the
 * injected reader re-reads them fresh at send time, and a vanished file
 * becomes an inline warning line, not a failure. Images from PAST turns
 * degrade to path mentions — vision content parts ride only the current
 * turn (the engine wires those through `options.attachments`).
 */
import type { ChatMessage, ChatToolCall } from '../../../shared/llm';
import {
  ChatNoteTurn,
  EDIT_PROPOSAL_MARKER,
  ChatToolEntry,
} from './chat-note.js';

export interface ReplayResult {
  messages: ChatMessage[];
  /** Human-readable lines about degraded pieces (missing attachments). */
  warnings: string[];
}

/** Reads one attachment path fresh; `null` = missing/unreadable. */
export type AttachmentReader = (path: string) => Promise<string | null>;

export async function buildReplayMessages(
  turns: readonly ChatNoteTurn[],
  readAttachment: AttachmentReader,
): Promise<ReplayResult> {
  const messages: ChatMessage[] = [];
  const warnings: string[] = [];

  // A trailing user turn with no answer is a failed/crashed generation —
  // replaying it would make the model answer the same question twice.
  let end = turns.length;
  while (end > 0 && turns[end - 1].role === 'user') {
    end--;
  }

  for (const turn of turns.slice(0, end)) {
    if (turn.role === 'user') {
      let content = turn.text;
      for (const attachment of turn.attachments) {
        if (attachment.kind === 'image') {
          // Past images degrade to mentions; vision parts ride the current turn only.
          content = appendLine(content, `[image attached: ${attachment.path}]`);
          continue;
        }
        const body = await readAttachment(attachment.path);
        if (body === null) {
          warnings.push(`attachment not found: ${attachment.path}`);
          content = appendLine(
            content,
            `[attachment ${attachment.path} could not be read — it is missing or unreadable]`,
          );
          continue;
        }
        content = appendLine(content, `FILE (${attachment.path}):\n${body}`);
      }
      messages.push({ role: 'user', content });
      continue;
    }
    replayAssistantTurn(turn, messages);
  }

  return { messages, warnings };
}

/** Maps one persisted assistant turn onto messages, in the provider loop's order. */
function replayAssistantTurn(turn: ChatNoteTurn, out: ChatMessage[]): void {
  if (turn.tool.length === 0) {
    if (turn.text !== '') {
      out.push({ role: 'assistant', content: turn.text });
    }
    return;
  }

  let pendingCalls: ChatToolCall[] = [];
  const flushCalls = (): void => {
    if (pendingCalls.length > 0) {
      out.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
      pendingCalls = [];
    }
  };

  for (const entry of turn.tool) {
    switch (entry.kind) {
      case 'call':
        pendingCalls.push({
          id: entry.id,
          type: 'function',
          function: { name: entry.name, arguments: stringifyArguments(entry.arguments) },
        });
        break;
      case 'result':
        flushCalls();
        out.push({ role: 'tool', tool_call_id: entry.id, content: entry.content });
        break;
      case 'edit':
        flushCalls();
        out.push({ role: 'assistant', content: editText(entry) });
        break;
    }
  }
  flushCalls();

  // The turn's text after the tool sequence is the model's answer — unless
  // it is the edit-proposal stand-in, which the edit entries already carry.
  if (turn.text !== '' && !turn.text.startsWith(EDIT_PROPOSAL_MARKER)) {
    out.push({ role: 'assistant', content: turn.text });
  }
}

/** `[Applied change to <path>]` + the document — the model must know what it changed. */
function editText(entry: Extract<ChatToolEntry, { kind: 'edit' }>): string {
  if (entry.applied && entry.after !== undefined) {
    return `[Applied change to ${entry.path}]\n${entry.after}`;
  }
  if (entry.applied) {
    return `[Applied change to ${entry.path}]`;
  }
  return `[A proposed change to ${entry.path} was discarded by the user]`;
}

/** Persisted arguments keep their parsed form when it parsed — stringified back here. */
function stringifyArguments(arguments_: unknown): string {
  if (typeof arguments_ === 'string') {
    return arguments_;
  }
  try {
    return JSON.stringify(arguments_ ?? {});
  } catch {
    return '{}';
  }
}

function appendLine(text: string, line: string): string {
  return text === '' ? line : `${text}\n\n${line}`;
}
