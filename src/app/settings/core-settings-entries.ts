import type { SettingsScope, SettingsSearchEntry } from './settings-model';

/**
 * The searchable settings of the core pages (E13-22), by category id. The
 * Settings search matches label, description and key; a click opens the
 * page and scrolls to the element showing the label. A page not listed is
 * still found by its own label and hint.
 */
const e = (key: string, label: string, description?: string): SettingsSearchEntry => ({ key, label, description });

const RAW_ENTRIES: Readonly<Record<string, readonly SettingsSearchEntry[]>> = {
  appearance: [
    e('theme', 'Theme', 'Drey, Anthrazit or Cyberpunk'),
    e('fontSize', 'Base font size', 'Text size of the interface'),
    e('accent', 'Highlight colour', 'Accent colour of buttons, links and the selected row'),
    e('editorFont', 'Editor font', 'Font family of the editor'),
  ],
  daily: [
    e('daily.open', "Open today's daily note on startup"),
    e('daily.dir', 'Storage folder', 'Where daily notes are kept'),
  ],
  llm: [
    e('llm.enabled', 'Enable LLM features'),
    e('llm.provider', 'Provider', 'Local endpoint, OpenRouter, Anthropic, CLI'),
    e('llm.baseUrl', 'Base URL', 'Endpoint of the model server'),
    e('llm.apiKey', 'API key'),
    e('llm.model', 'Model', 'Model id'),
  ],
  mcp: [
    e('mcp.enabled', 'Enable the vault MCP server'),
    e('mcp.http', 'Open the localhost HTTP endpoint'),
    e('mcp.port', 'HTTP port'),
    e('mcp.yolo', 'YOLO mode', 'Apply writes without confirmation'),
    e('mcp.client', 'Client configuration'),
  ],
  vault: [
    e('vault.watch', 'Watch the vault for external changes', 'File watcher'),
    e('vault.links', 'When a note is renamed or moved', 'Update links'),
    e('vault.history', 'Keep a local history of notes'),
    e('vault.historyDays', 'Keep versions for (days)'),
  ],
  updates: [
    e('updates.check', 'Check for updates on start', 'Automatic check'),
    e('updates.status', 'Status'),
  ],
  entry: [e('entry.format', 'Entry format', 'The / menu Entry block')],
  shortcuts: [e('shortcuts', 'Keyboard shortcuts', 'Commands, chords and quick capture')],
  tools: [e('tools', 'Assistant tools', 'Vault, tasks, web search, web fetch, MCP servers')],
  widgets: [e('widgets', 'Panels & plugins', 'Toggle panels and plugins')],
  spellcheck: [e('spelling', 'Spelling', 'Dictionaries and language')],
};

/**
 * Who each core page's settings are stored for (decision D10: appearance
 * and the app's own behaviour per device, the vault's per vault, the model
 * and tool connections shared by every device).
 */
const PAGE_SCOPE: Readonly<Record<string, SettingsScope>> = {
  appearance: 'device',
  shortcuts: 'device',
  spellcheck: 'device',
  updates: 'device',
  widgets: 'device',
  daily: 'vault',
  entry: 'vault',
  vault: 'vault',
  llm: 'all-devices',
  mcp: 'all-devices',
  tools: 'all-devices',
};

export const CORE_ENTRIES: Readonly<Record<string, readonly SettingsSearchEntry[]>> = Object.fromEntries(
  Object.entries(RAW_ENTRIES).map(([page, entries]) => [
    page,
    entries.map((entry) => ({ ...entry, scope: entry.scope ?? PAGE_SCOPE[page] })),
  ]),
);
