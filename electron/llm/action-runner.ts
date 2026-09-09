/**
 * Runs an Action (`shared/app-config.ts`) against the active document and
 * returns an `ActionOutcome` -- for an `'edit'`, a `before`/`after` pair
 * the renderer routes through the one confirmation flow (ADR-0011). Also
 * hosts chat Ask mode and the note assistant's summary, which share the
 * same LLM plumbing.
 */
import {
  ActionEvent,
  AUTOTAG_PROMPT,
  NOTE_SUMMARY_PROMPT,
  SEARCH_SUMMARY_PROMPT,
} from '../../shared/app-config';
import {
  ActionContext,
  ActionOutcome,
  AskOutcome,
  ChatMessage,
  parseJsonObject,
  parseSuggestedTags,
  ResolvedAction,
  resolveActions,
} from '../../shared/llm';
import { pickPreviewStyle } from '../../shared/text-diff';
import { AppConfigStore } from '../app-config';
import type { VaultTools } from '../mcp';
import { CANCELLED_MESSAGE, isAbortError, LlmTaskRegistry } from './llm-tasks';
import { LmStudioClient } from './lm-studio-client';

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

export class ActionRunner {
  constructor(
    private readonly config: AppConfigStore,
    private readonly llm: LmStudioClient,
    private readonly tasks: LlmTaskRegistry,
    /** The vault tool set -- the assistant may call it when `mcp.enabled` (ADR-0021). */
    private readonly vaultTools?: VaultTools,
  ) {}

  /** Aborts a running generation by the id the renderer minted for it. */
  cancel(taskId: string): boolean {
    return this.tasks.cancel(taskId);
  }

  /** Whether LLM features are switched on (`note:save` skips the on-save hook when off). */
  isLlmEnabled(): boolean {
    return this.config.get().llm.enabled;
  }

  /** Enabled actions for a trigger event (used by the `note:save` on-save hook). */
  actionsForEvent(event: ActionEvent): ResolvedAction[] {
    return resolveActions(this.config.get()).filter((a) => a.enabled && a.event === event);
  }

  async run(triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome> {
    const action = resolveActions(this.config.get()).find((a) => a.triggerId === triggerId);
    if (!action) {
      return { kind: 'error', triggerId, name: 'Unknown action', message: 'Action not found.' };
    }
    if (!this.config.get().llm.enabled) {
      return { kind: 'error', triggerId, name: action.name, message: 'LLM features are disabled.' };
    }
    try {
      return await this.tasks.run(taskId, async (signal) => {
        if (action.builtin === 'note-summary') {
          // Its result is a panel card, not a document rewrite. Running it
          // as a generic action would replace the note with its own summary,
          // so a trigger pointed at it is refused rather than obeyed.
          return noop(
            action,
            'The note summary is produced by the assistant panel, not as an edit.',
          );
        }
        return await this.runGeneric(action, context, signal);
      });
    } catch (err) {
      // Cancelling is the user's decision, not a failure -- it reports as a
      // noop so the UI says "cancelled" rather than showing a red error.
      return isAbortError(err)
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
    if (!this.config.get().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    const template = this.config
      .get()
      .actions.templates.find((entry) => entry.builtin === 'note-summary');
    const body = context.body.trim();
    if (body === '') {
      throw new Error('This note is empty -- nothing to summarise yet.');
    }
    const reply = await this.tasks.run(taskId, (signal) =>
      this.llm.chat(
        [
          { role: 'system', content: template?.prompt ?? NOTE_SUMMARY_PROMPT },
          { role: 'user', content: body },
        ],
        { signal },
      ),
    );
    const text = reply.trim();
    if (text === '') {
      throw new Error('The model returned an empty summary.');
    }
    return text;
  }

  /**
   * The tag-search "Summarise" button: the matching sections (already
   * formatted) go in, a prose digest comes out. Uses the editable
   * `search-summary` built-in template. Cancellable via `taskId`; throws so
   * the panel can show the reason.
   */
  async summariseSearchResults(sectionsText: string, taskId?: string): Promise<string> {
    if (!this.config.get().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    if (sectionsText.trim() === '') {
      throw new Error('No results to summarise.');
    }
    const template = this.config
      .get()
      .actions.templates.find((entry) => entry.builtin === 'search-summary');
    const reply = await this.tasks.run(taskId, (signal) =>
      this.llm.chat(
        [
          { role: 'system', content: template?.prompt ?? SEARCH_SUMMARY_PROMPT },
          { role: 'user', content: sectionsText },
        ],
        { signal },
      ),
    );
    const text = reply.trim();
    if (text === '') {
      throw new Error('The model returned an empty summary.');
    }
    return text;
  }

  /**
   * The drawer's "Autotag" button: the entry text + the vault's tag
   * vocabulary in, up to four suggested tags out (normalised,
   * de-duplicated). Uses the editable `autotag` built-in template. `[]`
   * when nothing usable came back; throws only when LLM features are off or
   * the call fails. Cancellable via `taskId`.
   */
  async suggestTags(entryText: string, vocabulary: string[], taskId?: string): Promise<string[]> {
    if (!this.config.get().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    if (entryText.trim() === '') {
      return [];
    }
    const template = this.config
      .get()
      .actions.templates.find((entry) => entry.builtin === 'autotag');
    const system = (template?.prompt ?? AUTOTAG_PROMPT).replace(
      '{tags}',
      vocabulary.length > 0 ? vocabulary.join('\n') : '(none yet)',
    );
    const reply = await this.tasks.run(taskId, (signal) =>
      this.llm.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: entryText },
        ],
        { signal },
      ),
    );
    return parseSuggestedTags(reply);
  }

  /** Chat Ask mode: an answer to display, or an edit to confirm. */
  async ask(
    context: ActionContext,
    question: string,
    taskId?: string,
    history?: ChatMessage[],
  ): Promise<AskOutcome> {
    if (!this.config.get().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    // The renderer already shapes and caps the thread (`historyForAsk`);
    // the slice here is defence in depth against an over-long payload.
    const prior = (history ?? []).slice(-MAX_HISTORY_MESSAGES);
    const toolsOn = this.config.get().mcp.enabled && this.vaultTools !== undefined;
    const messages: ChatMessage[] = [
      { role: 'system', content: toolsOn ? `${ASK_SYSTEM}\n${ASK_TOOLS_NOTE}` : ASK_SYSTEM },
      ...prior,
      { role: 'user', content: buildAskUserMessage(context, question) },
    ];
    const reply = await this.tasks.run(taskId, (signal) =>
      this.llm.chat(messages, {
        signal,
        ...(toolsOn
          ? {
              tools: this.vaultTools!.openAiToolSpec(),
              onToolCall: (name, argsJson) => this.runVaultTool(name, argsJson),
            }
          : {}),
      }),
    );
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

  /** Bridges one model tool call to `VaultTools`, flattening the result to text. */
  private async runVaultTool(name: string, argsJson: string): Promise<string> {
    if (!this.vaultTools) {
      return 'Vault tools are not available.';
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(argsJson || '{}');
      if (parsed && typeof parsed === 'object') {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      return `Could not parse arguments for ${name}: ${argsJson}`;
    }
    const result = await this.vaultTools.call(name, args);
    return result.content.map((block) => block.text).join('\n');
  }

  private async runGeneric(
    action: ResolvedAction,
    context: ActionContext,
    signal: AbortSignal,
  ): Promise<ActionOutcome> {
    const user = context.selection
      ? `SELECTED SECTION:\n${context.selection}\n\nWHOLE DOCUMENT:\n${context.body}`
      : context.body;
    const reply = await this.llm.chat(
      [
        { role: 'system', content: action.prompt + GENERIC_SYSTEM_SUFFIX },
        { role: 'user', content: user },
      ],
      { signal },
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
