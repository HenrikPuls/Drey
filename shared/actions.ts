/**
 * Actions system -- the config-level types and the trigger -> template
 * join. Deliberately dependency-light (only `./app-config`): the renderer
 * imports `resolveActions` at runtime to list actions, so this file must
 * not pull in the frontmatter/`yaml` stack. The document-rewrite helpers
 * that DO need it live in `shared/action-apply.ts` (main-process only).
 *
 * See `docs/09_architecture_decisions/0011-unified-confirmation-flow.md`.
 */
import { ActionEvent, ActionResultKind, AppConfig, BuiltinAction } from './app-config';

/**
 * The document an action runs against -- always the active editor tab
 * (there is no Inbox yet): its vault-relative path, its current buffer
 * (LF), and the current text selection if any.
 */
export interface ActionContext {
  path: string;
  body: string;
  selection?: string;
}

/**
 * The result of running one action. `'edit'` carries a `before`/`after`
 * pair for the confirmation flow (ADR-0011); `'noop'` ran fine but nothing
 * changed; `'error'` failed (LLM unreachable, disabled, bad reply).
 */
export type ActionOutcome =
  | {
      kind: 'edit';
      triggerId: string;
      name: string;
      previewStyle: ActionResultKind;
      path: string;
      before: string;
      after: string;
      /** One-line description for the dialog header, e.g. "Add tags: #foo, #bar". */
      summary: string;
    }
  | { kind: 'noop'; triggerId: string; name: string; message: string }
  | { kind: 'error'; triggerId: string; name: string; message: string };

/** The result of a chat Ask-mode turn. */
export type AskOutcome =
  | { kind: 'answer'; text: string }
  | {
      kind: 'edit';
      previewStyle: ActionResultKind;
      before: string;
      after: string;
      summary: string;
    };

/** A trigger joined to its template -- what the renderer lists and runs. */
export interface ResolvedAction {
  triggerId: string;
  templateId: string;
  name: string;
  prompt: string;
  event: ActionEvent;
  resultKind: ActionResultKind;
  builtin: BuiltinAction | null;
  confirm: boolean;
  enabled: boolean;
}

/** Joins every trigger to its template, dropping triggers whose template is gone. */
export function resolveActions(config: AppConfig): ResolvedAction[] {
  const byId = new Map(config.actions.templates.map((t) => [t.id, t]));
  const out: ResolvedAction[] = [];
  for (const trigger of config.actions.triggers) {
    const template = byId.get(trigger.templateId);
    if (!template) {
      continue;
    }
    out.push({
      triggerId: trigger.id,
      templateId: template.id,
      name: template.name,
      prompt: template.prompt,
      event: trigger.event,
      resultKind: template.resultKind,
      builtin: template.builtin,
      confirm: trigger.confirm,
      enabled: trigger.enabled,
    });
  }
  return out;
}
