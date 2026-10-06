/**
 * The factory built-ins and `DEFAULT_APP_CONFIG` -- the value every missing
 * key in a stored config falls back to. Split out of `schema.ts` (shapes)
 * and `normalize.ts` (validation); re-exported from `shared/app-config.ts`.
 */
import { DEFAULT_DAILY_DIR } from '../daily';
import {
  ActionTemplate,
  AppConfig,
  AppearanceConfig,
  BUILTIN_ENTRY_TEMPLATE_IDS,
  BUILTIN_TEMPLATE_IDS,
  CLASSIC_ENTRY_PATTERN,
  DEFAULT_EDITOR_FONT_FAMILY,
  ANTHRAZIT_THEME,
  DailyConfig,
  EntryTemplate,
  LM_STUDIO_DEFAULT_BASE_URL,
  McpConfig,
  RULED_ENTRY_PATTERN,
  SEARCH_SUMMARY_PROMPT,
  AUTOTAG_PROMPT,
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

export const DEFAULT_TEMPLATES_CONFIG: TemplatesConfig = { dir: 'templates' };

export const DEFAULT_VAULT_CONFIG: VaultConfig = { watch: false };

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
  entry: {
    templates: [classicEntryTemplate(), ruledEntryTemplate()],
    activeId: BUILTIN_ENTRY_TEMPLATE_IDS.classic,
  },
  daily: { ...DEFAULT_DAILY_CONFIG },
  templates: { ...DEFAULT_TEMPLATES_CONFIG },
  vault: { ...DEFAULT_VAULT_CONFIG },
  widgets: { disabled: [] },
  plugins: { disabled: [] },
  actions: {
    templates: [searchSummaryTemplate(), autotagTemplate()],
    triggers: [],
  },
};
