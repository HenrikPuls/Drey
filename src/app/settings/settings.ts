import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { Icon } from '../icons/icon';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { SettingsService } from '../services/settings.service';
import { SettingsCategoryRegistry } from './settings-registry.service';

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
  imports: [Icon, NgComponentOutlet, OverlayGuardDirective],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  host: { '(document:keydown.escape)': 'requestClose()' },
})
export class Settings {
  protected readonly settings = inject(SettingsService);
  private readonly registry = inject(SettingsCategoryRegistry);

  /** Core categories + plugin-contributed pages, from the registry. */
  protected readonly categories = this.registry.categories;

  /** A caller-named category (Help -> About) wins; falls back to the first. */
  private readonly presetCategory = this.settings.openCategory();

  protected readonly selected = signal<string>(
    this.presetCategory !== null &&
      this.categories().some((category) => category.id === this.presetCategory)
      ? this.presetCategory
      : (this.categories()[0]?.id ?? ''),
  );

  protected readonly selectedComponent = computed(
    () =>
      (this.registry.categoryFor(this.selected()) ?? this.categories()[0]).component,
  );

  /** `{ contrib }` for a plugin page, `undefined` for a core one. */
  protected readonly selectedInputs = computed(() => this.registry.inputsFor(this.selected()));

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
