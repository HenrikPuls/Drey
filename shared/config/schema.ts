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
import type { LlmCapabilities } from '../llm';

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

/**
 * Which backend the `LlmClient` router picks per call (ADR-0047). The
 * default stays the local OpenAI-compatible endpoint; every other entry is
 * a documented, opt-in exception to the app's local-first rule.
 */
export type LlmProviderId =
  | 'lmstudio' // local OpenAI-compat, http://localhost:1234/v1, key optional
  | 'openai-compat' // same client, any user-typed URL (Ollama/vLLM/llama.cpp/Unsloth/...)
  | 'openrouter' // openai-compat client, https://openrouter.ai/api/v1, key required
  | 'anthropic' // Anthropic-Messages client, https://api.anthropic.com
  | 'zai-glm' // Anthropic-Messages client, https://api.z.ai/api/anthropic (GLM Coding Plan)
  | 'claude-code' // `claude -p` headless CLI, stream-json + --resume sessions
  | 'copilot-cli' // `copilot -p` CLI (capabilities per spike)
  | 'copilot-web'; // Playwright + system Edge scraper (ADR-0040)

/** How a provider is reached -- picks the client class AND the Settings field group. */
export type LlmProviderClient =
  | 'openai-compat'
  | 'anthropic-messages'
  | 'claude-code-cli'
  | 'copilot-cli'
  | 'copilot-web';

/** Which field block the LLM settings page renders for a provider. */
export type LlmProviderFieldGroup = 'http' | 'cli' | 'copilot-web';

/**
 * One entry of `PROVIDER_PRESETS`: the static facts the Settings screen
 * renders from without instantiating anything. `capabilities` is a static
 * copy for the hint text; `capabilities()` on the live provider is the
 * runtime truth (they are kept in sync by construction).
 */
export interface LlmProviderPreset {
  label: string;
  client: LlmProviderClient;
  /** Initial `baseUrl` when switching to this provider; `null` for field-less groups. */
  defaultBaseUrl: string | null;
  requiresApiKey: boolean;
  capabilities: LlmCapabilities;
  fieldGroup: LlmProviderFieldGroup;
}

const HTTP_TOOLS: LlmCapabilities = {
  tools: true,
  streaming: true,
  sessions: false,
  modelListing: true,
  imageAttachments: true,
};

const NO_TOOLS: LlmCapabilities = {
  tools: false,
  streaming: true,
  sessions: false,
  modelListing: false,
  imageAttachments: false,
};

/**
 * The provider catalogue behind the Settings "LLM" provider select. The
 * first entry is the app's default and the only one that needs nothing
 * from the network outside the user's machine.
 */
export const PROVIDER_PRESETS: Record<LlmProviderId, LlmProviderPreset> = {
  lmstudio: {
    label: 'LM Studio (local)',
    client: 'openai-compat',
    defaultBaseUrl: LM_STUDIO_DEFAULT_BASE_URL,
    requiresApiKey: false,
    capabilities: HTTP_TOOLS,
    fieldGroup: 'http',
  },
  'openai-compat': {
    label: 'OpenAI-compatible server',
    client: 'openai-compat',
    defaultBaseUrl: LM_STUDIO_DEFAULT_BASE_URL,
    requiresApiKey: false,
    capabilities: HTTP_TOOLS,
    fieldGroup: 'http',
  },
  openrouter: {
    label: 'OpenRouter',
    client: 'openai-compat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    capabilities: HTTP_TOOLS,
    fieldGroup: 'http',
  },
  anthropic: {
    label: 'Anthropic API',
    client: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    capabilities: HTTP_TOOLS,
    fieldGroup: 'http',
  },
  'zai-glm': {
    label: 'Z.ai GLM (Coding Plan)',
    client: 'anthropic-messages',
    defaultBaseUrl: 'https://api.z.ai/api/anthropic',
    requiresApiKey: true,
    capabilities: HTTP_TOOLS,
    fieldGroup: 'http',
  },
  'claude-code': {
    label: 'Claude Code (CLI)',
    client: 'claude-code-cli',
    defaultBaseUrl: null,
    requiresApiKey: false,
    capabilities: { ...NO_TOOLS, sessions: true },
    fieldGroup: 'cli',
  },
  'copilot-cli': {
    label: 'GitHub Copilot CLI',
    client: 'copilot-cli',
    defaultBaseUrl: null,
    requiresApiKey: false,
    capabilities: NO_TOOLS,
    fieldGroup: 'cli',
  },
  'copilot-web': {
    label: 'Copilot Web (M365)',
    client: 'copilot-web',
    defaultBaseUrl: null,
    requiresApiKey: false,
    capabilities: NO_TOOLS,
    fieldGroup: 'copilot-web',
  },
};

/**
 * The ids in a form `normalizeLlmProvider` (and a `<select>`) can walk.
 * Derived, kept next to the record so a new preset cannot forget itself.
 */
export const PROVIDER_PRESET_IDS = Object.keys(PROVIDER_PRESETS) as LlmProviderId[];

/** LLM connection settings (the "LLM" settings category). */
export interface LlmConfig {
  /**
   * Master switch. When `false`, classification, Actions, and the chat's
   * Ask mode are all disabled -- the renderer reflects this (the Ask/Input
   * toggle disables "Ask", `runAction` rejects).
   */
  enabled: boolean;
  /**
   * Which provider preset is active; `LlmRouter` re-reads it per call, so
   * switching applies on the next request without a restart. Defaults to
   * the local endpoint.
   */
  provider: LlmProviderId;
  /**
   * The base URL of the active HTTP preset (`fieldGroup: 'http'`): for the
   * OpenAI-compat client `http://host:port/v1` (LM Studio is the
   * documented default; Unsloth Desktop, llama.cpp, vLLM, Ollama speak the
   * same dialect), for the Anthropic-Messages client the API root
   * (`https://api.anthropic.com`, `https://api.z.ai/api/anthropic`). CLI
   * and web presets ignore it. Switching provider in Settings pre-fills
   * the preset's default.
   */
  baseUrl: string;
  /**
   * Bearer token sent as `Authorization: Bearer <key>` on every request,
   * or `null` for a server that needs none (LM Studio ignores it). Servers
   * that DO require one -- Unsloth Desktop issues `sk-unsloth-…` keys --
   * reject both `GET /models` and `POST /chat/completions` without it.
   *
   * Plain here and over IPC; encrypted in the app config file with the OS
   * user's key (`electron/config-secrets.ts`, ADR-0010 later change).
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
export type BuiltinAction = 'search-summary' | 'autotag' | 'lossless-format';

/** Trigger kinds available now. `'on-save'` fires from the `note:save` pipeline. */
export type ActionEvent = 'on-save' | 'manual';

/**
 * One entry in the template library (the "Actions" category, CRUD). A
 * user-created template is a name + prompt + result kind: its prompt is
 * sent to the model with the document as context and the reply replaces
 * the document.
 */
export interface ActionTemplate {
  id: string;
  name: string;
  /** Prompt text sent to the model. */
  prompt: string;
  resultKind: ActionResultKind;
  /** The built-in id (editable, not deletable); `null` for a user template. */
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
  /**
   * Vault-relative root folder the daily notes live in (app config per
   * ADR-0010, so one folder shape across all vaults). Year and month
   * sub-folders and the `YYYY-MM-DD.md` file name stay fixed -- they are
   * the grammar the calendar matches against; legacy flat files inside the
   * folder stay readable. Notes left under a previous folder are not
   * migrated and no longer read.
   */
  dir: string;
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
 * Settings category "Plugins": which plugins are switched off entirely
 * (never imported, main or renderer side; ADR-0044). Same exception-list
 * pattern as `WidgetsConfig` -- a plugin is enabled unless its id is here,
 * and unknown ids are kept verbatim so a downgrade doesn't lose the
 * choice. A toggle lands on the next app start (restart to apply).
 */
export interface PluginsConfig {
  disabled: string[];
}

/**
/**
 * One editable editor snippet (milestone 46): a typed trigger word that
 * offers a multi-line Markdown block with CodeMirror `${n:placeholder}`
 * tabstops. Part of the app config (ADR-0010) — a machine-level editing
 * preference, not vault data.
 */
export interface SnippetConfig {
  /** The typed word that offers the snippet: letters/digits/`-`, lower-cased. */
  trigger: string;
  /** Display name in the completion popup and the Settings list. */
  label: string;
  /** CodeMirror snippet template: `${1:placeholder}` fields, `$0` final caret. */
  template: string;
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
  /**
   * The editor snippet library (milestone 46), seeded with the three
   * built-ins when the key is absent, then fully user-owned: Settings →
   * Templates edits, removes and adds entries — defaults included — and
   * an explicitly emptied list stays empty (only a MISSING key re-seeds).
   */
  snippets: SnippetConfig[];
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
  /**
   * Detects the language of each paragraph and checks it against the
   * dictionary of that language (ADR-0056). The `language` id above is
   * the fallback for blocks too short or too ambiguous to detect and for
   * detected languages that have no dictionary installed -- text in a
   * language without a dictionary stays checked against the active one.
   */
  autoDetect: boolean;
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

/**
 * The Drey theme id -- the original terracotta "Drey v3" look, an optional
 * theme since Anthrazit became the default. It is the un-themed `:root`
 * palette, so it carries no `data-theme` and no shell derivation.
 */
export const DREY_THEME = 'drey';

/**
 * The Anthrazit theme (milestone 43): the neutral charcoal-gray palette with the
 * blue accent. The fresh-install default — `DEFAULT_APPEARANCE` starts on it
 * and `normalizeTheme` falls back to it, so a stored config without a
 * `theme` key resolves here too (the fallback was aligned with
 * `DEFAULT_APPEARANCE` when the default flipped; only an explicit `'drey'`
 * keeps the old look).
 */
export const ANTHRAZIT_THEME = 'anthrazit';

/**
 * The Cyberpunk theme: violet-black surfaces, neon pink and violet. Named
 * here because main needs it too -- it is the one theme with its own app
 * mark (`shared/app-icon.ts`).
 */
export const CYBERPUNK_THEME = 'cyberpunk';

/**
 * The vault MCP server (`electron/mcp/`,
 * `docs/09_architecture_decisions/0021-*.md`). One tool set --
 * `vault_search` (with a regex filter), `vault_read`, `vault_write` --
 * exposed two ways and also callable by the built-in assistant.
 */
export interface McpConfig {
  /**
   * Master switch of the server Drey offers to OTHER programs. What the
   * built-in assistant may call is `tools` (milestone 63, ADR-0063) --
   * the two were one switch before.
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
   * "YOLO mode": apply an MCP client's `vault_write` WITHOUT the
   * confirmation diff. Off by default and meant to stay off. The
   * assistant's own writes follow `tools.vault.write`.
   */
  yolo: boolean;
}

/** Whether a tool group's writes show the ADR-0011 diff first. */
export type ToolWriteMode = 'confirm' | 'auto';
/** Whether a call that leaves the machine is asked for first. */
export type ToolApprovalMode = 'ask' | 'allow';

export interface McpStdioTransport {
  kind: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHttpTransportConfig {
  kind: 'http';
  url: string;
  headers: Record<string, string>;
}

/** One external MCP server the assistant may call (milestone 63, ADR-0063). */
export interface McpClientServer {
  /** Slug (`[a-z0-9-]`), unique; the tool prefix `mcp__<id>__`. */
  id: string;
  name: string;
  enabled: boolean;
  approval: ToolApprovalMode;
  transport: McpStdioTransport | McpHttpTransportConfig;
}

/**
 * What the built-in assistant may call (milestone 63, ADR-0063): one
 * switch per tool group, one write rule per writing group, one approval
 * rule per source that leaves the machine. Everything external is off by
 * default.
 */
export interface ToolsConfig {
  vault: { enabled: boolean; write: ToolWriteMode };
  tasks: { enabled: boolean };
  templates: { enabled: boolean; write: ToolWriteMode };
  webFetch: { enabled: boolean; approval: ToolApprovalMode };
  servers: McpClientServer[];
  /**
   * How many rounds of tool calls one question may take (milestone 76,
   * ADR-0071). When it is used up the model is asked once for its answer
   * without tools.
   */
  maxRounds: number;
}

export const TOOL_ROUNDS_DEFAULT = 12;
export const TOOL_ROUNDS_MIN = 1;
export const TOOL_ROUNDS_MAX = 50;

export const MCP_SERVER_ID_MAX = 24;

export const MCP_PORT_MIN = 1024;
export const MCP_PORT_MAX = 65535;

/** Settings category "Vault": how the app keeps up with external changes. */
export interface VaultConfig {
  /**
   * Watch the active vault for external changes (chokidar, ADR-0045) and
   * turn them into the same refresh round a manual refresh runs: the
   * plugins' indexes update, the file tree reloads, and clean open tabs
   * re-read from disk (dirty tabs stay last-writer-wins). Off by default
   * -- manual refresh stays the norm (ADR-0018).
   */
  watch: boolean;
  /**
   * What a rename / move in the Files panel does about the links and
   * attachments it would break (milestone 59, ADR-0059): `'ask'` shows the
   * affected notes first, `'always'` rewrites without asking, `'never'`
   * only renames.
   */
  updateLinksOnRename: UpdateLinksMode;
  /** Local note history (milestone 60, ADR-0060). */
  history: VaultHistoryConfig;
}

/**
 * Earlier versions of notes, kept under the OS user-data dir -- never in
 * the vault. `keepDays` and `maxPerFile` bound it; whichever is hit
 * first drops the oldest version.
 */
export interface VaultHistoryConfig {
  enabled: boolean;
  keepDays: number;
  maxPerFile: number;
}

export type UpdateLinksMode = 'ask' | 'always' | 'never';
export const UPDATE_LINKS_MODES: readonly UpdateLinksMode[] = ['ask', 'always', 'never'];

export interface AppConfig {
  /** Bumped only on a breaking shape change; `normalizeAppConfig` migrates. */
  version: 1;
  llm: LlmConfig;
  spellcheck: SpellcheckConfig;
  editor: EditorConfig;
  appearance: AppearanceConfig;
  mcp: McpConfig;
  tools: ToolsConfig;
  entry: EntryConfig;
  daily: DailyConfig;
  templates: TemplatesConfig;
  vault: VaultConfig;
  widgets: WidgetsConfig;
  plugins: PluginsConfig;
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
  'search-summary': 'builtin:search-summary',
  autotag: 'builtin:autotag',
  'lossless-format': 'builtin:lossless-format',
};

/**
 * The system prompt for the tag-search "Summarize" button (milestone 37):
 * the matching sections go in as the user message, a structured topic
 * digest comes out. Shipped as the editable `builtin:search-summary`
 * Action template — the summarise backend loads the stored (possibly
 * user-edited) text from app config and only falls back to this constant.
 * English (the language sweep landed this one already); the digest itself
 * follows the notes' language.
 */
export const SEARCH_SUMMARY_PROMPT = `You are given the sections of a personal note vault that matched a search, each introduced by its path, line and heading. Write a comprehensive digest of what they collectively say about the search topic, in the same language as the notes. Group the material into short thematic blocks, each opening with a bold lead-in; within a block state the key facts, decisions and arguments concretely (names, dates, numbers) instead of paraphrasing vaguely. Never invent content that is not in the sections. End with a paragraph "Open questions / contradictions" listing what the sections leave unresolved or state inconsistently — omit it when there is none. Cite sources by their path in parentheses where that helps navigation. No greeting, no top-level heading, no closing pleasantries. Return only the digest text.`;

/**
 * The default `SEARCH_SUMMARY_PROMPT` text before milestone 37 reworded it.
 * `normalizeAppConfig` refreshes a stored `builtin:search-summary` whose
 * prompt still equals this — the user never edited it — while a genuine
 * user edit keeps its text.
 */
export const LEGACY_SEARCH_SUMMARY_PROMPT = `You are given the sections of a personal note vault that match a search. Write a short prose digest (3–6 sentences, present tense, no bullet points, no greeting, no heading) of what they collectively say. Note any contradictions or open questions last. Return only the digest text.`;

/**
 * The system prompt behind the editor's `⋯` "Suggest tags" row (the
 * re-homed Autotag). `{{AVAILABLE_TAGS}}` is swapped for the vocabulary
 * list (one tag per line) at call time — the one token every prompt
 * shares (`shared/llm/prompt-substitution.ts`); the suggested tags are
 * applied to the note section directly, deduplicated against the tags
 * it already carries.
 */
export const AUTOTAG_PROMPT = `You are given a short note and the tags already used in this vault. Suggest 1 to 4 tags for the note: reuse tags from the list where they fit, and otherwise propose new tags (one word, lowercase, no spaces).

Existing tags:
{{AVAILABLE_TAGS}}

Respond ONLY with JSON, no prose: {"tags": ["tag1", "tag2"]}`;

/**
 * The default `AUTOTAG_PROMPT` text before the lossless template aligned
 * the vocabulary token (`{tags}` -> `{{AVAILABLE_TAGS}}`).
 * `normalizeAppConfig` refreshes a stored `builtin:autotag` whose prompt
 * still equals this — the user never edited it — while a genuine user
 * edit keeps its text (the legacy `{tags}` keeps being substituted).
 */
export const LEGACY_AUTOTAG_PROMPT = `You are given a short note and the tags already used in this vault. Suggest 1 to 4 tags for the note: reuse tags from the list where they fit, and otherwise propose new tags (one word, lowercase, no spaces).

Existing tags:
{tags}

Respond ONLY with JSON, no prose: {"tags": ["tag1", "tag2"]}`;

/**
 * The built-in "Structure note" Action template (roadmap "Lossless
 * Markdown template"): turns a raw note into structured Markdown
 * without adding or interpreting anything, and tags it from the
 * existing vocabulary only. Ships like the other built-ins (editable in
 * Settings → Actions); the note itself rides the user message like for
 * every action — only `{{AVAILABLE_TAGS}}` is substituted into the
 * system prompt. The reply is free Markdown and goes through the
 * ADR-0011 whole-document confirmation (`resultKind: 'document'`).
 */
export const LOSSLESS_FORMAT_PROMPT = `Transform the note into structured Markdown.

This is a lossless formatting task, not a summarization task.

STRICT REQUIREMENTS:

- Preserve all factual information from the source.
- Never add information that is not explicitly contained in the source.
- Never infer missing context.
- Never answer questions found in the source.
- Never interpret the author's intentions.
- Never create decisions, conclusions, tasks, deadlines, or responsibilities unless explicitly stated.
- Keep the original language.
- Correct only obvious spelling or grammar errors.
- Retain uncertainty, open questions, and incomplete information as such.
- Group related statements when this can be done without interpretation.
- Use headings and bullet points only where they improve readability.
- Preserve chronological relationships.

TAGGING:

The valid tags are listed in AVAILABLE_TAGS.

- Only use tags from AVAILABLE_TAGS; never create new tags.
- Add a tag only when the note provides direct evidence that it applies.
- If multiple tags could apply and the choice is ambiguous, add none.
- Add person tags only when that person is explicitly mentioned; match names against AVAILABLE_TAGS and do not infer a person's identity from context alone.
- Avoid redundant and overly broad tags.

Output only the final Markdown.

AVAILABLE_TAGS:
{{AVAILABLE_TAGS}}`;
