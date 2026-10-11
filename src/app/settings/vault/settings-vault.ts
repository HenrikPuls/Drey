import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { UPDATE_LINKS_MODES, UpdateLinksMode } from '../../../../shared/app-config';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Vault" settings category: how the app keeps up with external changes.
 * One switch today -- the opt-in chokidar watcher (ADR-0045, req-14).
 *
 * Pure view; the change goes into the draft and reaches disk (and with it
 * the main process's `syncVaultWatcher`) on Save.
 */
@Component({
  selector: 'app-settings-vault',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-vault.html',
})
export class SettingsVault {
  protected readonly settings = inject(SettingsService);

  protected readonly vault = computed(() => this.settings.draft()?.vault ?? null);

  protected onWatchChange(on: boolean): void {
    this.settings.patchVault({ watch: on });
  }

  protected onUpdateLinksChange(mode: string): void {
    if (UPDATE_LINKS_MODES.includes(mode as UpdateLinksMode)) {
      this.settings.patchVault({ updateLinksOnRename: mode as UpdateLinksMode });
    }
  }

  protected onHistoryEnabledChange(on: boolean): void {
    const history = this.vault()?.history;
    if (history) {
      this.settings.patchVault({ history: { ...history, enabled: on } });
    }
  }

  protected onHistoryDaysChange(raw: string): void {
    const history = this.vault()?.history;
    const days = Math.round(Number(raw));
    if (history && Number.isFinite(days) && days >= 1) {
      this.settings.patchVault({ history: { ...history, keepDays: Math.min(365, days) } });
    }
  }
}
