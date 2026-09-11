import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import type { PluginSettingsPageContrib, Unsubscribe } from '../../../shared/plugin-api/renderer';
import { PluginSettingsHost } from '../plugin-host';
import { SettingsAbout } from './about/settings-about';
import { SettingsAppearance } from './appearance/settings-appearance';
import { SettingsDaily } from './daily/settings-daily';
import { SettingsDockWidgets } from './dock-widgets/settings-dock-widgets';
import { SettingsEntry } from './entry/settings-entry';
import { SettingsLlm } from './llm/settings-llm';
import { SettingsMcp } from './mcp/settings-mcp';
import { SettingsSpellcheck } from './spellcheck/settings-spellcheck';
import { SettingsCategory } from './settings-category';

/**
 * The Settings screen's category registry — the data-driven list from
 * ADR-0016/ADR-0010, now runtime-extensible (ADR-0044): core categories
 * here, plugin pages appended through `api.ui.registerSettingsPage`.
 *
 * A plugin page renders through `PluginSettingsHost` and saves immediately
 * (its own `api.settings`) — the core categories keep the draft / Save /
 * Discard flow.
 */
@Injectable({ providedIn: 'root' })
export class SettingsCategoryRegistry {
  private readonly pluginPages = signal<readonly SettingsCategory[]>([]);
  private readonly pageContribs = new Map<string, PluginSettingsPageContrib>();

  readonly categories: Signal<readonly SettingsCategory[]> = computed(() => [
    ...CORE_CATEGORIES,
    ...this.pluginPages(),
  ]);

  categoryFor(id: string): SettingsCategory | undefined {
    return this.categories().find((category) => category.id === id);
  }

  /** The plugin contribution behind a registered page id (for `PluginSettingsHost`). */
  contribFor(id: string): PluginSettingsPageContrib | undefined {
    return this.pageContribs.get(id);
  }

  /**
   * `NgComponentOutlet` inputs for the selected category: `{ contrib }` for
   * a plugin page, `undefined` otherwise (core pages take no inputs). Keeps
   * the Settings screen itself ignorant of the plugin host.
   */
  inputsFor(id: string): Record<string, unknown> | undefined {
    const contrib = this.pageContribs.get(id);
    return contrib === undefined ? undefined : { contrib };
  }

  registerPluginPage(page: PluginSettingsPageContrib): Unsubscribe {
    const existing = this.contribFor(page.id);
    if (existing !== undefined || CORE_CATEGORIES.some((c) => c.id === page.id)) {
      throw new Error(`settings page id "${page.id}" is already registered`);
    }
    this.pageContribs.set(page.id, page);
    this.pluginPages.update((list) => [
      ...list,
      // Inserted before "About" (the last core category) so plugin pages
      // read as feature categories, not as app metadata.
      {
        id: page.id,
        label: page.label,
        hint: page.hint,
        component: PluginSettingsHost,
      },
    ]);
    return () => {
      this.pageContribs.delete(page.id);
      this.pluginPages.update((list) => list.filter((c) => c.id !== page.id));
    };
  }
}

const CORE_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'llm', label: 'LLM', hint: 'Local model connection', component: SettingsLlm },
  { id: 'entry', label: 'Add entry', hint: 'Append template', component: SettingsEntry },
  { id: 'daily', label: 'Daily notes', hint: 'Open on startup', component: SettingsDaily },
  {
    id: 'spellcheck',
    label: 'Spelling',
    hint: 'Dictionaries & language',
    component: SettingsSpellcheck,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    hint: 'Type size, colour & font',
    component: SettingsAppearance,
  },
  {
    id: 'widgets',
    label: 'Panels & plugins',
    hint: 'Toggle panels & plugins',
    component: SettingsDockWidgets,
  },
  { id: 'mcp', label: 'MCP', hint: 'Vault server & tools', component: SettingsMcp },
  { id: 'about', label: 'About', hint: 'Version & licenses', component: SettingsAbout },
];
