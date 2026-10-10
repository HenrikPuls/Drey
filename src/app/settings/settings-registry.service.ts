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
import { SettingsTools } from './tools/settings-tools';
import { SettingsSpellcheck } from './spellcheck/settings-spellcheck';
import { SettingsVault } from './vault/settings-vault';
import { SettingsCategory } from './settings-category';

/**
 * The Settings screen's category registry — the data-driven list from
 * ADR-0016/ADR-0010, now runtime-extensible (ADR-0044): core categories
 * here, plugin pages appended through `api.ui.registerSettingsPage`.
 *
 * Order (req-33): the core categories read alphabetically, plugin pages
 * follow sorted by their label, "About" stays last — so the list stays
 * predictable no matter what registers when.
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
    ...[...this.pluginPages()].sort((a, b) => a.label.localeCompare(b.label)),
    ABOUT_CATEGORY,
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
      // Rendered after the core categories (sorted by label there) and
      // before "About", so plugin pages read as feature categories, not as
      // app metadata.
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

/** Core categories, kept in alphabetical label order (req-33). */
const CORE_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    hint: 'Type size, colour & font',
    component: SettingsAppearance,
  },
  {
    id: 'tools',
    label: 'Assistant tools',
    hint: 'Vault, web & MCP servers',
    component: SettingsTools,
  },
  { id: 'daily', label: 'Daily notes', hint: 'Startup & storage folder', component: SettingsDaily },
  { id: 'entry', label: 'Entry format', hint: 'The / menu Entry block', component: SettingsEntry },
  { id: 'llm', label: 'LLM', hint: 'Local model connection', component: SettingsLlm },
  { id: 'mcp', label: 'MCP', hint: 'Vault server for other apps', component: SettingsMcp },
  {
    id: 'widgets',
    label: 'Panels & plugins',
    hint: 'Toggle panels & plugins',
    component: SettingsDockWidgets,
  },
  {
    id: 'spellcheck',
    label: 'Spelling',
    hint: 'Dictionaries & language',
    component: SettingsSpellcheck,
  },
  { id: 'vault', label: 'Vault', hint: 'External change detection', component: SettingsVault },
];

/** Always last — app metadata, not a feature category. */
const ABOUT_CATEGORY: SettingsCategory = {
  id: 'about',
  label: 'About',
  hint: 'Version & licenses',
  component: SettingsAbout,
};
