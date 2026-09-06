import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Icon } from '../icons/icon';
import { SettingsService } from '../services/settings.service';
import { SettingsAbout } from './about/settings-about';
import { SettingsActions } from './actions/settings-actions';
import { SettingsAppearance } from './appearance/settings-appearance';
import { SettingsAssistant } from './assistant/settings-assistant';
import { SettingsLlm } from './llm/settings-llm';
import { SettingsSpellcheck } from './spellcheck/settings-spellcheck';

type CategoryId = 'llm' | 'assistant' | 'spellcheck' | 'appearance' | 'actions' | 'about';

/**
 * The Settings screen: master-detail per CLAUDE.md's "UI/UX Design" -- a
 * category list on the left, the detail pane on the right. Shown as a
 * full-surface overlay (`App` renders it when
 * `SettingsService.screenOpen`). `categories` is a list, not a hard-coded
 * set, so more slot in later.
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
  imports: [
    Icon,
    SettingsLlm,
    SettingsAssistant,
    SettingsSpellcheck,
    SettingsAppearance,
    SettingsActions,
    SettingsAbout,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  host: { '(document:keydown.escape)': 'requestClose()' },
})
export class Settings {
  protected readonly settings = inject(SettingsService);

  protected readonly categories: ReadonlyArray<{ id: CategoryId; label: string; hint: string }> = [
    { id: 'llm', label: 'LLM', hint: 'Local model connection' },
    { id: 'assistant', label: 'Assistant', hint: 'Note summary panel' },
    { id: 'spellcheck', label: 'Spelling', hint: 'Dictionaries & language' },
    { id: 'appearance', label: 'Appearance', hint: 'Editor font' },
    { id: 'actions', label: 'Actions', hint: 'Prompt templates & triggers' },
    { id: 'about', label: 'About', hint: 'Version & licenses' },
  ];

  protected readonly selected = signal<CategoryId>('llm');

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
