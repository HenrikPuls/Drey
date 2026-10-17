/**
 * The factory built-ins and `DEFAULT_APP_CONFIG` -- the value every missing
 * key in a stored config falls back to. Split out of `schema.ts` (shapes)
 * and `normalize.ts` (validation); re-exported from `shared/app-config.ts`.
 */
import { DEFAULT_DAILY_DIR } from '../daily';
import { DEFAULT_CAPTURE_CHORD } from '../keybindings';
import {
  ActionTemplate,
  ActionTrigger,
  AppConfig,
  AppearanceConfig,
  BUILTIN_ENTRY_TEMPLATE_IDS,
  TOOL_ROUNDS_DEFAULT,
  BUILTIN_TEMPLATE_IDS,
  CLASSIC_ENTRY_PATTERN,
  DEFAULT_EDITOR_FONT_FAMILY,
  ANTHRAZIT_THEME,
  DailyConfig,
  EntryTemplate,
  LM_STUDIO_DEFAULT_BASE_URL,
  LOSSLESS_FORMAT_PROMPT,
  McpConfig,
  ToolsConfig,
  UpdatesConfig,
  RULED_ENTRY_PATTERN,
  SEARCH_SUMMARY_PROMPT,
  AUTOTAG_PROMPT,
  SnippetConfig,
  TemplatesConfig,
  THEME_ACCENT,
  VaultConfig,
  WidgetsConfig,
} from './schema';

export const DEFAULT_DAILY_CONFIG: DailyConfig = {
  openOnStartup: true,
  dir: DEFAULT_DAILY_DIR,
};

export const DEFAULT_WIDGETS_CONFIG: WidgetsConfig = { disabled: [] };

/**
 * The snippet library's seed (milestone 46): shipped as the starting point,
 * then user-owned — every entry is editable and removable in Settings →
 * Templates, and "Restore built-ins" puts exactly these back.
 */
export const SNIPPET_DEFAULTS: SnippetConfig[] = [
  {
    trigger: 'tbl',
    label: 'Table',
    template: '| ${1:Column} | ${2:Column} | ${3:Column} |\n| --- | --- | --- |\n| ${4:} | ${5:} | ${6:} |',
  },
  {
    trigger: 'code',
    label: 'Code block',
    template: '```${1:ts}\n$0\n```',
  },
  {
    trigger: 'task',
    label: 'Checklist',
    template: '- [ ] ${1:First}\n- [ ] ${2:Second}\n- [ ] ${3:Third}',
  },
];

export const DEFAULT_TEMPLATES_CONFIG: TemplatesConfig = { dir: 'templates', snippets: SNIPPET_DEFAULTS };

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  watch: false,
  updateLinksOnRename: 'ask',
  history: { enabled: true, keepDays: 30, maxPerFile: 50 },
};

/**
 * The update check's defaults (ADR-0074): on by default — the check
 * sends no user content, and an off-by-default updater never reaches
 * the users who never found the toggle.
 */
export const DEFAULT_UPDATES_CONFIG: UpdatesConfig = {
  checkOnStartup: true,
  skippedVersion: null,
};

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  uiScale: 'default',
  accent: THEME_ACCENT,
  theme: ANTHRAZIT_THEME,
};

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: false,
  httpEnabled: false,
  httpPort: 4319,
  yolo: false,
};

export function defaultToolsConfig(): ToolsConfig {
  return {
    vault: { write: 'confirm' },
    tasks: { enabled: true },
    templates: { enabled: true, write: 'auto' },
    webFetch: { enabled: false, approval: 'ask' },
    webSearch: { enabled: false, provider: 'duckduckgo', apiKey: '', baseUrl: '', approval: 'ask' },
    servers: [],
    maxRounds: TOOL_ROUNDS_DEFAULT,
  };
}

export function classicEntryTemplate(): EntryTemplate {
  return {
    id: BUILTIN_ENTRY_TEMPLATE_IDS.classic,
    name: 'Classic',
    pattern: CLASSIC_ENTRY_PATTERN,
    builtin: 'classic',
  };
}

export function ruledEntryTemplate(): EntryTemplate {
  return {
    id: BUILTIN_ENTRY_TEMPLATE_IDS.ruled,
    name: 'Ruled',
    pattern: RULED_ENTRY_PATTERN,
    builtin: 'ruled',
  };
}

export function searchSummaryTemplate(): ActionTemplate {
  return {
    id: BUILTIN_TEMPLATE_IDS['search-summary'],
    name: 'Summarise search results',
    prompt: SEARCH_SUMMARY_PROMPT,
    resultKind: 'document',
    builtin: 'search-summary',
  };
}

export function autotagTemplate(): ActionTemplate {
  return {
    id: BUILTIN_TEMPLATE_IDS.autotag,
    name: 'Autotag',
    prompt: AUTOTAG_PROMPT,
    resultKind: 'localized',
    builtin: 'autotag',
  };
}

/**
 * The lossless "Structure note" template (roadmap "Lossless Markdown
 * template"): whole-document rewrite through the ADR-0011 confirmation.
 */
export function losslessFormatTemplate(): ActionTemplate {
  return {
    id: BUILTIN_TEMPLATE_IDS['lossless-format'],
    name: 'Structure note (lossless)',
    prompt: LOSSLESS_FORMAT_PROMPT,
    resultKind: 'document',
    builtin: 'lossless-format',
  };
}

/**
 * The manual trigger that ships for the lossless template — fresh
 * configs only (`normalizeTriggers`): an existing config's trigger list
 * is the user's, and an explicit empty array is respected. With it the
 * template is runnable out of the box: a row in the editor's `⋯` menu.
 */
export function losslessFormatTrigger(): ActionTrigger {
  return {
    id: 'trigger:lossless-format',
    templateId: BUILTIN_TEMPLATE_IDS['lossless-format'],
    event: 'manual',
    confirm: true,
    enabled: true,
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1,
  llm: {
    enabled: false,
    provider: 'lmstudio',
    baseUrl: LM_STUDIO_DEFAULT_BASE_URL,
    apiKey: null,
    model: null,
  },
  spellcheck: {
    enabled: true,
    language: 'de',
    autoDetect: true,
    dictionaries: [],
    personalWords: [],
    languageWords: {},
  },
  editor: {
    fontScale: 1,
    fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
  },
  appearance: { ...DEFAULT_APPEARANCE },
  mcp: { ...DEFAULT_MCP_CONFIG },
  tools: defaultToolsConfig(),
  entry: {
    templates: [classicEntryTemplate(), ruledEntryTemplate()],
    activeId: BUILTIN_ENTRY_TEMPLATE_IDS.classic,
  },
  daily: { ...DEFAULT_DAILY_CONFIG },
  templates: { ...DEFAULT_TEMPLATES_CONFIG },
  vault: { ...DEFAULT_VAULT_CONFIG },
  updates: { ...DEFAULT_UPDATES_CONFIG },
  widgets: { disabled: [] },
  plugins: { disabled: [] },
  keybindings: { overrides: {}, capture: DEFAULT_CAPTURE_CHORD },
  actions: {
    templates: [searchSummaryTemplate(), autotagTemplate(), losslessFormatTemplate()],
    triggers: [losslessFormatTrigger()],
  },
};
