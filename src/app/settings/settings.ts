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
 * Every change is applied as it is made (ADR-0010 later change): a pane
 * writes `SettingsService.draft`, which saves itself. This component tells
 * the service while a text field has the focus -- the save then waits for
 * the field to be left or Enter -- and flushes before the screen closes.
 * The footer carries the save status and one Close button; no Save, no
 * Discard, no "unsaved changes" prompt.
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NgComponentOutlet, OverlayGuardDirective],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  host: {
    '(document:keydown.escape)': 'requestClose()',
    '(window:blur)': 'flush()',
  },
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

  /** A text field took the focus: hold the automatic save until it is left. */
  protected onFocusIn(event: FocusEvent): void {
    if (isTextEntry(event.target)) {
      this.settings.editingText.set(true);
    }
  }

  protected onFocusOut(event: FocusEvent): void {
    if (isTextEntry(event.target)) {
      this.settings.editingText.set(false);
      this.flush();
    }
  }

  /** Enter in a one-line field commits it (a textarea keeps Enter for the line break). */
  protected onEnter(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      // After the field's own `change` handler, which Enter also triggers.
      setTimeout(() => this.flush());
    }
  }

  protected flush(): void {
    void this.settings.flush();
  }

  /**
   * Saves what is pending, then closes. A failed save keeps the screen
   * open with the error in the footer, whose button then closes without
   * saving (`closeWithoutSaving`).
   */
  protected async requestClose(): Promise<void> {
    if (await this.settings.flush()) {
      this.settings.closeScreen();
    }
  }

  protected closeWithoutSaving(): void {
    this.settings.closeScreen();
  }
}

/** A field whose value is typed -- not a checkbox, radio, colour or file input. */
function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  return (
    target instanceof HTMLInputElement &&
    ['text', 'number', 'password', 'url', 'search', 'email', ''].includes(target.type)
  );
}
