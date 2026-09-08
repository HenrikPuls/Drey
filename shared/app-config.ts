/**
 * App-level configuration -- the LLM connection, the Actions system
 * (prompt templates + trigger mappings), and per-action confirmation
 * preferences.
 *
 * This is *application* configuration, not vault content. It is stored in a
 * single JSON file under Electron's `userData` directory
 * (`electron/app-config.ts`), independent of which vault is open, and is
 * never written into the vault as Markdown. See
 * `docs/09_architecture_decisions/0010-app-settings-storage.md`.
 *
 * Imported by BOTH sides of the IPC boundary -- the main process owns the
 * file, the renderer's Settings screen edits it through `config:get` /
 * `config:set` -- so the shape lives here once, the same rule as
 * `shared/ipc-api.ts`.
 *
 * Every read goes through `normalizeAppConfig`, which fills missing keys
 * from `DEFAULT_APP_CONFIG`, re-injects the built-in templates, and drops
 * anything malformed -- so consumers on either side never have to
 * null-check the structure, only the values. Same defensive style as
 * `readConfig` in `electron/vault-manager.ts`, one level deeper.
 */

/** The LM Studio OpenAI-compatible endpoint, default port. */
export const LM_STUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';

/**
 * Just the two fields needed to reach an endpoint. The Settings screen
 * sends these as an override when probing `GET /models` / testing the
 * connection, so "Test connection" works on what is currently *typed*
 * rather than forcing a save first (`chat()` always uses saved config).
 */
export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string | null;
}

/** LLM connection settings (the "LLM" settings category). */
export interface LlmConfig {
  /**
   * Master switch. When `false`, classification, Actions, and the chat's
   * Ask mode are all disabled -- the renderer reflects this (the Ask/Input
   * toggle disables "Ask", `runAction` rejects).
   */
  enabled: boolean;
  /**
   * OpenAI-compatible base URL, `http://host:port/v1`. LM Studio is the
   * documented default, but any server speaking that dialect works --
   * Unsloth Desktop (`http://127.0.0.1:8888/v1`), llama.cpp, vLLM, Ollama.
   */
  baseUrl: string;
  /**
   * Bearer token sent as `Authorization: Bearer <key>` on every request,
   * or `null` for a server that needs none (LM Studio ignores it). Servers
   * that DO require one -- Unsloth Desktop issues `sk-unsloth-…` keys --
   * reject both `GET /models` and `POST /chat/completions` without it.
   *
   * Stored in plain text in the app config file, like every other desktop
   * client that talks to a local endpoint; see
   * `docs/11_risks_and_technical_debt.md`.
   */
  apiKey: string | null;
  /**
   * Model id, normally chosen from `GET /models` but free-form so a server
   * that doesn't expose that endpoint can still be driven by typing the id.
   * `null` until one is picked.
   */
  model: string | null;
}

/**
 * Which confirmation preview a template's result needs
 * (`docs/09_architecture_decisions/0011-unified-confirmation-flow.md`):
 * `'localized'` -> inline line-level diff of just the affected lines
 * (checking off a task, merging a couple of frontmatter tags);
 * `'document'` -> side-by-side before/after (a whole-document rewrite,
 * where a line diff carries no meaning).
 */
export type ActionResultKind = 'localized' | 'document';

/** The built-in templates that carry behaviour beyond "send prompt, replace document". */
export type BuiltinAction = 'note-summary' | 'search-summary' | 'autotag';

/** Trigger kinds available now. `'on-save'` fires from the `note:save` pipeline. */
export type ActionEvent = 'on-save' | 'manual';

/**
 * One entry in the template library (the "Actions" category, CRUD). A
 * user-created template is a name + prompt + result kind: its prompt is
 * sent to the model with the document as context and the reply replaces
 * the document. The `note-summary` built-in additionally routes through
 * dedicated code (the assistant panel's summary card) -- but its `prompt`
 * text is still the real prompt that path uses, so editing it here changes
 * behaviour and nothing is duplicated.
 */
export interface ActionTemplate {
  id: string;
  name: string;
  /** Prompt text sent to the model. */
  prompt: string;
  resultKind: ActionResultKind;
  /** `'note-summary'` for the built-in (editable, not deletable); `null` otherwise. */
  builtin: BuiltinAction | null;
}

/**
 * A trigger -> template mapping. `confirm` is the per-mapping
 * "confirmation required" toggle (defaults on); the "don't ask again for
 * this action" checkbox in the confirmation dialog flips it to `false`.
 * `enabled` lets a trigger be parked without deleting it.
 */
export interface ActionTrigger {
  id: string;
  templateId: string;
  event: ActionEvent;
  confirm: boolean;
  enabled: boolean;
}

/** Settings category "KI-Assistent": the note assistant panel's defaults. */
export interface AssistantConfig {
  /**
   * Pre-set of the panel's "Automatic summary" switch when a
   * note is opened. The panel switch overrides it for that note only and
   * never writes back here -- the default is changed in Settings, on
   * purpose, so a one-off "not for this note" cannot silently become the
   * new rule.
   */
  autoSummaryDefault: boolean;
}

/**
 * A Hunspell dictionary the user added themselves (Settings -> Spelling ->
 * "Add dictionary"). Bundled languages are not
 * listed here -- they ship with the app (`electron/spellcheck.ts`) and are
 * referenced by id alone.
 */
export interface CustomDictionary {
  /** Language id, e.g. `fr` or `de-at`; unique across bundled + custom. */
  id: string;
  /** What the settings list and the status line show. */
  label: string;
  /** Absolute path to the `.aff` file. */
  affPath: string;
  /** Absolute path to the `.dic` file. */
  dicPath: string;
}

/** Settings category "Spelling". */
export interface SpellcheckConfig {
  /** Master switch for the inline squiggles in the entry drawer. */
  enabled: boolean;
  /** Id of the active dictionary -- a bundled one (`de`, `en`) or a custom one. */
  language: string;
  /** User-added dictionaries, offered alongside the bundled ones. */
  dictionaries: CustomDictionary[];
}

/**
 * Editor content zoom. `Ctrl +` / `Ctrl -` / `Ctrl 0` (and `Ctrl`+wheel)
 * while an editor surface is focused scale only the text inside the
 * CodeMirror view -- headings, code and preview widgets included, because
 * every size in `editor-theme.ts` is `em`-relative to one base that this
 * multiplier drives. The sidebar, tab bar, entry drawer and assistant
 * panel are untouched.
 *
 * This replaced a main-process `webContents.setZoomFactor` zoom, which
 * scaled the whole window (chrome and all).
 *
 * `fontFamily` is the second editor-surface knob (Settings -> Appearance):
 * an id from `EDITOR_FONT_FAMILIES`, which `Editor` turns into a
 * `--font-sans` / `--drey-heading-font` override on its host so the choice
 * reaches only the document editor's subtree -- the same host-scoped CSS
 * variable trick `fontScale` uses.
 */
export interface EditorConfig {
  /** Font-size multiplier for the editor surface; 1 = the theme's base sizes. */
  fontScale: number;
  /** Id from `EDITOR_FONT_FAMILIES`; the editor body + heading typeface. */
  fontFamily: string;
}

export const EDITOR_FONT_SCALE_MIN = 0.6;
export const EDITOR_FONT_SCALE_MAX = 2.5;
export const EDITOR_FONT_SCALE_STEP = 0.1;

/**
 * The typeface choices offered in Settings -> Appearance for the document
 * editor. `body` feeds the host's `--font-sans` override (CodeMirror content
 * and the surrounding chrome), `heading` feeds `--drey-heading-font` (the
 * `editor-theme.ts` heading rules).
 *
 * These are concrete stacks, not `var(--font-sans)` references: the value is
 * assigned straight back onto `--font-sans` on the editor host, and
 * `--font-sans: var(--font-sans)` is a self-reference the CSS variable spec
 * treats as invalid-at-computed-value. They mirror `styles.css` (the
 * `--font-*` tokens) -- keep the two in sync.
 */
export interface EditorFontFamilyOption {
  id: string;
  label: string;
  body: string;
  heading: string;
}

const SANS_STACK = "system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif";
const SERIF_STACK = "'Newsreader', Georgia, 'Times New Roman', serif";
const MONO_STACK = "'IBM Plex Mono', 'Cascadia Code', 'Consolas', ui-monospace, monospace";

export const EDITOR_FONT_FAMILIES: readonly EditorFontFamilyOption[] = [
  { id: 'sans', label: 'Sans-serif', body: SANS_STACK, heading: SANS_STACK },
  { id: 'serif', label: 'Serif', body: SERIF_STACK, heading: SERIF_STACK },
  {
    id: 'serif-headings',
    label: 'Serif headings, sans body',
    body: SANS_STACK,
    heading: SERIF_STACK,
  },
  { id: 'mono', label: 'Monospace', body: MONO_STACK, heading: MONO_STACK },
];

export const DEFAULT_EDITOR_FONT_FAMILY = 'sans';

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

/**
 * App-wide look (Settings -> Appearance), distinct from the editor-only
 * `EditorConfig` knobs:
 *
 * - `uiScale` scales the *whole* renderer -- titlebar, docks, tabs, status
 *   bar, editor -- by driving `webContents.setZoomFactor` (the same
 *   mechanism as a browser's Ctrl +/-, so pointer coordinates and layout
 *   stay consistent). A preset, not a free number: four steps are enough and
 *   a slider invites fiddling.
 * - `accent` is the highlight colour. Either a preset id from
 *   `ACCENT_PRESETS`, or a `#rrggbb` hex for a custom pick. `AppearanceService`
 *   writes the resolved hex onto `--accent` at the document root; the
 *   `--accent-*` tint tokens in `styles.css` are `color-mix()`ed off it, so
 *   one value re-colours everything.
 */
export interface AppearanceConfig {
  uiScale: UiScale;
  accent: string;
}

export type UiScale = 'small' | 'default' | 'large' | 'xlarge';

/** `webContents.setZoomFactor` value for each `uiScale` step. */
export const UI_SCALE_FACTORS: Record<UiScale, number> = {
  small: 0.9,
  default: 1,
  large: 1.15,
  xlarge: 1.3,
};

export const UI_SCALE_LABELS: Record<UiScale, string> = {
  small: 'Small',
  default: 'Default',
  large: 'Large',
  xlarge: 'X-Large',
};

export interface AccentPreset {
  id: string;
  label: string;
  hex: string;
}

/** The curated highlight colours (the first is the default terracotta). */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'terracotta', label: 'Terracotta', hex: '#c96442' },
  { id: 'sage', label: 'Sage', hex: '#7d8f6e' },
  { id: 'slate', label: 'Slate blue', hex: '#6e83a0' },
  { id: 'violet', label: 'Violet', hex: '#8b7fa8' },
  { id: 'amber', label: 'Amber', hex: '#c98a3c' },
  { id: 'teal', label: 'Teal', hex: '#4f9a90' },
];

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  uiScale: 'default',
  accent: ACCENT_PRESETS[0].id,
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** A stored scale step, or `'default'` when it names no known step. */
export function normalizeUiScale(value: unknown): UiScale {
  return value === 'small' || value === 'large' || value === 'xlarge' || value === 'default'
    ? value
    : DEFAULT_APPEARANCE.uiScale;
}

/** A known preset id or a `#rrggbb` hex; anything else falls back to the default. */
export function normalizeAccent(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_APPEARANCE.accent;
  }
  if (ACCENT_PRESETS.some((preset) => preset.id === value)) {
    return value;
  }
  return HEX_RE.test(value) ? value.toLowerCase() : DEFAULT_APPEARANCE.accent;
}

/** The concrete `#rrggbb` for an `accent` value (preset id -> its hex; hex -> itself). */
export function resolveAccentHex(accent: string): string {
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
  };
}

/**
 * The vault MCP server (`electron/mcp/`,
 * `docs/09_architecture_decisions/0021-*.md`). One tool set --
 * `vault_search` (with a regex filter), `vault_read`, `vault_write` --
 * exposed two ways and also callable by the built-in assistant.
 */
export interface McpConfig {
  /**
   * Master switch. Off: no MCP server, and the assistant does not call
   * vault tools. On: the tool set is available in-process to the
   * assistant, and (with `httpEnabled`) over the network.
   */
  enabled: boolean;
  /**
   * Also open the localhost Streamable-HTTP endpoint
   * (`http://127.0.0.1:<httpPort>/mcp`) that any network MCP client -- and
   * the bundled stdio bridge -- connects to. A listening socket, so it is
   * opt-in on top of `enabled`.
   */
  httpEnabled: boolean;
  /** Port for the localhost HTTP endpoint. */
  httpPort: number;
  /**
   * "YOLO mode": apply a `vault_write` tool call WITHOUT the confirmation
   * diff. Off by default and meant to stay off -- a model (local or a
   * remote client's) can otherwise overwrite vault files unattended.
   */
  yolo: boolean;
}

export const MCP_PORT_MIN = 1024;
export const MCP_PORT_MAX = 65535;

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: false,
  httpEnabled: false,
  httpPort: 4319,
  yolo: false,
};

export interface AppConfig {
  /** Bumped only on a breaking shape change; `normalizeAppConfig` migrates. */
  version: 1;
  llm: LlmConfig;
  assistant: AssistantConfig;
  spellcheck: SpellcheckConfig;
  editor: EditorConfig;
  appearance: AppearanceConfig;
  mcp: McpConfig;
  actions: {
    templates: ActionTemplate[];
    triggers: ActionTrigger[];
  };
}

/** The dictionaries that ship with the app; `electron/spellcheck.ts` loads them. */
export const BUNDLED_DICTIONARIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
];

/** Stable ids so `normalizeAppConfig` can re-attach a user's edits to the built-ins. */
export const BUILTIN_TEMPLATE_IDS: Record<BuiltinAction, string> = {
  'note-summary': 'builtin:note-summary',
  'search-summary': 'builtin:search-summary',
  autotag: 'builtin:autotag',
};

/**
 * The system prompt behind the note assistant's automatic summary (the
 * first card in a note's sidecar thread, `shared/chat-thread.ts`). Short
 * on purpose: the card sits in a 340px panel, so anything longer than a
 * few sentences is scrolled past rather than read.
 */
export const NOTE_SUMMARY_PROMPT = `Summarise a note for the sidebar. Write 1 to 3 full sentences, no bullet points, no greeting, no heading. Say only what the note is about. Return the summary text and nothing else.`;

/**
 * The system prompt for the tag-search "Summarise" button: the matching
 * sections go in as the user message, a short prose digest comes out.
 * English (the language sweep landed this one already).
 */
export const SEARCH_SUMMARY_PROMPT = `You are given the sections of a personal note vault that match a search. Write a short prose digest (3–6 sentences, present tense, no bullet points, no greeting, no heading) of what they collectively say. Note any contradictions or open questions last. Return only the digest text.`;

function noteSummaryTemplate(): ActionTemplate {
  return {
    id: BUILTIN_TEMPLATE_IDS['note-summary'],
    name: 'Summarise note',
    prompt: NOTE_SUMMARY_PROMPT,
    // The result is a panel card, never a document edit -- `resultKind`
    // is irrelevant for it, but the field is not optional; `'document'`
    // is the honest value should it ever be run as a plain action.
    resultKind: 'document',
    builtin: 'note-summary',
  };
}

function searchSummaryTemplate(): ActionTemplate {
  return {
    id: BUILTIN_TEMPLATE_IDS['search-summary'],
    name: 'Summarise search results',
    prompt: SEARCH_SUMMARY_PROMPT,
    resultKind: 'document',
    builtin: 'search-summary',
  };
}

/**
 * The system prompt behind the drawer's "Autotag" button. `{tags}` is
 * swapped for the vocabulary list (one tag per line) at call time. The
 * reply only pre-fills the drawer's tag field -- the user still confirms
 * by saving.
 */
export const AUTOTAG_PROMPT = `You are given a short note and the tags already used in this vault. Suggest 1 to 4 tags for the note: reuse tags from the list where they fit, and otherwise propose new tags (one word, lowercase, no spaces).

Existing tags:
{tags}

Respond ONLY with JSON, no prose: {"tags": ["tag1", "tag2"]}`;

function autotagTemplate(): ActionTemplate {
  return {
    id: BUILTIN_TEMPLATE_IDS.autotag,
    name: 'Autotag',
    prompt: AUTOTAG_PROMPT,
    resultKind: 'localized',
    builtin: 'autotag',
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1,
  llm: {
    enabled: false,
    baseUrl: LM_STUDIO_DEFAULT_BASE_URL,
    apiKey: null,
    model: null,
  },
  assistant: {
    autoSummaryDefault: true,
  },
  spellcheck: {
    enabled: true,
    language: 'de',
    dictionaries: [],
  },
  editor: {
    fontScale: 1,
    fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
  },
  appearance: { ...DEFAULT_APPEARANCE },
  mcp: { ...DEFAULT_MCP_CONFIG },
  actions: {
    templates: [noteSummaryTemplate(), searchSummaryTemplate(), autotagTemplate()],
    triggers: [],
  },
};

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

function normalizeLlm(raw: unknown): LlmConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: bool(source['enabled'], DEFAULT_APP_CONFIG.llm.enabled),
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
    actions: {
      templates,
      triggers: normalizeTriggers(actionsSource['triggers'], templates),
    },
  };
}
