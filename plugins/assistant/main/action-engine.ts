/**
 * The assistant plugin's action engine (ADR-0044 stage 7) — the
 * pre-conversion `ActionRunner` (`electron/llm/action-runner.ts`) with its
 * dependencies narrowed to what the base `ctx.llm` facade hands out: a
 * config getter (app-config is base) and one completion call. The task
 * registry/abort plumbing lives base-side (`llm.cancelTask` by taskId);
 * the vault tool loop is an option on that call, so the engine never sees
 * the `VaultTools` instance.
 */
import {
  ActionContext,
  ActionOutcome,
  AskOutcome,
  ChatMessage,
  parseJsonObject,
  ResolvedAction,
  resolveActions,
} from '../../../shared/llm';
import {
  AppConfig,
  NOTE_SUMMARY_PROMPT,
  SEARCH_SUMMARY_PROMPT,
} from '../../../shared/app-config';
import { pickPreviewStyle } from '../../../shared/text-diff';

/** The message a cancelled generation reports (kept in step with the base transport). */
const CANCELLED_MESSAGE = 'Generation cancelled.';

/** One completion call with an optional vault tool loop; abort via `taskId`. */
export type ChatFn = (
  messages: readonly ChatMessage[],
  options?: { taskId?: string; vaultTools?: boolean },
) => Promise<string>;

const GENERIC_SYSTEM_SUFFIX =
  '\n\nReturn the complete, revised Markdown document — no code fence, no explanation.';

const ASK_SYSTEM = `You are working on a Markdown document. The user either asks a question about it or gives an instruction to change it.

Respond ONLY with JSON, no prose around it:
- Question (answer only, change nothing): {"kind":"answer","text":"<answer>"}
- Change: {"kind":"edit","document":"<the full changed document>"}

For a change you ALWAYS return the whole document, not just the changed part.
Earlier turns of this conversation are shown as plain text; your reply must still be one of the JSON forms above.`;

/** Appended to `ASK_SYSTEM` when the vault tool set is available (ADR-0021). */
const ASK_TOOLS_NOTE = `You may call the vault tools (vault_search, vault_read, vault_write) to look things up in the wider vault or to make changes elsewhere before you give your final JSON answer. A vault_write is confirmed by the user unless the app is in YOLO mode.`;

/** Kept small so a long thread cannot crowd the document out of context. */
const MAX_HISTORY_MESSAGES = 12;

export class ActionEngine {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly chat: ChatFn,
  ) {}

  /** Enabled actions for a trigger event (the on-save hook's enumeration). */
  actionsForEvent(event: 'on-save'): ResolvedAction[] {
    return resolveActions(this.getConfig()).filter((a) => a.enabled && a.event === event);
  }

  async run(triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome> {
    const action = resolveActions(this.getConfig()).find((a) => a.triggerId === triggerId);
    if (!action) {
      return { kind: 'error', triggerId, name: 'Unknown action', message: 'Action not found.' };
    }
    if (!this.getConfig().llm.enabled) {
      return { kind: 'error', triggerId, name: action.name, message: 'LLM features are disabled.' };
    }
    try {
      if (action.builtin === 'note-summary') {
        // Its result is a panel card, not a document rewrite. Running it
        // as a generic action would replace the note with its own summary,
        // so a trigger pointed at it is refused rather than obeyed.
        return noop(action, 'The note summary is produced by the assistant panel, not as an edit.');
      }
      return await this.runGeneric(action, context, taskId);
    } catch (err) {
      // Cancelling is the user's decision, not a failure -- it reports as a
      // noop so the UI says "cancelled" rather than showing a red error.
      return isAbort(err)
        ? noop(action, CANCELLED_MESSAGE)
        : {
            kind: 'error',
            triggerId,
            name: action.name,
            message: err instanceof Error ? err.message : String(err),
          };
    }
  }

  /**
   * The note assistant's automatic summary: the note in, one short
   * paragraph out. Uses the `note-summary` built-in template's prompt, so
   * the wording is editable in Settings -> Actions like every other
   * built-in and nothing is duplicated. Throws (rather than returning a
   * `noop`) so the panel can put the reason on the card slot -- there is
   * no confirmation flow involved here.
   */
  async summarize(context: ActionContext, taskId?: string): Promise<string> {
    if (!this.getConfig().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    const template = this.getConfig()
      .actions.templates.find((entry) => entry.builtin === 'note-summary');
    const body = context.body.trim();
    if (body === '') {
      throw new Error('This note is empty -- nothing to summarise yet.');
    }
    const reply = await this.chat(
      [
        { role: 'system', content: template?.prompt ?? NOTE_SUMMARY_PROMPT },
        { role: 'user', content: body },
      ],
      { taskId },
    );
    const text = reply.trim();
    if (text === '') {
      throw new Error('The model returned an empty summary.');
    }
    return text;
  }

  /** Chat Ask mode: an answer to display, or an edit to confirm. */
  async ask(
    context: ActionContext,
    question: string,
    taskId?: string,
    history?: ChatMessage[],
  ): Promise<AskOutcome> {
    if (!this.getConfig().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    // The renderer already shapes and caps the thread (`historyForAsk`);
    // the slice here is defence in depth against an over-long payload.
    const prior = (history ?? []).slice(-MAX_HISTORY_MESSAGES);
    const toolsOn = this.getConfig().mcp.enabled;
    const messages: ChatMessage[] = [
      { role: 'system', content: toolsOn ? `${ASK_SYSTEM}\n${ASK_TOOLS_NOTE}` : ASK_SYSTEM },
      ...prior,
      { role: 'user', content: buildAskUserMessage(context, question) },
    ];
    const reply = await this.chat(messages, { taskId, ...(toolsOn ? { vaultTools: true } : {}) });
    const obj = parseJsonObject(reply);

    if (obj?.['kind'] === 'edit' && typeof obj['document'] === 'string') {
      const after = normalizeDoc(obj['document']);
      return {
        kind: 'edit',
        before: context.body,
        after,
        previewStyle: pickPreviewStyle(context.body, after),
        summary: question.trim(),
      };
    }
    const text = typeof obj?.['text'] === 'string' ? obj['text'] : reply.trim();
    return { kind: 'answer', text };
  }

  private async runGeneric(
    action: ResolvedAction,
    context: ActionContext,
    taskId?: string,
  ): Promise<ActionOutcome> {
    const user = context.selection
      ? `SELECTED SECTION:\n${context.selection}\n\nWHOLE DOCUMENT:\n${context.body}`
      : context.body;
    const reply = await this.chat(
      [
        { role: 'system', content: action.prompt + GENERIC_SYSTEM_SUFFIX },
        { role: 'user', content: user },
      ],
      { taskId },
    );
    const after = normalizeDoc(reply);
    if (after.trim() === context.body.trim()) {
      return noop(action, 'The model returned the document unchanged.');
    }
    return {
      kind: 'edit',
      triggerId: action.triggerId,
      name: action.name,
      previewStyle: action.resultKind,
      path: context.path,
      before: context.body,
      after,
      summary: action.name,
    };
  }
}

function noop(action: ResolvedAction, message: string): ActionOutcome {
  return { kind: 'noop', triggerId: action.triggerId, name: action.name, message };
}

/**
 * Whether a rejection is "the user pressed Cancel". The abort surfaces as
 * an `AbortError` from the base transport's fetch.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Strip an outer ```/```markdown fence a model may add, normalise EOL, one trailing newline. */
function normalizeDoc(text: string): string {
  let out = text.replace(/\r\n/g, '\n').trim();
  const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
  if (fence) {
    out = fence[1].trim();
  }
  return `${out}\n`;
}

function buildAskUserMessage(context: ActionContext, question: string): string {
  const parts = [`INSTRUCTION / QUESTION:\n${question.trim()}`];
  if (context.selection?.trim()) {
    parts.push(`CURRENT SELECTION:\n${context.selection}`);
  }
  parts.push(`DOCUMENT (${context.path}):\n${context.body}`);
  return parts.join('\n\n');
}
