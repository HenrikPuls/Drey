/**
 * App-config **shapes** and the constant data that goes with them -- the
 * LLM connection, the Actions system (prompt templates + trigger mappings),
 * per-action confirmation preferences, Appearance, Spelling, and the rest of
 * the Settings categories.
 *
 * This is *application* configuration, not vault content. It is stored in a
 * single JSON file under Electron's `userData` directory
 * (`electron/app-config.ts`), independent of which vault is open, and is
 * never written into the vault as Markdown. See
 * `docs/09_architecture_decisions/0010-app-settings-storage.md`.
 *
 * Split across three files, re-exported from `shared/app-config.ts`:
 *   - `schema.ts`    -- this file: `interface` / `type` shapes + constant data
 *   - `defaults.ts`  -- `DEFAULT_APP_CONFIG` and the built-in template factories
 *   - `normalize.ts` -- `normalizeAppConfig` and the pure value helpers
 *
 * Imported by BOTH sides of the IPC boundary -- the main process owns the
 * file, the renderer's Settings screen edits it through `config:get` /
 * `config:set` -- so the shape lives here once, the same rule as
 * `shared/ipc-api.ts`.
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

/**
 * Settings category "Add entry": the Markdown block the capture drawer
 * appends is a chosen template. Placeholders: `{{time}}`, `{{date}}`,
 * `{{datetime}}`, `{{title}}` (empty or ` — <Topic>`), `{{tags}}` (empty
 * or `#a #b`), `{{content}}` (the body). `shared/entry-compose.ts`
 * substitutes them and collapses blank lines.
 */
export interface EntryTemplate {
  id: string;
  name: string;
  pattern: string;
  /** `'classic'` / `'ruled'` for a built-in (editable, not deletable); `null` otherwise. */
  builtin: 'classic' | 'ruled' | null;
}

export interface EntryConfig {
  templates: EntryTemplate[];
  /** Id of the template the drawer uses; falls back to the classic built-in. */
  activeId: string;
}

/** Reproduces the pre-template output: heading, body, tag line. */
export const CLASSIC_ENTRY_PATTERN = '## {{time}}{{title}}\n{{content}}\n{{tags}}';
/** Heading, a rule, the tags, then the body. */
export const RULED_ENTRY_PATTERN = '## {{time}}{{title}}\n---\n{{tags}}\n\n{{content}}';

export const BUILTIN_ENTRY_TEMPLATE_IDS: Record<'classic' | 'ruled', string> = {
  classic: 'builtin:entry-classic',
  ruled: 'builtin:entry-ruled',
};

/** Settings category "Daily notes". */
export interface DailyConfig {
  /**
   * Open today's daily note automatically on app start. It opens as an
   * unsaved draft tab (nothing is written until the user types and saves),
   * exactly like clicking today in the calendar.
   */
  openOnStartup: boolean;
}

/**
 * Settings category "Widgets": which dock widgets are switched off entirely
 * (removed from every dock *and* the View menu). Stored as the exception
 * list -- every registered widget is enabled unless its id is here -- so a
 * widget added by an app update shows up without a migration. The id space
 * is the renderer's `WIDGETS` registry; unknown ids are kept verbatim (the
 * renderer ignores them) so a downgrade doesn't lose the user's choice.
 */
export interface WidgetsConfig {
  disabled: string[];
}

/**
 * Settings category "Templates": the vault folder whose `.md` files back
 * the Templates panel and the `Mod+T` picker. Folders are categories,
 * sub-folders sub-categories; a template is inserted at the cursor with its
 * YAML frontmatter stripped and `{{date}}`/`{{time}}`/`{{datetime}}`/`{{title}}`
 * substituted.
 */
export interface TemplatesConfig {
  /** Vault-relative folder, forward-slash, no leading/trailing slash. */
  dir: string;
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
  /**
   * Words accepted in **every** dictionary -- project names, people, terms
   * that are not language-specific. Shown in Settings as "Personal words".
   */
  personalWords: string[];
  /**
   * Words accepted only under a specific dictionary id (`de`, `en`, or a
   * custom id). Keys with an empty list are dropped on normalisation.
   */
  languageWords: Record<string, string[]>;
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
 *   `ACCENT_PRESETS`, a `#rrggbb` hex for a custom pick, or the sentinel
 *   `'theme'` (the default) meaning "follow the active theme's seed accent".
 *   `AppearanceService` writes the resolved hex onto `--accent` at the
 *   document root; the `--accent-*` tint tokens in `styles.css` are
 *   `color-mix()`ed off it, so one value re-colours everything.
 * - `theme` is an id from the renderer's theme catalog
 *   (`src/app/editor/themes/theme-catalog.ts`) -- `'drey'` is the built-in
 *   look, every other id is a published CodeMirror 6 theme whose editor
 *   colours are swapped in a compartment and whose shell palette is derived
 *   from a seed. `shared/` cannot import the catalog, so this is a plain
 *   string; the catalog resolves an unknown id back to `'drey'`.
 */
export interface AppearanceConfig {
  uiScale: UiScale;
  accent: string;
  theme: string;
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

/**
 * The `accent` sentinel: follow the active theme's own seed accent rather
 * than a fixed preset / hex. `resolveAccentHex` needs the theme accent
 * passed in to turn this into a concrete colour.
 */
export const THEME_ACCENT = 'theme';

/** Built-in theme id -- the bespoke "Drey v3" look, no shell derivation. */
export const DEFAULT_THEME = 'drey';

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

export interface AppConfig {
  /** Bumped only on a breaking shape change; `normalizeAppConfig` migrates. */
  version: 1;
  llm: LlmConfig;
  assistant: AssistantConfig;
  spellcheck: SpellcheckConfig;
  editor: EditorConfig;
  appearance: AppearanceConfig;
  mcp: McpConfig;
  entry: EntryConfig;
  daily: DailyConfig;
  templates: TemplatesConfig;
  widgets: WidgetsConfig;
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
