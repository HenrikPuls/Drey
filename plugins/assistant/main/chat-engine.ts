/**
 * The chat engine (ADR-0048): the ask flow against a chat note — the
 * bug-10(b) resolution. The note IS the conversation's source of truth:
 * every turn is appended before/after the call, a follow-up replays the
 * FULL persisted history (tool calls/results as real message pairs,
 * applied edits with their document), and only a provider-side session
 * (claude-code `--resume`) skips the replay. The old sidecar thread and
 * its ~12-message cap are gone for conversations.
 *
 * Failure semantics: a failed or cancelled generation truncates back the
 * just-appended user turn, so the note only ever shows completed
 * exchanges (the renderer keeps the question text for a re-send). A
 * resumed provider session that has gone stale gets ONE full-replay
 * retry before the failure surfaces.
 */
import type { ChatAttachment, ChatMessage, LlmChatResult } from '../../../shared/llm';
import { AskOutcome, parseJsonObject } from '../../../shared/llm';
import { pickPreviewStyle } from '../../../shared/text-diff';
import { formatDateTime } from '../../../shared/timestamp';
import type { AppConfig } from '../../../shared/app-config';
import type { LlmCapabilities } from '../../../shared/llm';
import type { AskRequest } from '../shared/ask';
import {
  ChatNoteAttachment,
  ChatNoteTurn,
  EDIT_PROPOSAL_MARKER,
  toolEntriesFromTrace,
} from '../shared/chat-note.js';
import { buildReplayMessages } from '../shared/chat-replay.js';
import { ChatStore } from './chat-store';
import {
  ASK_ANSWER_SYSTEM,
  ASK_SYSTEM,
  ASK_TOOLS_NOTE,
  buildAskUserMessage,
  editCatchUpLine,
} from './ask-prompts';
import { isAbort, normalizeDoc } from './action-engine';

/** One completion call with the engine's needs; abort via `taskId` (ADR-0014). */
export type ChatFn = (
  messages: readonly ChatMessage[],
  options?: {
    taskId?: string;
    vaultTools?: boolean;
    sessionRef?: string;
    attachments?: ChatAttachment[];
    onDelta?: (text: string) => void;
  },
) => Promise<LlmChatResult>;

export interface ChatEnginePorts {
  /** Vault text read for attachment re-hydration; `null` = missing/unreadable. */
  readVaultText(path: string): Promise<string | null>;
  resolveAssetPath(path: string): string | null;
  readAssetBase64(absPath: string): Promise<string | null>;
  /** Delta forwarding to the panel (the plugin's own `chat:delta` event). */
  onDelta(taskId: string, text: string): void;
}

export interface ChatAskResult {
  chatPath: string;
  outcome: AskOutcome;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export class ChatEngine {
  constructor(
    private readonly store: ChatStore,
    private readonly getConfig: () => AppConfig,
    private readonly chat: ChatFn,
    private readonly capabilities: () => LlmCapabilities,
    private readonly ports: ChatEnginePorts,
  ) {}

  async ask(request: AskRequest, taskId?: string): Promise<ChatAskResult> {
    const config = this.getConfig();
    if (!config.llm.enabled) {
      throw new Error('LLM features are disabled.');
    }

    // 1 · The chat note: continue the given one, or create one titled by
    // the first question.
    let chatPath = request.chatPath;
    let created = false;
    if (chatPath === null) {
      const fresh = await this.store.create(
        new Date(),
        request.question,
        config.llm.provider,
        config.llm.model,
      );
      chatPath = fresh.path;
      await this.store.save(fresh.path, fresh.content);
      created = true;
    }
    const view = await this.store.read(chatPath);

    // 2 · The user turn (question + attachment PATHS; bodies ride the
    // message only) is persisted BEFORE the call — a crash leaves a
    // dangling question, which the replay pops.
    const attachments: ChatNoteAttachment[] = [
      ...(request.note !== null ? [{ kind: 'note' as const, path: request.note.path }] : []),
      ...request.extraFiles.map((file) => ({ kind: 'note' as const, path: file.path })),
      ...request.images.map((path) => ({ kind: 'image' as const, path, alt: '' })),
    ];
    const userTurnIndex = view.turns.length;
    await this.store.appendTurn(chatPath, {
      role: 'user',
      at: formatDateTime(new Date()),
      meta: {},
      text: request.question,
      attachments,
      tool: [],
      start: 0,
    });

    // 3 · Session-vs-replay: a provider-side session continues with just
    // the new turn; everything else full-replays from the note.
    const caps = this.capabilities();
    const resume =
      !created &&
      caps.sessions &&
      view.frontmatter.session !== null &&
      view.frontmatter.provider === config.llm.provider;

    const toolsOn = config.mcp.enabled;
    const answerOnly = request.note === null;
    const system = answerOnly ? ASK_ANSWER_SYSTEM : ASK_SYSTEM;
    const baseMessages: ChatMessage[] = [
      { role: 'system', content: toolsOn ? `${system}\n${ASK_TOOLS_NOTE}` : system },
    ];
    const catchUp = resume ? this.catchUpLine(view) : '';
    const userBody = buildAskUserMessage(request);
    const questionMessage: ChatMessage = {
      role: 'user',
      content: catchUp === '' ? userBody : `${catchUp}\n\n${userBody}`,
    };

    const buildMessages = async (useSession: boolean): Promise<ChatMessage[]> => {
      if (useSession) {
        return [...baseMessages, questionMessage];
      }
      const replay = await buildReplayMessages(view.turns, (path) =>
        this.ports.readVaultText(path),
      );
      return [...baseMessages, ...replay.messages, questionMessage];
    };

    const imageAttachments =
      caps.imageAttachments && request.images.length > 0
        ? await this.readImageAttachments(request.images)
        : undefined;
    const options = (useSession: boolean) => ({
      taskId,
      ...(toolsOn ? { vaultTools: true } : {}),
      ...(useSession && view.frontmatter.session !== null
        ? { sessionRef: view.frontmatter.session }
        : {}),
      ...(imageAttachments !== undefined && imageAttachments.length > 0
        ? { attachments: imageAttachments }
        : {}),
      ...(taskId !== undefined
        ? { onDelta: (text: string) => this.ports.onDelta(taskId, text) }
        : {}),
    });

    // 4 · One call (one full-replay retry when a resumed session went stale).
    const startedAt = Date.now();
    let result;
    try {
      result = await this.chat(await buildMessages(resume), options(resume));
    } catch (err) {
      if (resume && !isAbort(err)) {
        try {
          result = await this.chat(await buildMessages(false), options(false));
        } catch (retryErr) {
          await this.store.truncateFrom(chatPath, userTurnIndex);
          throw retryErr;
        }
      } else {
        await this.store.truncateFrom(chatPath, userTurnIndex);
        throw err;
      }
    }
    const durationMs = Date.now() - startedAt;

    // 5 · The reply: an answer to display, or an edit to confirm (the
    // outcome — applied document or discarded marker — is appended to the
    // turn's fence by `chat:appendEdit` after the user's decision).
    const obj = parseJsonObject(result.text);
    let outcome: AskOutcome;
    if (request.note !== null && obj?.['kind'] === 'edit' && typeof obj['document'] === 'string') {
      const body = request.note.body;
      const after = normalizeDoc(obj['document']);
      outcome = {
        kind: 'edit',
        before: body,
        after,
        previewStyle: pickPreviewStyle(body, after),
        summary: request.question.trim(),
      };
    } else {
      const text = typeof obj?.['text'] === 'string' ? obj['text'] : result.text.trim();
      outcome = { kind: 'answer', text };
    }

    // 6 · The assistant turn: text, meta, and the tool trace as drey-tool
    // entries — this is what makes the NEXT turn able to replay the loop.
    const assistantTurn: ChatNoteTurn = {
      role: 'assistant',
      at: formatDateTime(new Date()),
      meta: {
        ...(config.llm.model ? { model: config.llm.model } : {}),
        durationMs,
      },
      text:
        outcome.kind === 'answer'
          ? outcome.text
          : request.note !== null
            ? `${EDIT_PROPOSAL_MARKER} \`${request.note.path}\`]`
            : '',
      attachments: [],
      tool: toolEntriesFromTrace(result.toolTrace),
      start: 0,
    };
    await this.store.appendTurn(chatPath, assistantTurn, {
      ...(config.llm.model ? { model: config.llm.model } : {}),
      ...(result.sessionRef !== undefined ? { session: result.sessionRef } : {}),
    });

    return { chatPath, outcome };
  }

  /** For a resumed session: the confirm result it never saw (one line). */
  private catchUpLine(view: { turns: ChatNoteTurn[] }): string {
    for (let i = view.turns.length - 1; i >= 0; i--) {
      const turn = view.turns[i];
      if (turn.role !== 'assistant') {
        break;
      }
      const edit = [...turn.tool].reverse().find((entry) => entry.kind === 'edit');
      if (edit && edit.kind === 'edit') {
        return editCatchUpLine(edit.path, edit.applied);
      }
    }
    return '';
  }

  /** Vault images → base64 attachments; missing/unreadable ones are skipped. */
  private async readImageAttachments(paths: readonly string[]): Promise<ChatAttachment[]> {
    const out: ChatAttachment[] = [];
    for (const path of paths) {
      const abs = this.ports.resolveAssetPath(path);
      if (abs === null) {
        continue;
      }
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[ext];
      if (mediaType === undefined) {
        continue;
      }
      const base64 = await this.ports.readAssetBase64(abs);
      if (base64 === null) {
        continue;
      }
      out.push({ kind: 'image', mediaType, base64 });
    }
    return out;
  }
}
