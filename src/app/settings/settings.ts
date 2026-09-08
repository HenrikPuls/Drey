import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { Icon } from '../icons/icon';
import { SettingsService } from '../services/settings.service';
import { SettingsAbout } from './about/settings-about';
import { SettingsActions } from './actions/settings-actions';
import { SettingsAppearance } from './appearance/settings-appearance';
import { SettingsAssistant } from './assistant/settings-assistant';
import { SettingsDaily } from './daily/settings-daily';
import { SettingsEntry } from './entry/settings-entry';
import { SettingsLlm } from './llm/settings-llm';
import { SettingsMcp } from './mcp/settings-mcp';
import { SettingsSpellcheck } from './spellcheck/settings-spellcheck';
import { SettingsTemplates } from './templates/settings-templates';
import { SettingsCategory } from './settings-category';

/**
 * The Settings screen: master-detail per CLAUDE.md's "UI/UX Design" -- a
 * category list on the left, the detail pane on the right. Shown as a
 * full-surface overlay (`App` renders it when
 * `SettingsService.screenOpen`). The category list is a data-driven
 * registry (`SettingsCategory[]`), rendered through `NgComponentOutlet`, so
 * a new category is one array entry -- no `@switch` to extend.
 *
 * Edits go into `SettingsService.draft` and reach disk only via **Save**.
 * Closing with unsaved changes -- the close button, the backdrop, or
 * Escape -- raises an inline "unsaved changes" bar (save / discard / keep
 * editing) instead of a native `confirm()`, matching the in-renderer
 * overlay pattern the file tree already uses (docs/05 §5.8).
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NgComponentOutlet],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  host: { '(document:keydown.escape)': 'requestClose()' },
})
export class Settings {
  protected readonly settings = inject(SettingsService);

  protected readonly categories: readonly SettingsCategory[] = [
    { id: 'llm', label: 'LLM', hint: 'Local model connection', component: SettingsLlm },
    {
      id: 'assistant',
      label: 'Assistant',
      hint: 'Note summary panel',
      component: SettingsAssistant,
    },
    { id: 'entry', label: 'Add entry', hint: 'Append template', component: SettingsEntry },
    { id: 'daily', label: 'Daily notes', hint: 'Open on startup', component: SettingsDaily },
    {
      id: 'templates',
      label: 'Templates',
      hint: 'Snippet library folder',
      component: SettingsTemplates,
    },
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
      id: 'actions',
      label: 'Actions',
      hint: 'Prompt templates & triggers',
      component: SettingsActions,
    },
    { id: 'mcp', label: 'MCP', hint: 'Vault server & tools', component: SettingsMcp },
    { id: 'about', label: 'About', hint: 'Version & licenses', component: SettingsAbout },
  ];

  protected readonly selected = signal<string>(this.categories[0].id);

  protected readonly selectedComponent = computed(
    () =>
      (this.categories.find((category) => category.id === this.selected()) ?? this.categories[0])
        .component,
  );

  /** True while the "you have unsaved changes" bar is showing. */
  protected readonly confirmingClose = signal(false);

  /** Close, or ask first when there are unsaved changes. */
  protected requestClose(): void {
    if (this.settings.isDirty()) {
      this.confirmingClose.set(true);
      return;
    }
    this.settings.closeScreen();
  }

  protected keepEditing(): void {
    this.confirmingClose.set(false);
  }

  protected discardAndClose(): void {
    this.confirmingClose.set(false);
    this.settings.closeScreen();
  }

  protected async saveAndClose(): Promise<void> {
    if (await this.settings.save()) {
      this.confirmingClose.set(false);
      this.settings.closeScreen();
    } else {
      // Save failed -- keep the dialog open so the error is visible and the
      // user's edits aren't silently thrown away.
      this.confirmingClose.set(false);
    }
  }

  /** The footer Save button: persists but stays open. */
  protected async save(): Promise<void> {
    await this.settings.save();
  }
}
