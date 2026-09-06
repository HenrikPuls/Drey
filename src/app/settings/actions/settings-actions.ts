import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActionEvent, ActionResultKind } from '../../../../shared/app-config';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Actions" settings category: the trigger -> template mappings and the
 * template library (`shared/app-config.ts`). The two built-in templates
 * ("Autotagging", "Update summary") can be edited but not deleted --
 * `normalizeAppConfig` re-injects them. Pure view; `SettingsService` owns
 * every mutation and persists it.
 */
@Component({
  selector: 'app-settings-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-actions.html',
  styleUrls: ['../settings-forms.css', './settings-actions.css'],
})
export class SettingsActions {
  protected readonly settings = inject(SettingsService);
  /** The draft -- edits stay local until the Settings screen is saved. */
  protected readonly config = this.settings.draft;

  protected readonly events: ReadonlyArray<{ id: ActionEvent; label: string }> = [
    { id: 'manual', label: 'Manual button' },
    { id: 'on-save', label: 'On save' },
  ];

  protected readonly resultKinds: ReadonlyArray<{ id: ActionResultKind; label: string }> = [
    { id: 'localized', label: 'Localized — inline diff' },
    { id: 'document', label: 'Whole document — side-by-side' },
  ];

  protected readonly templates = computed(() => this.config()?.actions.templates ?? []);
  protected readonly triggers = computed(() => this.config()?.actions.triggers ?? []);

  /** New-trigger form state; the template select defaults to the first template. */
  protected readonly newTriggerTemplate = signal<string>('');
  protected readonly newTriggerEvent = signal<ActionEvent>('manual');

  /** Which template's prompt is expanded for editing. */
  protected readonly openTemplate = signal<string | null>(null);

  protected templateName(id: string): string {
    return this.templates().find((t) => t.id === id)?.name ?? '(deleted template)';
  }

  protected addTrigger(): void {
    const templateId = this.newTriggerTemplate() || this.templates()[0]?.id;
    if (templateId) {
      this.settings.addTrigger(templateId, this.newTriggerEvent());
    }
  }

  protected toggleTemplate(id: string): void {
    this.openTemplate.update((current) => (current === id ? null : id));
  }

  protected addTemplate(): void {
    this.openTemplate.set(this.settings.addTemplate());
  }
}
