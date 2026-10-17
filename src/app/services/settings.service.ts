import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AppConfig,
  BUILTIN_ENTRY_TEMPLATE_IDS,
  CLASSIC_ENTRY_PATTERN,
  CustomDictionary,
  DailyConfig,
  KeybindingsConfig,
  DEFAULT_APPEARANCE,
  DEFAULT_DAILY_CONFIG,
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_TEMPLATES_CONFIG,
  EntryTemplate,
  LlmConfig,
  LlmEndpoint,
  McpConfig,
  SpellcheckConfig,
  TemplatesConfig,
  ToolsConfig,
  UiScale,
  UpdateLinksMode,
  UpdatesConfig,
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
 *   this (is the LLM on? which actions exist?).
 * - `draft` — the copy the Settings screen edits. Every pane mutator writes
 *   here; the draft then **saves itself** (ADR-0010 later change): a short
 *   moment after the last edit, held back while a text field is being
 *   typed in (`editingText`) and sent when the field is left, on Enter, or
 *   when the screen closes (`flush()`). There is no Save and no Discard.
 *
 * The draft is what keeps typing safe: what is on screen is never replaced
 * by a value that round-tripped through IPC while the user typed on, and a
 * half-typed URL is not what the app runs on. A save writes only the
 * top-level sections the draft changed, onto a fresh read of the stored
 * config -- so it cannot undo what a plugin page (`api.appConfig.patch`)
 * wrote in the meantime.
 */
/** How long after the last edit the draft saves itself. */
const AUTOSAVE_DELAY_MS = 400;

function setSection<K extends keyof AppConfig>(target: AppConfig, source: AppConfig, key: K): void {
  target[key] = structuredClone(source[key]);
}

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

  /**
   * A category the screen should open on (Help -> About passes `'about'`).
   * Consumed once by the Settings component when it mounts, then cleared;
   * an id the registry does not know falls back to the first category.
   */
  readonly openCategory = signal<string | null>(null);

  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);

  /**
   * True while the focus sits in a text field of the Settings screen (set
   * by the `Settings` component). The automatic save waits for the field
   * to be left, so a half-typed value never reaches disk.
   */
  readonly editingText = signal(false);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;

  /** Draft differs from what's on disk -- a save is pending or has failed. */
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

  /** The vault-relative root folder for daily notes. Persisted config, never the draft. */
  readonly dailyDir = computed<string>(() => this._config()?.daily.dir ?? DEFAULT_DAILY_CONFIG.dir);

  /**
   * Ids of the dock widgets switched off in Settings -> Panels & plugins.
   * **Persisted config, never the draft** -- a toggle reaches the dock and
   * the View menu once it is saved, a moment after the click. `DockService`
   * and `MenuService` read this.
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
   * screen is open, so a change shows at once rather than after the
   * automatic save, and the saved **config** otherwise.
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
    () => this.appearanceSource()?.appearance.theme ?? DEFAULT_APPEARANCE.theme,
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

  /**
   * Opens the Settings overlay on a fresh copy of the persisted config.
   * `category` optionally names the category to select (Help -> About);
   * the component falls back to the first one when it is unknown.
   */
  openScreen(category?: string): void {
    const config = this._config();
    if (config) {
      this._draft.set(structuredClone(config));
    }
    this.saveError.set(null);
    this.connectionTest.set(null);
    this.openCategory.set(category ?? null);
    this.screenOpen.set(true);
  }

  /**
   * Closes the screen. What the draft still holds is dropped -- the
   * component calls `flush()` first and only comes here once that went
   * through (or the user chose to close without saving after a failure).
   */
  closeScreen(): void {
    this.cancelTimer();
    this.editingText.set(false);
    const config = this._config();
    this._draft.set(config ? structuredClone(config) : null);
    this.saveError.set(null);
    this.openCategory.set(null);
    this.screenOpen.set(false);
  }

  /** Saves what is pending now, without waiting for the delay. Resolves `false` when it failed. */
  flush(): Promise<boolean> {
    this.cancelTimer();
    return this.save();
  }

  /**
   * Persists the draft's changes. Resolves `true` when nothing is left to
   * save; on failure sets `saveError` and keeps the draft. Calls queue up
   * behind a save that is under way.
   */
  async save(): Promise<boolean> {
    while (this.inFlight) {
      await this.inFlight;
    }
    if (!this.isDirty()) {
      return true;
    }
    this.inFlight = this.persist();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async persist(): Promise<boolean> {
    const sent = this._draft();
    const base = this._config();
    if (!sent || !base) {
      return false;
    }
    if (!this.api) {
      // Outside Electron (plain `ng serve`) there is nothing to write to.
      this._config.set(structuredClone(sent));
      return true;
    }

    this.saving.set(true);
    this.saveError.set(null);
    try {
      const keys = Object.keys(sent) as Array<keyof AppConfig>;
      const next = normalizeAppConfig(await this.api.getConfig());
      for (const key of keys) {
        if (!deepEqual(base[key], sent[key])) {
          setSection(next, sent, key);
        }
      }
      const stored = normalizeAppConfig(await this.api.setConfig(next));
      this._config.set(stored);
      // Adopt the stored result, but keep what was edited while the save
      // was on its way -- the next save sends that.
      const current = this._draft() ?? sent;
      const draft = structuredClone(stored);
      for (const key of keys) {
        if (!deepEqual(current[key], sent[key])) {
          setSection(draft, current, key);
        }
      }
      this._draft.set(draft);
      return true;
    } catch (err) {
      this.saveError.set(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  private cancelTimer(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private scheduleSave(): void {
    this.cancelTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.editingText()) {
        void this.save();
      }
    }, AUTOSAVE_DELAY_MS);
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

  /** Settings -> Keyboard shortcuts: the whole slice after one change (ADR-0073). */
  setKeybindings(next: KeybindingsConfig): void {
    this.mutate((config) => {
      config.keybindings = next;
    });
  }

  patchVault(patch: Partial<VaultConfig>): void {
    this.mutate((config) => {
      config.vault = { ...config.vault, ...patch };
    });
  }

  /** Settings → Updates: the startup-check switch and the skipped version. */
  patchUpdates(patch: Partial<UpdatesConfig>): void {
    this.mutate((config) => {
      config.updates = { ...config.updates, ...patch };
    });
  }

  /** Settings -> Assistant tools: one edit of the tool groups. */
  patchTools(change: (tools: ToolsConfig) => void): void {
    this.mutate((config) => {
      change(config.tools);
    });
  }

  /** Settings -> Widgets: toggle a dock widget on / off. */
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
   * Settings -> Panels & plugins: enable / disable a plugin. Takes effect on the next app start -- discovery runs
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
   * selection falls back to the first bundled one -- otherwise the save would
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
   * to the active dictionary's list (`target: 'language'`). The editor
   * popup uses the immediate IPC path instead.
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
   * The rename dialog's "Don't ask again" (milestone 59): persists the
   * link-update mode immediately, outside the Settings draft -- same shape
   * as the confirmation dialog's per-trigger switch above.
   */
  async setUpdateLinksOnRename(mode: UpdateLinksMode): Promise<void> {
    const config = this._config();
    if (!config || config.vault.updateLinksOnRename === mode) {
      return;
    }
    const next = structuredClone(config);
    next.vault.updateLinksOnRename = mode;
    this._config.set(next);
    this.mutate((draft) => {
      draft.vault.updateLinksOnRename = mode;
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

  // -- Appearance category ------------------------------------------------

  /**
   * Editor typeface (Settings -> Appearance): `editorFontFamily()` shows
   * it at once while the Settings screen is open. An unknown
   * id is pinned to the sans default by `normalizeEditorFontFamily`.
   */
  setEditorFontFamily(id: string): void {
    this.mutate((config) => {
      config.editor.fontFamily = normalizeEditorFontFamily(id);
    });
  }

  /** App-wide base font size (Settings -> Appearance). */
  setAppearanceUiScale(scale: string): void {
    this.patchAppearance({ uiScale: normalizeUiScale(scale) });
  }

  /** App-wide highlight colour: `'theme'`, a preset id, or `#rrggbb` (Settings -> Appearance). */
  setAppearanceAccent(accent: string): void {
    this.patchAppearance({ accent: normalizeAccent(accent) });
  }

  /** Active theme id (Settings -> Appearance). */
  setAppearanceTheme(theme: string): void {
    this.patchAppearance({ theme: normalizeTheme(theme) });
  }

  private patchAppearance(patch: Partial<AppConfig['appearance']>): void {
    this.mutate((config) => {
      config.appearance = { ...config.appearance, ...patch };
    });
  }

  /**
   * The approval dialog's "Always allow" (milestone 63, ADR-0063): sets one
   * external tool source -- `'web'` for web_fetch, `'web_search'` for
   * web_search, otherwise an MCP server id -- to `allow`, persisted immediately and mirrored into an open
   * draft, like the other dialog-side switches above.
   */
  async allowToolSourceImmediate(source: string): Promise<void> {
    const config = this._config();
    if (!config) {
      return;
    }
    const apply = (tools: ToolsConfig): void => {
      if (source === 'web') {
        tools.webFetch.approval = 'allow';
      } else if (source === 'web_search') {
        tools.webSearch.approval = 'allow';
      } else {
        const server = tools.servers.find((s) => s.id === source);
        if (server) {
          server.approval = 'allow';
        }
      }
    };
    const next = structuredClone(config);
    apply(next.tools);
    this._config.set(next);
    this.mutate((draft) => apply(draft.tools));
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

  /** Applies `change` to a clone of the draft and schedules the automatic save. */
  private mutate(change: (config: AppConfig) => void): void {
    const current = this._draft();
    if (!current) {
      return;
    }
    const next = structuredClone(current);
    change(next);
    this._draft.set(next);
    this.scheduleSave();
  }
}
