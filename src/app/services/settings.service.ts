import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AppConfig,
  BUILTIN_ENTRY_TEMPLATE_IDS,
  CLASSIC_ENTRY_PATTERN,
  CustomDictionary,
  DailyConfig,
  DEFAULT_APPEARANCE,
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_THEME,
  DEFAULT_TEMPLATES_CONFIG,
  EntryTemplate,
  LlmConfig,
  LlmEndpoint,
  McpConfig,
  SpellcheckConfig,
  TemplatesConfig,
  UiScale,
  VaultConfig,
  activeEntryPattern,
  clampEditorFontScale,
  normalizeAccent,
  normalizeAppConfig,
  normalizeEditorFontFamily,
  normalizeTheme,
  normalizeUiScale,
} from '../../../shared/app-config';
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

  /** True once the initial `load()` has resolved -- `null` config means "not loaded yet". */
  readonly loaded = computed<boolean>(() => this._config() !== null);

  /** Whether to open today's daily note on app start. Persisted config, never the draft. */
  readonly dailyOpenOnStartup = computed<boolean>(() => this._config()?.daily.openOnStartup ?? true);

  /** The vault-relative templates folder. Persisted config, never the draft. */
  readonly templatesDir = computed<string>(
    () => this._config()?.templates.dir ?? DEFAULT_TEMPLATES_CONFIG.dir,
  );

  /**
   * Ids of the dock widgets switched off in Settings -> Widgets. **Persisted
   * config, never the draft** -- a disable takes effect on Save, like every
   * other category, so the dock / View menu don't churn while the screen is
   * open. `DockService` and `MenuService` read this.
   */
  readonly widgetsDisabled = computed<ReadonlySet<string>>(
    () => new Set(this._config()?.widgets.disabled ?? []),
  );

  /** Whether a dock widget id is currently enabled (persisted config). */
  widgetEnabled(id: string): boolean {
    return !this.widgetsDisabled().has(id);
  }

  /** The Settings -> Widgets draft's disabled ids (drives the checkboxes). */
  readonly widgetsDisabledDraft = computed<ReadonlySet<string>>(
    () => new Set(this._draft()?.widgets.disabled ?? []),
  );

  /** The Settings -> Panels & plugins draft's disabled plugin ids (drives the checkboxes). */
  readonly pluginsDisabledDraft = computed<ReadonlySet<string>>(
    () => new Set(this._draft()?.plugins.disabled ?? []),
  );

  /** Editor content zoom multiplier (Ctrl +/-/0). Persisted config, never the draft. */
  readonly editorFontScale = computed<number>(() => this._config()?.editor.fontScale ?? 1);

  /**
   * What the Appearance controls (typeface, base font size, highlight
   * colour) should reflect right now: the **draft** while the Settings
   * screen is open, so a change previews live before Save, and the saved
   * **config** otherwise. Discard / close resets the draft, which rolls
   * the preview back. (ADR-0020, "Later change".)
   */
  private readonly appearanceSource = computed<AppConfig | null>(() =>
    this.screenOpen() ? (this._draft() ?? this._config()) : this._config(),
  );

  /** Editor font-family id (Settings -> Appearance). Draft-previewed while the screen is open. */
  readonly editorFontFamily = computed<string>(
    () => this.appearanceSource()?.editor.fontFamily ?? DEFAULT_EDITOR_FONT_FAMILY,
  );

  /** App-wide UI scale step (Settings -> Appearance). Draft-previewed while the screen is open. */
  readonly appearanceUiScale = computed<UiScale>(
    () => this.appearanceSource()?.appearance.uiScale ?? DEFAULT_APPEARANCE.uiScale,
  );

  /** App-wide highlight colour -- `'theme'`, a preset id, or `#rrggbb`. Draft-previewed while the screen is open. */
  readonly appearanceAccent = computed<string>(
    () => this.appearanceSource()?.appearance.accent ?? DEFAULT_APPEARANCE.accent,
  );

  /** Active theme id (Settings -> Appearance). Draft-previewed while the screen is open. */
  readonly appearanceTheme = computed<string>(
    () => this.appearanceSource()?.appearance.theme ?? DEFAULT_THEME,
  );

  /** The active "Add entry" template's pattern. Persisted config, never the draft. */
  readonly activeEntryPattern = computed<string>(() => {
    const config = this._config();
    return config ? activeEntryPattern(config.entry) : CLASSIC_ENTRY_PATTERN;
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

  // -- Spellcheck category (draft) ------------------------------------------

  patchMcp(patch: Partial<McpConfig>): void {
    this.mutate((config) => {
      config.mcp = { ...config.mcp, ...patch };
    });
  }

  patchDaily(patch: Partial<DailyConfig>): void {
    this.mutate((config) => {
      config.daily = { ...config.daily, ...patch };
    });
  }

  patchTemplates(patch: Partial<TemplatesConfig>): void {
    this.mutate((config) => {
      config.templates = { ...config.templates, ...patch };
    });
  }

  patchVault(patch: Partial<VaultConfig>): void {
    this.mutate((config) => {
      config.vault = { ...config.vault, ...patch };
    });
  }

  /** Settings -> Widgets: toggle a dock widget on / off (draft edit; saved on Save). */
  setWidgetEnabled(id: string, enabled: boolean): void {
    this.mutate((config) => {
      const set = new Set(config.widgets.disabled);
      if (enabled) {
        set.delete(id);
      } else {
        set.add(id);
      }
      config.widgets = { disabled: [...set] };
    });
  }

  /**
   * Settings -> Panels & plugins: enable / disable a plugin (draft edit;
   * saved on Save). Takes effect on the next app start -- discovery runs
   * before either side activates, so a restart is the honest v1 cut.
   */
  setPluginEnabled(id: string, enabled: boolean): void {
    this.mutate((config) => {
      const set = new Set(config.plugins.disabled);
      if (enabled) {
        set.delete(id);
      } else {
        set.add(id);
      }
      config.plugins = { disabled: [...set] };
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

  /**
   * Adds an accepted word to the personal list (`target: 'personal'`) or
   * to the active dictionary's list (`target: 'language'`). Draft edit --
   * persisted on Save; the editor popup uses the immediate IPC path instead.
   */
  addSpellWord(word: string, target: 'language' | 'personal'): void {
    const trimmed = word.trim();
    if (trimmed === '') {
      return;
    }
    this.mutate((config) => {
      const sc = config.spellcheck;
      if (target === 'personal') {
        if (!sc.personalWords.includes(trimmed)) {
          sc.personalWords = [...sc.personalWords, trimmed];
        }
      } else {
        const list = sc.languageWords[sc.language] ?? [];
        if (!list.includes(trimmed)) {
          sc.languageWords = { ...sc.languageWords, [sc.language]: [...list, trimmed] };
        }
      }
    });
  }

  removeSpellWord(word: string, target: 'language' | 'personal'): void {
    this.mutate((config) => {
      const sc = config.spellcheck;
      if (target === 'personal') {
        sc.personalWords = sc.personalWords.filter((entry) => entry !== word);
      } else {
        const list = (sc.languageWords[sc.language] ?? []).filter((entry) => entry !== word);
        const next = { ...sc.languageWords };
        if (list.length > 0) {
          next[sc.language] = list;
        } else {
          delete next[sc.language];
        }
        sc.languageWords = next;
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

  // -- "Add entry" templates (draft) -------------------------------------

  /** Picks which entry template the drawer uses. */
  setActiveEntryTemplate(id: string): void {
    this.mutate((config) => {
      if (config.entry.templates.some((template) => template.id === id)) {
        config.entry.activeId = id;
      }
    });
  }

  /** Adds a blank user template (seeded with the Classic pattern) and returns its id. */
  addEntryTemplate(): string {
    const id = `entry-template:${uid()}`;
    this.mutate((config) => {
      config.entry.templates.push({
        id,
        name: 'New template',
        pattern: CLASSIC_ENTRY_PATTERN,
        builtin: null,
      });
    });
    return id;
  }

  updateEntryTemplate(id: string, patch: Partial<Pick<EntryTemplate, 'name' | 'pattern'>>): void {
    this.mutate((config) => {
      const template = config.entry.templates.find((t) => t.id === id);
      if (template) {
        Object.assign(template, patch);
      }
    });
  }

  /** User templates only; if it was active, the selection falls back to Classic. */
  removeEntryTemplate(id: string): void {
    this.mutate((config) => {
      const template = config.entry.templates.find((t) => t.id === id);
      if (!template || template.builtin) {
        return;
      }
      config.entry.templates = config.entry.templates.filter((t) => t.id !== id);
      if (config.entry.activeId === id) {
        config.entry.activeId = BUILTIN_ENTRY_TEMPLATE_IDS.classic;
      }
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

  // -- Appearance category (draft, ADR-0020 "Later change") --------------

  /**
   * Editor typeface (Settings -> Appearance). A draft edit, like every
   * other category: `editorFontFamily()` previews it live while the
   * Settings screen is open, and it reaches disk only on Save. An unknown
   * id is pinned to the sans default by `normalizeEditorFontFamily`.
   */
  setEditorFontFamily(id: string): void {
    this.mutate((config) => {
      config.editor.fontFamily = normalizeEditorFontFamily(id);
    });
  }

  /** App-wide base font size (Settings -> Appearance). Draft edit; live-previewed; saved on Save. */
  setAppearanceUiScale(scale: string): void {
    this.patchAppearance({ uiScale: normalizeUiScale(scale) });
  }

  /** App-wide highlight colour: `'theme'`, a preset id, or `#rrggbb` (Settings -> Appearance). Draft edit. */
  setAppearanceAccent(accent: string): void {
    this.patchAppearance({ accent: normalizeAccent(accent) });
  }

  /** Active theme id (Settings -> Appearance). Draft edit; live-previewed; saved on Save. */
  setAppearanceTheme(theme: string): void {
    this.patchAppearance({ theme: normalizeTheme(theme) });
  }

  private patchAppearance(patch: Partial<AppConfig['appearance']>): void {
    this.mutate((config) => {
      config.appearance = { ...config.appearance, ...patch };
    });
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
