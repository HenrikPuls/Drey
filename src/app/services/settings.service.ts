import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ActionEvent,
  ActionTemplate,
  AppConfig,
  AssistantConfig,
  CustomDictionary,
  DEFAULT_EDITOR_FONT_FAMILY,
  LlmConfig,
  LlmEndpoint,
  SpellcheckConfig,
  clampEditorFontScale,
  normalizeAppConfig,
  normalizeEditorFontFamily,
} from '../../../shared/app-config';
import { ResolvedAction, resolveActions } from '../../../shared/llm';
import { deepEqual } from '../../../shared/deep-equal';
import { LlmConnectionTest } from '../../../shared/ipc-api';

/** `crypto.randomUUID` in the app; a cheap fallback for non-secure/test contexts. */
function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Holds the app-level configuration (`shared/app-config.ts`) and is the one
 * place that talks to `window.dreyApi.getConfig` / `setConfig`.
 *
 * Two signals, deliberately:
 * - `config` — what is actually persisted. Everything at *runtime* reads
 *   this (is the LLM on? which actions exist?), so an unsaved edit in the
 *   Settings screen can never change app behaviour.
 * - `draft` — the copy the Settings screen edits. Every pane mutator writes
 *   here and nothing else; `save()` sends it across and adopts the
 *   normalised result, `discard()` throws it away.
 *
 * This replaced a persist-on-every-keystroke design, which had two faults:
 * an in-progress value round-tripped through IPC on each edit (so a main
 * process that didn't yet know a field would silently erase what you were
 * typing), and there was no notion of "unsaved changes" to warn about on
 * close.
 *
 * The one exception is `setTriggerConfirmImmediate`, called by the
 * confirmation dialog's "don't ask again" checkbox — that happens outside
 * the Settings screen and must persist right away.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _config = signal<AppConfig | null>(null);
  private readonly _draft = signal<AppConfig | null>(null);

  /** The persisted config. Runtime behaviour reads this, never the draft. */
  readonly config = this._config.asReadonly();
  /** The Settings screen's working copy. `null` before the screen has ever opened. */
  readonly draft = this._draft.asReadonly();

  /** Whether the Settings overlay is showing (the sidebar entry opens it). */
  readonly screenOpen = signal(false);

  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);

  /** Draft differs from what's on disk -- drives the Save button and the close prompt. */
  readonly isDirty = computed<boolean>(() => {
    const config = this._config();
    const draft = this._draft();
    return config !== null && draft !== null && !deepEqual(config, draft);
  });

  readonly llmEnabled = computed<boolean>(() => this._config()?.llm.enabled ?? false);

  /** Editor content zoom multiplier (Ctrl +/-/0). Persisted config, never the draft. */
  readonly editorFontScale = computed<number>(() => this._config()?.editor.fontScale ?? 1);

  /** Editor font-family id (Settings -> Appearance). Persisted config, never the draft. */
  readonly editorFontFamily = computed<string>(
    () => this._config()?.editor.fontFamily ?? DEFAULT_EDITOR_FONT_FAMILY,
  );

  /** Manual-trigger actions, for the editor's run menu. Persisted config only. */
  readonly manualActions = computed<ResolvedAction[]>(() => {
    const config = this._config();
    return config
      ? resolveActions(config).filter((action) => action.enabled && action.event === 'manual')
      : [];
  });

  // LLM connection UI state (transient, not part of the config).
  readonly models = signal<string[]>([]);
  readonly modelsLoading = signal(false);
  readonly connectionTest = signal<LlmConnectionTest | null>(null);
  readonly testing = signal(false);

  constructor() {
    void this.load();
  }

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  async load(): Promise<void> {
    if (!this.api) {
      return;
    }
    try {
      // Normalised on arrival, not just trusted: a main process running
      // older compiled code (the `npm run dev` staleness trap, docs/11)
      // returns a config with whole sections missing, and a pane bound to
      // `draft()?.<section>` would then silently render nothing. Filling
      // from defaults here means a section can never be absent.
      const config = normalizeAppConfig(await this.api.getConfig());
      this._config.set(config);
      // Only seed the draft when nothing is being edited, so a slow initial
      // load can't clobber changes the user already started making.
      if (this._draft() === null) {
        this._draft.set(structuredClone(config));
      }
    } catch (err) {
      this.saveError.set(err instanceof Error ? err.message : String(err));
    }
  }

  // -- Screen lifecycle ----------------------------------------------------

  /** Opens the Settings overlay on a fresh copy of the persisted config. */
  openScreen(): void {
    const config = this._config();
    if (config) {
      this._draft.set(structuredClone(config));
    }
    this.saveError.set(null);
    this.connectionTest.set(null);
    this.screenOpen.set(true);
  }

  /** Closes without saving. The component asks first when `isDirty()`. */
  closeScreen(): void {
    this.discard();
    this.screenOpen.set(false);
  }

  /** Resets the draft to what is on disk. */
  discard(): void {
    const config = this._config();
    this._draft.set(config ? structuredClone(config) : null);
    this.saveError.set(null);
  }

  /** Persists the draft. Resolves `true` on success; on failure sets `saveError`. */
  async save(): Promise<boolean> {
    const draft = this._draft();
    if (!draft || this.saving()) {
      return false;
    }
    if (!this.api) {
      // Outside Electron (plain `ng serve`) there is nothing to write to.
      this._config.set(structuredClone(draft));
      return true;
    }

    this.saving.set(true);
    this.saveError.set(null);
    try {
      const stored = normalizeAppConfig(await this.api.setConfig(draft));
      this._config.set(stored);
      this._draft.set(structuredClone(stored));
      return true;
    } catch (err) {
      this.saveError.set(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  // -- LLM category (draft) ------------------------------------------------

  patchLlm(patch: Partial<LlmConfig>): void {
    this.mutate((config) => {
      config.llm = { ...config.llm, ...patch };
    });
  }

  // -- Assistant / spellcheck categories (draft) ---------------------------

  patchAssistant(patch: Partial<AssistantConfig>): void {
    this.mutate((config) => {
      config.assistant = { ...config.assistant, ...patch };
    });
  }

  patchSpellcheck(patch: Partial<SpellcheckConfig>): void {
    this.mutate((config) => {
      config.spellcheck = { ...config.spellcheck, ...patch };
    });
  }

  /** Adds a user dictionary, replacing an earlier one with the same id. */
  addDictionary(dictionary: CustomDictionary): void {
    this.mutate((config) => {
      config.spellcheck.dictionaries = [
        ...config.spellcheck.dictionaries.filter((entry) => entry.id !== dictionary.id),
        dictionary,
      ];
    });
  }

  /**
   * Removes a user dictionary. If it was the selected language, the
   * selection falls back to the first bundled one -- otherwise Save would
   * leave the checker pointing at nothing.
   */
  removeDictionary(id: string): void {
    this.mutate((config) => {
      config.spellcheck.dictionaries = config.spellcheck.dictionaries.filter(
        (entry) => entry.id !== id,
      );
      if (config.spellcheck.language === id) {
        config.spellcheck.language = 'de';
      }
    });
  }

  /** The endpoint the connection probes should use: what's typed, not what's saved. */
  private draftEndpoint(): LlmEndpoint | undefined {
    const llm = this._draft()?.llm;
    return llm ? { baseUrl: llm.baseUrl, apiKey: llm.apiKey } : undefined;
  }

  async refreshModels(): Promise<void> {
    if (!this.api) {
      return;
    }
    this.modelsLoading.set(true);
    try {
      this.models.set(await this.api.listLlmModels(this.draftEndpoint()));
    } catch {
      this.models.set([]);
    } finally {
      this.modelsLoading.set(false);
    }
  }

  async testConnection(): Promise<void> {
    if (!this.api) {
      return;
    }
    this.testing.set(true);
    try {
      const result = await this.api.testLlmConnection(this.draftEndpoint());
      this.connectionTest.set(result);
      if (result.ok) {
        this.models.set(result.models);
      }
    } finally {
      this.testing.set(false);
    }
  }

  // -- Actions category (draft) -------------------------------------------

  addTrigger(templateId: string, event: ActionEvent): void {
    this.mutate((config) => {
      config.actions.triggers.push({
        id: `trigger:${uid()}`,
        templateId,
        event,
        confirm: true,
        enabled: true,
      });
    });
  }

  removeTrigger(triggerId: string): void {
    this.mutate((config) => {
      config.actions.triggers = config.actions.triggers.filter((t) => t.id !== triggerId);
    });
  }

  setTriggerConfirm(triggerId: string, confirm: boolean): void {
    this.mutate((config) => {
      const trigger = config.actions.triggers.find((t) => t.id === triggerId);
      if (trigger) {
        trigger.confirm = confirm;
      }
    });
  }

  setTriggerEnabled(triggerId: string, enabled: boolean): void {
    this.mutate((config) => {
      const trigger = config.actions.triggers.find((t) => t.id === triggerId);
      if (trigger) {
        trigger.enabled = enabled;
      }
    });
  }

  setTriggerEvent(triggerId: string, event: ActionEvent): void {
    this.mutate((config) => {
      const trigger = config.actions.triggers.find((t) => t.id === triggerId);
      if (trigger) {
        trigger.event = event;
      }
    });
  }

  /** Adds a blank user template and returns its id so the UI can open it for editing. */
  addTemplate(): string {
    const id = `template:${uid()}`;
    this.mutate((config) => {
      config.actions.templates.push({
        id,
        name: 'New action',
        prompt: '',
        resultKind: 'document',
        builtin: null,
      });
    });
    return id;
  }

  updateTemplate(templateId: string, patch: Partial<Omit<ActionTemplate, 'id' | 'builtin'>>): void {
    this.mutate((config) => {
      const template = config.actions.templates.find((t) => t.id === templateId);
      if (template) {
        Object.assign(template, patch);
      }
    });
  }

  /** User templates only -- `normalizeAppConfig` re-injects a removed built-in. */
  removeTemplate(templateId: string): void {
    this.mutate((config) => {
      const template = config.actions.templates.find((t) => t.id === templateId);
      if (!template || template.builtin) {
        return;
      }
      config.actions.templates = config.actions.templates.filter((t) => t.id !== templateId);
      config.actions.triggers = config.actions.triggers.filter(
        (trigger) => trigger.templateId !== templateId,
      );
    });
  }

  // -- Outside the Settings screen ----------------------------------------

  /**
   * The confirmation dialog's "don't ask again for this action" checkbox.
   * Persists immediately -- it is not part of a Settings editing session,
   * and the user expects the next run of that action to skip the prompt.
   * The draft gets the same edit so an open Settings screen stays in step
   * (and doesn't undo it on its next save).
   */
  async setTriggerConfirmImmediate(triggerId: string, confirm: boolean): Promise<void> {
    const config = this._config();
    if (!config) {
      return;
    }
    const next = structuredClone(config);
    const trigger = next.actions.triggers.find((t) => t.id === triggerId);
    if (!trigger || trigger.confirm === confirm) {
      return;
    }
    trigger.confirm = confirm;

    this._config.set(next);
    this.mutate((draft) => {
      const draftTrigger = draft.actions.triggers.find((t) => t.id === triggerId);
      if (draftTrigger) {
        draftTrigger.confirm = confirm;
      }
    });

    if (!this.api) {
      return;
    }
    try {
      this._config.set(normalizeAppConfig(await this.api.setConfig(next)));
    } catch (err) {
      this.saveError.set(err instanceof Error ? err.message : String(err));
      void this.load();
    }
  }

  /**
   * Editor content zoom (Ctrl +/-/0 while an editor is focused). Like
   * `setTriggerConfirmImmediate`, this is not part of a Settings editing
   * session: it updates `_config` at once so the editor re-renders on the
   * next frame, applies the same edit to an open draft so the screen stays
   * in step, and persists straight away. `clampEditorFontScale` bounds and
   * grid-snaps the value, so out-of-range steps are simply pinned.
   */
  async setEditorFontScale(scale: number): Promise<void> {
    const config = this._config();
    if (!config) {
      return;
    }
    const fontScale = clampEditorFontScale(scale);
    if (fontScale === config.editor.fontScale) {
      return;
    }

    const next = structuredClone(config);
    next.editor.fontScale = fontScale;
    this._config.set(next);
    this.mutate((draft) => {
      draft.editor.fontScale = fontScale;
    });

    if (!this.api) {
      return;
    }
    try {
      this._config.set(normalizeAppConfig(await this.api.setConfig(next)));
    } catch (err) {
      this.saveError.set(err instanceof Error ? err.message : String(err));
      void this.load();
    }
  }

  /**
   * Editor font family (Settings -> Appearance). Persists immediately and
   * mirrors the edit into an open draft, exactly like `setEditorFontScale`:
   * the choice applies to the editor host on the next frame and the Settings
   * screen stays in step without adding dirty state. An unknown id is pinned
   * to the sans default by `normalizeEditorFontFamily`.
   */
  async setEditorFontFamily(id: string): Promise<void> {
    const config = this._config();
    if (!config) {
      return;
    }
    const fontFamily = normalizeEditorFontFamily(id);
    if (fontFamily === config.editor.fontFamily) {
      return;
    }

    const next = structuredClone(config);
    next.editor.fontFamily = fontFamily;
    this._config.set(next);
    this.mutate((draft) => {
      draft.editor.fontFamily = fontFamily;
    });

    if (!this.api) {
      return;
    }
    try {
      this._config.set(normalizeAppConfig(await this.api.setConfig(next)));
    } catch (err) {
      this.saveError.set(err instanceof Error ? err.message : String(err));
      void this.load();
    }
  }

  /** Applies `change` to a clone of the draft. No IPC -- `save()` does that. */
  private mutate(change: (config: AppConfig) => void): void {
    const current = this._draft();
    if (!current) {
      return;
    }
    const next = structuredClone(current);
    change(next);
    this._draft.set(next);
  }
}
