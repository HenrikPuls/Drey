/**
 * `normalizeAppConfig` and the pure value helpers behind it. Every read of
 * the stored config file goes through `normalizeAppConfig`, which fills
 * missing keys from `DEFAULT_APP_CONFIG`, re-injects the built-in templates,
 * and drops anything malformed -- so consumers on either side of the IPC
 * boundary never have to null-check the structure, only the values. Same
 * defensive style as `readConfig` in `electron/vault-manager.ts`, one level
 * deeper.
 *
 * Split out of `schema.ts` (shapes) and `defaults.ts` (`DEFAULT_APP_CONFIG`);
 * re-exported from `shared/app-config.ts`.
 */
import {
  ACCENT_PRESETS,
  ActionEvent,
  ActionResultKind,
  ActionTemplate,
  ActionTrigger,
  AppConfig,
  AppearanceConfig,
  BUILTIN_ENTRY_TEMPLATE_IDS,
  BUNDLED_DICTIONARIES,
  CLASSIC_ENTRY_PATTERN,
  CustomDictionary,
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_THEME,
  DailyConfig,
  EDITOR_FONT_FAMILIES,
  EDITOR_FONT_SCALE_MAX,
  EDITOR_FONT_SCALE_MIN,
  EditorConfig,
  EntryConfig,
  EntryTemplate,
  LlmConfig,
  LlmProviderId,
  PROVIDER_PRESET_IDS,
  MCP_PORT_MAX,
  MCP_PORT_MIN,
  McpConfig,
  SpellcheckConfig,
  TemplatesConfig,
  THEME_ACCENT,
  UiScale,
  VaultConfig,
  WidgetsConfig,
  PluginsConfig,
  AssistantConfig,
} from './schema';
import {
  autotagTemplate,
  classicEntryTemplate,
  DEFAULT_APP_CONFIG,
  DEFAULT_APPEARANCE,
  DEFAULT_DAILY_CONFIG,
  DEFAULT_MCP_CONFIG,
  DEFAULT_TEMPLATES_CONFIG,
  DEFAULT_VAULT_CONFIG,
  noteSummaryTemplate,
  ruledEntryTemplate,
  searchSummaryTemplate,
} from './defaults';

/** The pattern of the active template, or the classic pattern as a floor. */
export function activeEntryPattern(entry: EntryConfig): string {
  return (
    entry.templates.find((template) => template.id === entry.activeId)?.pattern ??
    CLASSIC_ENTRY_PATTERN
  );
}

/** A stored id, or the sans default when it names no known family. */
export function normalizeEditorFontFamily(value: unknown): string {
  return typeof value === 'string' && EDITOR_FONT_FAMILIES.some((option) => option.id === value)
    ? value
    : DEFAULT_EDITOR_FONT_FAMILY;
}

/** The `--font-sans` / `--drey-heading-font` values for a font-family id. */
export function editorFontFamilyStacks(id: string): { body: string; heading: string } {
  const option = EDITOR_FONT_FAMILIES.find((entry) => entry.id === id) ?? EDITOR_FONT_FAMILIES[0];
  return { body: option.body, heading: option.heading };
}

/**
 * Clamps a requested multiplier to `[MIN, MAX]` and snaps it to a 0.05
 * grid, so a long run of `± STEP` steps can't accumulate float drift.
 * A non-finite input (a corrupt file, `undefined`) falls back to 1.
 */
export function clampEditorFontScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  const clamped = Math.min(EDITOR_FONT_SCALE_MAX, Math.max(EDITOR_FONT_SCALE_MIN, n));
  return Math.round(clamped * 20) / 20;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** A stored scale step, or `'default'` when it names no known step. */
export function normalizeUiScale(value: unknown): UiScale {
  return value === 'small' || value === 'large' || value === 'xlarge' || value === 'default'
    ? value
    : DEFAULT_APPEARANCE.uiScale;
}

/**
 * The `'theme'` sentinel, a known preset id, or a `#rrggbb` hex; anything
 * else falls back to the default (`'theme'`).
 */
export function normalizeAccent(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_APPEARANCE.accent;
  }
  if (value === THEME_ACCENT || ACCENT_PRESETS.some((preset) => preset.id === value)) {
    return value;
  }
  return HEX_RE.test(value) ? value.toLowerCase() : DEFAULT_APPEARANCE.accent;
}

/** Non-empty string, else `'drey'`. The renderer catalog does the real resolve. */
export function normalizeTheme(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : DEFAULT_THEME;
}

/**
 * The concrete `#rrggbb` for an `accent` value: preset id -> its hex,
 * hex -> itself, and the `'theme'` sentinel -> `themeAccent` (the active
 * theme's seed accent, supplied by the caller) or the first preset.
 */
export function resolveAccentHex(accent: string, themeAccent?: string): string {
  if (accent === THEME_ACCENT) {
    return themeAccent && HEX_RE.test(themeAccent) ? themeAccent.toLowerCase() : ACCENT_PRESETS[0].hex;
  }
  const preset = ACCENT_PRESETS.find((entry) => entry.id === accent);
  if (preset) {
    return preset.hex;
  }
  return HEX_RE.test(accent) ? accent.toLowerCase() : ACCENT_PRESETS[0].hex;
}

function normalizeAppearance(raw: unknown): AppearanceConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    uiScale: normalizeUiScale(source['uiScale']),
    accent: normalizeAccent(source['accent']),
    theme: normalizeTheme(source['theme']),
  };
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Trimmed string, or `null` when absent/blank/not a string. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * A stored provider id, or `'lmstudio'` when absent/names nothing (an
 * older config file has no `provider` key at all). A provider whose
 * preset was dropped by an upgrade falls back rather than leaving the
 * router pointed at nothing.
 */
export function normalizeLlmProvider(value: unknown): LlmProviderId {
  return (
    PROVIDER_PRESET_IDS.find((id) => id === value) ?? DEFAULT_APP_CONFIG.llm.provider
  );
}

function normalizeLlm(raw: unknown): LlmConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: bool(source['enabled'], DEFAULT_APP_CONFIG.llm.enabled),
    provider: normalizeLlmProvider(source['provider']),
    baseUrl:
      str(source['baseUrl'], DEFAULT_APP_CONFIG.llm.baseUrl).trim() ||
      DEFAULT_APP_CONFIG.llm.baseUrl,
    apiKey: optionalText(source['apiKey']),
    model: optionalText(source['model']),
  };
}

function normalizeAssistant(raw: unknown): AssistantConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    autoSummaryDefault: bool(
      source['autoSummaryDefault'],
      DEFAULT_APP_CONFIG.assistant.autoSummaryDefault,
    ),
  };
}

/** Keeps only entries that name a language and both dictionary files. */
function normalizeDictionaries(raw: unknown): CustomDictionary[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: CustomDictionary[] = [];
  const seen = new Set(BUNDLED_DICTIONARIES.map((d) => d.id));
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const source = item as Record<string, unknown>;
    const id = optionalText(source['id']);
    const affPath = optionalText(source['affPath']);
    const dicPath = optionalText(source['dicPath']);
    if (!id || !affPath || !dicPath || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({ id, label: optionalText(source['label']) ?? id, affPath, dicPath });
  }
  return out;
}

/** Trimmed, de-duplicated, blank-free string list; a non-array yields `[]`. */
function normalizeWordList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') {
      continue;
    }
    const word = item.trim();
    if (word !== '' && !seen.has(word)) {
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

/**
 * `{ <dictionaryId>: string[] }` -- per-dictionary accepted words. Any key
 * is allowed (custom dictionary ids are user-defined); a key whose list
 * normalises to empty is dropped so the default `{}` round-trips.
 */
function normalizeLanguageWords(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const words = normalizeWordList(value);
    if (words.length > 0) {
      out[key] = words;
    }
  }
  return out;
}

function normalizeMcp(raw: unknown): McpConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const port =
    typeof source['httpPort'] === 'number' && Number.isInteger(source['httpPort'])
      ? Math.min(MCP_PORT_MAX, Math.max(MCP_PORT_MIN, source['httpPort']))
      : DEFAULT_MCP_CONFIG.httpPort;
  return {
    enabled: bool(source['enabled'], DEFAULT_MCP_CONFIG.enabled),
    httpEnabled: bool(source['httpEnabled'], DEFAULT_MCP_CONFIG.httpEnabled),
    httpPort: port,
    yolo: bool(source['yolo'], DEFAULT_MCP_CONFIG.yolo),
  };
}

function normalizeDaily(raw: unknown): DailyConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    openOnStartup: bool(source['openOnStartup'], DEFAULT_DAILY_CONFIG.openOnStartup),
  };
}

/** Deduped list of non-empty strings -- the shape of both `*.disabled` lists. */
function normalizeDisabledList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0),
    ),
  ];
}

function normalizeWidgets(raw: unknown): WidgetsConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return { disabled: normalizeDisabledList(source['disabled']) };
}

function normalizePlugins(raw: unknown): PluginsConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return { disabled: normalizeDisabledList(source['disabled']) };
}

/**
 * A vault-relative folder: trimmed, back-slashes folded, no leading/trailing
 * slash, and no `.`/`..` segment (so it can never point outside the vault).
 * Anything malformed falls back to the default `templates`.
 */
export function normalizeTemplatesDir(raw: unknown): string {
  const cleaned = (typeof raw === 'string' ? raw : '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (cleaned === '' || cleaned.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return DEFAULT_TEMPLATES_CONFIG.dir;
  }
  return cleaned;
}

function normalizeTemplatesConfig(raw: unknown): TemplatesConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return { dir: normalizeTemplatesDir(source['dir']) };
}

function normalizeVault(raw: unknown): VaultConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return { watch: bool(source['watch'], DEFAULT_VAULT_CONFIG.watch) };
}

function normalizeEditor(raw: unknown): EditorConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    fontScale: clampEditorFontScale(source['fontScale']),
    fontFamily: normalizeEditorFontFamily(source['fontFamily']),
  };
}

function normalizeSpellcheck(raw: unknown): SpellcheckConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const dictionaries = normalizeDictionaries(source['dictionaries']);
  const language = optionalText(source['language']) ?? DEFAULT_APP_CONFIG.spellcheck.language;
  const known = new Set([
    ...BUNDLED_DICTIONARIES.map((d) => d.id),
    ...dictionaries.map((d) => d.id),
  ]);
  return {
    enabled: bool(source['enabled'], DEFAULT_APP_CONFIG.spellcheck.enabled),
    // A language whose custom dictionary was removed falls back to the
    // default rather than leaving the checker pointed at nothing.
    language: known.has(language) ? language : DEFAULT_APP_CONFIG.spellcheck.language,
    dictionaries,
    personalWords: normalizeWordList(source['personalWords']),
    languageWords: normalizeLanguageWords(source['languageWords']),
  };
}

function normalizeResultKind(value: unknown): ActionResultKind {
  return value === 'document' ? 'document' : 'localized';
}

function normalizeEvent(value: unknown): ActionEvent {
  return value === 'on-save' ? 'on-save' : 'manual';
}

/**
 * Rebuilds the template list: every built-in is always present exactly
 * once (a user's `name` / `prompt` / `resultKind` edits are kept, matched
 * by id), followed by whatever well-formed user templates the file holds.
 */
function normalizeTemplates(raw: unknown): ActionTemplate[] {
  const list = Array.isArray(raw) ? raw : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      byId.set((item as { id: string }).id, item as Record<string, unknown>);
    }
  }

  const out: ActionTemplate[] = [];
  for (const base of [noteSummaryTemplate(), searchSummaryTemplate(), autotagTemplate()]) {
    const saved = byId.get(base.id);
    byId.delete(base.id);
    out.push(
      saved
        ? {
            ...base,
            name: str(saved['name'], base.name),
            prompt: str(saved['prompt'], base.prompt),
            resultKind: normalizeResultKind(saved['resultKind']),
          }
        : base,
    );
  }

  for (const saved of byId.values()) {
    const name = str(saved['name'], '').trim();
    const prompt = str(saved['prompt'], '');
    if (!name || !prompt) {
      continue; // half-written entry -- drop it rather than surface a broken row
    }
    out.push({
      id: str(saved['id'], ''),
      name,
      prompt,
      resultKind: normalizeResultKind(saved['resultKind']),
      builtin: null,
    });
  }
  return out;
}

/**
 * Rebuilds the entry-template list, same rule as `normalizeTemplates`:
 * both built-ins present exactly once (keeping the user's `name` /
 * `pattern` edits, matched by id), then well-formed user templates.
 */
function normalizeEntryTemplates(raw: unknown): EntryTemplate[] {
  const list = Array.isArray(raw) ? raw : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      byId.set((item as { id: string }).id, item as Record<string, unknown>);
    }
  }

  const out: EntryTemplate[] = [];
  for (const base of [classicEntryTemplate(), ruledEntryTemplate()]) {
    const saved = byId.get(base.id);
    byId.delete(base.id);
    out.push(
      saved
        ? {
            ...base,
            name: str(saved['name'], base.name),
            pattern: str(saved['pattern'], base.pattern),
          }
        : base,
    );
  }

  for (const saved of byId.values()) {
    const name = str(saved['name'], '').trim();
    const pattern = str(saved['pattern'], '');
    if (!name || !pattern) {
      continue;
    }
    out.push({ id: str(saved['id'], ''), name, pattern, builtin: null });
  }
  return out;
}

function normalizeEntryConfig(raw: unknown): EntryConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const templates = normalizeEntryTemplates(source['templates']);
  const activeId = optionalText(source['activeId']) ?? '';
  return {
    templates,
    activeId: templates.some((template) => template.id === activeId)
      ? activeId
      : BUILTIN_ENTRY_TEMPLATE_IDS.classic,
  };
}

/**
 * Keeps every well-formed trigger whose `templateId` still resolves. A
 * missing `triggers` key (a fresh config) seeds the two built-in manual
 * triggers; an explicit empty array is respected (the user removed them).
 */
function normalizeTriggers(raw: unknown, templates: readonly ActionTemplate[]): ActionTrigger[] {
  if (raw === undefined) {
    return DEFAULT_APP_CONFIG.actions.triggers.map((t) => ({ ...t }));
  }
  const list = Array.isArray(raw) ? raw : [];
  const known = new Set(templates.map((t) => t.id));
  const out: ActionTrigger[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const source = item as Record<string, unknown>;
    const templateId = str(source['templateId'], '');
    const id = str(source['id'], '');
    if (!id || !known.has(templateId)) {
      continue;
    }
    out.push({
      id,
      templateId,
      event: normalizeEvent(source['event']),
      confirm: bool(source['confirm'], true),
      enabled: bool(source['enabled'], true),
    });
  }
  return out;
}

/** Parses an unknown blob (parsed JSON, IPC payload) into a complete `AppConfig`. */
export function normalizeAppConfig(raw: unknown): AppConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const actionsSource = (source['actions'] ?? {}) as Record<string, unknown>;
  const templates = normalizeTemplates(actionsSource['templates']);
  return {
    version: 1,
    llm: normalizeLlm(source['llm']),
    assistant: normalizeAssistant(source['assistant']),
    spellcheck: normalizeSpellcheck(source['spellcheck']),
    editor: normalizeEditor(source['editor']),
    appearance: normalizeAppearance(source['appearance']),
    mcp: normalizeMcp(source['mcp']),
    entry: normalizeEntryConfig(source['entry']),
    daily: normalizeDaily(source['daily']),
    templates: normalizeTemplatesConfig(source['templates']),
    vault: normalizeVault(source['vault']),
    widgets: normalizeWidgets(source['widgets']),
    plugins: normalizePlugins(source['plugins']),
    actions: {
      templates,
      triggers: normalizeTriggers(actionsSource['triggers'], templates),
    },
  };
}
