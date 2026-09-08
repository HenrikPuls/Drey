import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Daily notes" settings category. One switch today: whether the app opens
 * today's daily note on startup.
 *
 * It opens as an unsaved draft tab -- nothing is written until the user
 * types and saves -- exactly like clicking today in the calendar.
 *
 * Pure view; the change goes into the draft and reaches disk on Save.
 */
@Component({
  selector: 'app-settings-daily',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-daily.html',
  styleUrls: ['../settings-forms.css'],
})
export class SettingsDaily {
  protected readonly settings = inject(SettingsService);

  protected readonly daily = computed(() => this.settings.draft()?.daily ?? null);

  protected onOpenOnStartupChange(on: boolean): void {
    this.settings.patchDaily({ openOnStartup: on });
  }
}
