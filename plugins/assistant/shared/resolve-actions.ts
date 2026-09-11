/**
 * The trigger → template join, for the plugin renderer. A copy of
 * `resolveActions` from the app's `shared/llm/actions.ts` (the main side
 * imports the original from there — CJS under `dist-electron/shared` — but
 * the renderer is served as ES modules over `plugin://` and cannot reach
 * the app's shared files at runtime). The shapes must stay in step:
 * `ActionContext`/`ActionOutcome` come in as types from `shared/llm`.
 */

import type { ActionEvent, ActionResultKind, AppConfig, BuiltinAction } from '../../../shared/app-config';

/** A trigger joined to its template — what the ⋯ menu lists and runs. */
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
