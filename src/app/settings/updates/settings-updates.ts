import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { UpdateStatus } from '../../../../shared/ipc-api';
import { UpdateService } from '../../services/update.service';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Updates" settings category (milestone 82, ADR-0074): the startup-check
 * switch (the draft, like every Settings field) and the live flow status
 * (the `UpdateService` mirror of the main-side state machine — read-only
 * view plus the trigger buttons, whose asks and results are native
 * dialogs from main).
 */
@Component({
  selector: 'app-settings-updates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-updates.html',
})
export class SettingsUpdates {
  protected readonly settings = inject(SettingsService);
  protected readonly update = inject(UpdateService);

  protected readonly updates = computed(() => this.settings.draft()?.updates ?? null);

  protected readonly statusLine = computed<string | null>(() => {
    const status: UpdateStatus | null = this.update.status();
    if (status === null) {
      return null;
    }
    switch (status.phase) {
      case 'unsupported':
        return 'This build cannot update itself — a development run, another platform, or the portable exe. Download new versions from the releases page.';
      case 'idle':
        return 'No update check has run in this session.';
      case 'checking':
        return 'Checking for updates…';
      case 'up-to-date':
        return `Drey ${status.currentVersion} is up to date.`;
      case 'available':
        return `Drey ${status.availableVersion} is available.`;
      case 'downloading':
        return `Downloading Drey ${status.availableVersion} — ${status.progressPercent ?? 0}%.`;
      case 'downloaded':
        return `Drey ${status.availableVersion} is downloaded and ready to install.`;
      case 'error':
        return 'The last update operation failed.';
    }
  });

  protected readonly busy = computed(
    () => this.update.status()?.phase === 'checking' || this.update.status()?.phase === 'downloading',
  );

  protected canDownload(): boolean {
    return this.update.status()?.phase === 'available';
  }

  protected canInstall(): boolean {
    return this.update.status()?.phase === 'downloaded';
  }

  protected onStartupChange(on: boolean): void {
    this.settings.patchUpdates({ checkOnStartup: on });
  }

  protected onClearSkip(): void {
    this.settings.patchUpdates({ skippedVersion: null });
  }
}
