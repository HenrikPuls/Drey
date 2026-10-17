import { Injectable, signal } from '@angular/core';
import type { UpdateStatus } from '../../../shared/ipc-api';

/**
 * The update system's renderer half (milestone 82, ADR-0074): mirrors
 * the main-side flow's status and forwards the user's triggers. The
 * whole flow — the check against the GitHub releases, the download, the
 * install that quits through the save-before-exit prompt — runs in the
 * main process, and so do the result dialogs; this service is a thin,
 * display-facing facade (the renderer stays off the network, CSP or not).
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  /** The last status main pushed (or answered); `null` before the first. */
  readonly status = signal<UpdateStatus | null>(null);

  constructor() {
    const api = typeof window !== 'undefined' ? window.dreyApi : undefined;
    if (api === undefined) {
      return;
    }
    api.onUpdateStatusChanged((status) => this.status.set(status));
    void api.getUpdateStatus().then((status) => this.status.set(status));
  }

  /** Help menu / Settings → Updates "Check for updates" — main shows the result. */
  checkNow(): void {
    void window.dreyApi?.checkForUpdates();
  }

  /** Downloads the found update; progress arrives through the status push. */
  download(): void {
    void window.dreyApi?.downloadUpdate();
  }

  /**
   * Installs a downloaded update: closes through the exit prompt, runs
   * the installer, relaunches. The invoking renderer goes down with the
   * window — fire-and-forget by design.
   */
  install(): void {
    void window.dreyApi?.installUpdate();
  }

  /** The manual-download fallback (portable build, blocked network, …). */
  openReleasesPage(): void {
    void window.dreyApi?.openReleasesPage();
  }
}
