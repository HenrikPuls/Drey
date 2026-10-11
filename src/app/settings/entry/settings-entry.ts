import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { composeEntry, EntryDraft } from '../../../../shared/entry-compose';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/** A fixed draft the pane's live preview is rendered from. */
const SAMPLE_DRAFT: EntryDraft = {
  topic: 'Rollout-Sync',
  text: 'Kurzes Sync mit Team zu Rollout-Plan, Risiken bei DB-Migration besprochen.',
  tags: ['daily', 'arbeit'],
};

const SAMPLE_AT = new Date(2026, 8, 26, 8, 15);

/**
 * "Add entry" settings category: the drawer appends a chosen template.
 * Two built-ins ("Classic" reproduces the old fixed shape, "Ruled" adds a
 * rule + tag line); the user picks the active one and can add/edit their
 * own. Mirrors the Actions template library. Pure view; `SettingsService`
 * owns every mutation, persisted on Save.
 */
@Component({
  selector: 'app-settings-entry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-entry.html',
  styleUrls: ['./settings-entry.css'],
})
export class SettingsEntry {
  protected readonly settings = inject(SettingsService);
  protected readonly config = this.settings.draft;

  protected readonly templates = computed(() => this.config()?.entry.templates ?? []);
  protected readonly activeId = computed(() => this.config()?.entry.activeId ?? '');

  /** Which template's pattern is expanded for editing. */
  protected readonly openTemplate = signal<string | null>(null);

  /** `Add entry` block a `pattern` produces for the sample draft. */
  protected preview(pattern: string): string {
    return composeEntry(SAMPLE_DRAFT, pattern, SAMPLE_AT);
  }

  protected toggleTemplate(id: string): void {
    this.openTemplate.update((current) => (current === id ? null : id));
  }

  protected addTemplate(): void {
    this.openTemplate.set(this.settings.addEntryTemplate());
  }
}
