/**
 * Runs an Action (`shared/app-config.ts`) against the active document and
 * returns an `ActionOutcome` -- for an `'edit'`, a `before`/`after` pair
 * the renderer routes through the one confirmation flow (ADR-0011). Also
 * hosts chat Ask mode and the note assistant's summary, which share the
 * same LLM plumbing.
 */
import { ActionEvent, NOTE_SUMMARY_PROMPT } from '../../shared/app-config';
import {
  ActionContext,
  ActionOutcome,
  AskOutcome,
  ChatMessage,
  parseJsonObject,
  ResolvedAction,
  resolveActions,
} from '../../shared/llm';
import { pickPreviewStyle } from '../../shared/text-diff';
import { AppConfigStore } from '../app-config';
import { CANCELLED_MESSAGE, isAbortError, LlmTaskRegistry } from './llm-tasks';
import { LmStudioClient } from './lm-studio-client';

const GENERIC_SYSTEM_SUFFIX =
  '\n\nGib das vollständige, überarbeitete Markdown-Dokument zurück – ohne Code-Fence, ohne Erklärung.';

const ASK_SYSTEM = `Du arbeitest an einem Markdown-Dokument. Der Nutzer stellt entweder eine Frage zum Dokument oder gibt eine Anweisung, es zu ändern.

Antworte AUSSCHLIESSLICH mit JSON, keine Erklärung drumherum:
- Frage (nur beantworten, nichts ändern): {"kind":"answer","text":"<antwort>"}
- Änderung: {"kind":"edit","document":"<das vollständige geänderte Dokument>"}

Bei einer Änderung gibst du IMMER das gesamte Dokument zurück, nicht nur die geänderte Stelle.`;

export class ActionRunner {
  constructor(
    private readonly config: AppConfigStore,
    private readonly llm: LmStudioClient,
    private readonly tasks: LlmTaskRegistry,
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

  /** Chat Ask mode: an answer to display, or an edit to confirm. */
  async ask(context: ActionContext, question: string, taskId?: string): Promise<AskOutcome> {
    if (!this.config.get().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: buildAskUserMessage(context, question) },
    ];
    const reply = await this.tasks.run(taskId, (signal) => this.llm.chat(messages, { signal }));
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
    signal: AbortSignal,
  ): Promise<ActionOutcome> {
    const user = context.selection
      ? `AUSGEWÄHLTER ABSCHNITT:\n${context.selection}\n\nGESAMTES DOKUMENT:\n${context.body}`
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
  const parts = [`ANWEISUNG / FRAGE:\n${question.trim()}`];
  if (context.selection?.trim()) {
    parts.push(`AKTUELLE AUSWAHL:\n${context.selection}`);
  }
  parts.push(`DOKUMENT (${context.path}):\n${context.body}`);
  return parts.join('\n\n');
}
