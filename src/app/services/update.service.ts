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

  /**
   * A short-lived green line for the status bar (req-45): the positive
   * "no update" answer of a manual check, shown inline instead of a
   * dialog. `null` when there is nothing to show; auto-clears after a
   * few seconds.
   */
  readonly notice = signal<string | null>(null);

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const api = typeof window !== 'undefined' ? window.dreyApi : undefined;
    if (api === undefined) {
      return;
    }
    api.onUpdateStatusChanged((status) => this.status.set(status));
    void api.getUpdateStatus().then((status) => this.status.set(status));
  }

  /**
   * Help menu / Settings → Updates "Check for updates". The asks and
   * failures surface as native dialogs from main; the positive result
   * becomes the status-bar notice (req-45).
   */
  checkNow(): void {
    void window.dreyApi?.checkForUpdates().then((status) => {
      if (status.phase === 'up-to-date') {
        this.showNotice(`The latest version (Drey ${status.currentVersion}) is already installed.`);
      }
    });
  }

  private showNotice(text: string): void {
    this.notice.set(text);
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.set(null), 6_000);
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
