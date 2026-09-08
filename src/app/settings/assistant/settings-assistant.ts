import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Assistant" settings category. One switch today: the default state of the
 * assistant panel's "Automatic summary" toggle.
 *
 * It is a *default*, not the switch itself -- the panel's own toggle
 * overrides it per note and never writes back here (see
 * `AssistantService`), so a note-level decision cannot silently become the
 * global rule.
 *
 * Pure view; the change goes into the draft and reaches disk on Save.
 */
@Component({
  selector: 'app-settings-assistant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-assistant.html',
  styleUrls: ['../settings-forms.css', './settings-assistant.css'],
})
export class SettingsAssistant {
  protected readonly settings = inject(SettingsService);

  protected readonly assistant = computed(() => this.settings.draft()?.assistant ?? null);
  protected readonly llmEnabled = computed<boolean>(
    () => this.settings.draft()?.llm.enabled ?? false,
  );

  protected onAutoSummaryChange(on: boolean): void {
    this.settings.patchAssistant({ autoSummaryDefault: on });
  }
}
