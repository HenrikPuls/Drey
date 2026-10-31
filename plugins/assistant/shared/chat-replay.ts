/**
 * The replay builder (ADR-0048): a chat note is the conversation's source
 * of truth, so a follow-up sends the FULL persisted history — that is the
 * bug-10(b) resolution. Tool calls/results stored as `drey-tool` entries
 * replay as real `assistant(tool_calls)` / `tool` message pairs, and an
 * applied edit replays with its document so the model knows what it
 * changed. The one exception is the synthetic post-hoc task pair (57b/57c):
 * the model never made that call, so it replays as a text note after the
 * answer instead of a `tool_calls`/`tool` pair. Providers with `sessions`
 * capability (claude-code `--resume`) skip all of this and send only the
 * new turn — that decision lives in `main/chat-engine.ts`; this module is
 * the pure full-replay half.
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
import { compactContextLine } from './vault-context.js';

/** The assistant's task lookup tool (`TASKS_LIST_TOOL_NAME` in `main/tasks-tool.ts`). */
const TASKS_LIST_NAME = 'tasks_list';

/** The id prefix the engine gives a synthetic post-hoc pair (`main/chat-engine.ts`). */
const POSTHOC_ID_PREFIX = 'tasks-posthoc-';

/**
 * Whether a persisted `call` entry is the synthetic post-hoc task block
 * (57b/57c): the app showed the user a task list the MODEL never asked a
 * tool for. Replaying it as a call would teach the model it made a call
 * it did not make — so the pair replays as a text note instead. Both
 * markers the engine writes count (the id prefix, `posthoc: true` in the
 * arguments), whichever survived the note round-trip.
 */
function isPosthocTasksCall(entry: Extract<ChatToolEntry, { kind: 'call' }>): boolean {
  if (entry.name !== TASKS_LIST_NAME) {
    return false;
  }
  if (entry.id.startsWith(POSTHOC_ID_PREFIX)) {
    return true;
  }
  const args: unknown =
    typeof entry.arguments === 'string' ? safelyParseJson(entry.arguments) : entry.arguments;
  return args !== null && typeof args === 'object' && (args as { posthoc?: unknown }).posthoc === true;
}

function safelyParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The text note a post-hoc pair replays as: what the user was shown,
 * after the answer it followed, through the same 2 000-character cap as
 * a replayed tool result.
 */
function posthocNote(records: string): string {
  return `[After your answer, the app showed the user this task list — you did not call a tool for it: ${replayedResult(records)}]`;
}

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
      out.push({ role: 'assistant', content: withContextLine(turn.text, turn) });
    } else if (turn.context.length > 0) {
      out.push({ role: 'assistant', content: compactContextLine(turn.context) });
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

  // The synthetic post-hoc task pair (57b/57c): its call never happened,
  // so it must not replay as one — the result becomes a text note after
  // the answer instead. The pair is dropped from the tool replay
  // TOGETHER: a `tool` message whose `tool_call_id` has no call is a
  // 400 on strict endpoints.
  const posthocResults: string[] = [];
  let pendingPosthocId: string | null = null;

  for (const entry of turn.tool) {
    switch (entry.kind) {
      case 'call':
        if (isPosthocTasksCall(entry)) {
          pendingPosthocId = entry.id;
          continue;
        }
        pendingCalls.push({
          id: entry.id,
          type: 'function',
          function: { name: entry.name, arguments: stringifyArguments(entry.arguments) },
        });
        break;
      case 'result':
        if (pendingPosthocId !== null && entry.id === pendingPosthocId) {
          posthocResults.push(entry.content);
          pendingPosthocId = null;
          continue;
        }
        flushCalls();
        out.push({ role: 'tool', tool_call_id: entry.id, content: replayedResult(entry.content) });
        break;
      case 'edit':
        flushCalls();
        out.push({ role: 'assistant', content: editText(entry) });
        break;
    }
  }
  flushCalls();

  const posthoc =
    posthocResults.length > 0 ? posthocResults.map(posthocNote).join('\n\n') : null;

  // The turn's text after the tool sequence is the model's answer — unless
  // it is the edit-proposal stand-in, which the edit entries already carry.
  if (turn.text !== '' && !turn.text.startsWith(EDIT_PROPOSAL_MARKER)) {
    const answer = withContextLine(turn.text, turn);
    out.push({ role: 'assistant', content: posthoc !== null ? appendLine(answer, posthoc) : answer });
  } else if (turn.text === '' && turn.context.length > 0) {
    // A retrieval-only turn (no answer text survived): the citation line
    // still tells the model what it saw.
    const line = compactContextLine(turn.context);
    out.push({ role: 'assistant', content: posthoc !== null ? appendLine(line, posthoc) : line });
  } else if (posthoc !== null) {
    out.push({ role: 'assistant', content: posthoc });
  }
}

/** What a tool result of an earlier turn may take up in the replay. */
export const REPLAY_RESULT_MAX_CHARS = 2000;

/**
 * A tool result of an EARLIER turn, as the model sees it again (ADR-0071).
 * The note keeps every result in full, and the model read it in full when
 * it answered; resending all of it with every later question is what
 * fills a small model's context. The cut says how to get the rest.
 */
function replayedResult(content: string): string {
  if (content.length <= REPLAY_RESULT_MAX_CHARS) {
    return content;
  }
  return `${content.slice(0, REPLAY_RESULT_MAX_CHARS)}\n[… shortened in the history: ${content.length - REPLAY_RESULT_MAX_CHARS} more characters — call the tool again if you need them]`;
}

/**
 * Older turns' retrieved sections are NOT replayed as text — that would
 * grow every follow-up (the small-model budget). One compact line names
 * what was consulted instead (ADR-0055).
 */
function withContextLine(text: string, turn: ChatNoteTurn): string {
  if (turn.context.length === 0) {
    return text;
  }
  return `${text}\n\n${compactContextLine(turn.context)}`;
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
