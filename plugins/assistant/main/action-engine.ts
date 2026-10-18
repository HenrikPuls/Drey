/**
 * The assistant plugin's action engine (ADR-0044 stage 7) — the
 * pre-conversion `ActionRunner` (`electron/llm/action-runner.ts`) with its
 * dependencies narrowed to what the base `ctx.llm` facade hands out: the
 * plugin's own `actions` config value (moved there from the app config,
 * ADR-0010 later change) and one completion call. The task
 * registry/abort plumbing lives base-side (`llm.cancelTask` by taskId);
 * the vault tool loop is an option on that call, so the engine never sees
 * the `VaultTools` instance.
 *
 * Since ADR-0048 conversations (Ask) live in `chat-engine.ts` against chat
 * notes, with full-history replay replacing this file's old 12-message
 * cap.
 */
import {
  ActionContext,
  ActionOutcome,
  ChatMessage,
  ResolvedAction,
  resolveActions,
  substituteVocabulary,
} from '../../../shared/llm';
import { normalizeActionsConfig } from '../../../shared/app-config';

/** The message a cancelled generation reports (kept in step with the base transport). */
const CANCELLED_MESSAGE = 'Generation cancelled.';

/** One completion call with an optional vault tool loop; abort via `taskId`. */
export type ChatFn = (
  messages: readonly ChatMessage[],
  options?: { taskId?: string; vaultTools?: boolean },
) => Promise<string>;

const GENERIC_SYSTEM_SUFFIX =
  '\n\nReturn the complete, revised Markdown document — no code fence, no explanation.';

export class ActionEngine {
  constructor(
    /**
     * The plugin's own config value for the `actions` key — read fresh
     * per call, normalized here (the built-ins re-inject, malformed
     * entries drop). The config store is async; the seam may hand back
     * either a promise or the value.
     */
    private readonly readActions: () => unknown,
    private readonly llmEnabled: () => boolean,
    private readonly chat: ChatFn,
    /**
     * The vault's tag vocabulary for the `{{AVAILABLE_TAGS}}` placeholder
     * (the lossless template's tagging rules); empty when no plugin
     * registered the section-search provider.
     */
    private readonly vocabulary: () => readonly string[] = () => [],
  ) {}

  /** Enabled actions for a trigger event (the on-save hook's enumeration). */
  async actionsForEvent(event: 'on-save'): Promise<ResolvedAction[]> {
    return resolveActions(normalizeActionsConfig(await this.readActions())).filter(
      (a) => a.enabled && a.event === event,
    );
  }

  async run(triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome> {
    const action = resolveActions(normalizeActionsConfig(await this.readActions())).find(
      (a) => a.triggerId === triggerId,
    );
    if (!action) {
      return { kind: 'error', triggerId, name: 'Unknown action', message: 'Action not found.' };
    }
    if (!this.llmEnabled()) {
      return { kind: 'error', triggerId, name: action.name, message: 'LLM features are disabled.' };
    }
    try {
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

  /** Chat Ask mode moved to `chat-engine.ts` (ADR-0048). */

  private async runGeneric(
    action: ResolvedAction,
    context: ActionContext,
    taskId?: string,
  ): Promise<ActionOutcome> {
    const user = context.selection
      ? `SELECTED SECTION:\n${context.selection}\n\nWHOLE DOCUMENT:\n${context.body}`
      : context.body;
    // `{{AVAILABLE_TAGS}}` (and Autotag's legacy `{tags}`) become the
    // vault's tag vocabulary — the one placeholder every action prompt
    // shares, also usable from user templates.
    const system = substituteVocabulary(action.prompt, this.vocabulary()) + GENERIC_SYSTEM_SUFFIX;
    const reply = await this.chat(
      [
        { role: 'system', content: system },
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
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Strip an outer ```/```markdown fence a model may add, normalise EOL, one trailing newline. */
export function normalizeDoc(text: string): string {
  let out = text.replace(/\r\n/g, '\n').trim();
  const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
  if (fence) {
    out = fence[1].trim();
  }
  return `${out}\n`;
}
