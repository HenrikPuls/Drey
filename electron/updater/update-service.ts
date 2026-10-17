import { app, dialog, shell, type BrowserWindow } from 'electron';
import { NsisUpdater } from 'electron-updater';
import { RELEASES_PAGE_URL, isNewerVersion, isVersionSkipped } from '../../shared/updates';
import type { UpdatePhase, UpdateStatus } from '../../shared/ipc-api';
import type { AppConfigStore } from '../app-config';
import { logLine } from '../logger';

/**
 * The in-app update system's main-process half (milestone 82, ADR-0074):
 * a state machine over electron-updater's GitHub-Releases flow, with
 * every ask as a native dialog and every quit through the ordinary
 * save-before-exit path.
 *
 * electron-updater only transports: `autoDownload` and
 * `autoInstallOnAppQuit` are off — Drey decides. The ask chain is
 * "update available → download?" then "downloaded → install now?";
 * "Skip this version" persists `updates.skippedVersion`.
 *
 * Inert unless this is a packaged Windows NSIS install: a dev run, a
 * non-Windows platform and the portable exe report `unsupported` (the
 * portable build has no installer to run — it gets the releases-page
 * fallback instead).
 */

/**
 * The slice of `NsisUpdater` the service drives — a structural seam so
 * specs can hand in a fake without electron-updater's machinery.
 */
export interface UpdaterHandle {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } | null;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceDeps {
  readonly getMainWindow: () => BrowserWindow | null;
  readonly appConfig: AppConfigStore;
  /**
   * Constructs the updater; the default returns `null` unless this is a
   * packaged, non-portable Windows build. Specs inject a fake.
   */
  readonly createUpdater?: () => UpdaterHandle | null;
}

/** How the ask dialogs' answers map to the flow. */
type DownloadChoice = 'download' | 'skip' | 'later';

function defaultCreateUpdater(): UpdaterHandle | null {
  const portable = process.env['PORTABLE_EXECUTABLE_DIR'] !== undefined;
  if (!app.isPackaged || process.platform !== 'win32' || portable) {
    return null;
  }
  return new NsisUpdater();
}

export class UpdateService {
  private readonly updater: UpdaterHandle | null;
  private phase: UpdatePhase = 'idle';
  private availableVersion: string | null = null;
  private progressPercent: number | null = null;
  private errorMessage: string | null = null;
  /** Set when the window really closed and the installer should run at quit. */
  private installOnQuit = false;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();

  constructor(private readonly deps: UpdateServiceDeps) {
    this.updater = (deps.createUpdater ?? defaultCreateUpdater)();
    if (this.updater === null) {
      this.phase = 'unsupported';
      return;
    }
    // Nothing happens unasked: no auto download, no install on quit, and
    // only releases GitHub marks as "Latest" (the stable channel).
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.logger = {
      info: (m) => logLine(`[update] ${m}`),
      warn: (m) => logLine(`[update/warn] ${m}`),
      error: (m) => logLine(`[update/error] ${m}`),
    };
    this.updater.on('update-available', (info) => {
      if (isNewerVersion(app.getVersion(), info.version)) {
        this.availableVersion = info.version;
        this.setPhase('available');
      }
    });
    this.updater.on('update-not-available', () => {
      this.availableVersion = null;
      this.setPhase('up-to-date');
    });
    this.updater.on('download-progress', (progress) => {
      this.progressPercent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      this.setPhase('downloading');
    });
    this.updater.on('update-downloaded', (info) => {
      this.availableVersion = info.version;
      this.progressPercent = null;
      this.setPhase('downloaded');
      void this.askInstall();
    });
    this.updater.on('error', (err) => {
      logLine(`[update] ${err.message}`);
    });
  }

  /** The current status snapshot. */
  status(): UpdateStatus {
    return {
      phase: this.phase,
      currentVersion: app.getVersion(),
      availableVersion: this.availableVersion,
      progressPercent: this.progressPercent,
      error: this.errorMessage,
    };
  }

  /** Observes every status change; returns an unsubscribe. */
  onStatus(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The quiet check on app start (ADR-0074): runs when the config allows
   * it, asks about a new release unless that exact version was skipped,
   * and never complains — a failed startup check stays in the log.
   */
  async runStartupCheck(): Promise<void> {
    if (!this.updater || !this.deps.appConfig.get().updates.checkOnStartup) {
      return;
    }
    const skipped = this.deps.appConfig.get().updates.skippedVersion;
    await this.check(
      /* reportErrors */ false,
      (version) => !isVersionSkipped(version, skipped),
    );
  }

  /**
   * A check the user asked for (Help menu, Settings → Updates). Failures
   * and the asks stay native dialogs; the positive "up to date" result
   * is status only — the renderer shows it as inline green text
   * (req-45), so it never blocks with a window.
   */
  async checkManually(): Promise<UpdateStatus> {
    await this.check(/* reportErrors */ true);
    return this.status();
  }

  /**
   * Downloads the found update. The completion ask ("install now?") comes
   * from the `update-downloaded` event. No-op without a found version or
   * mid-flow.
   */
  async download(): Promise<UpdateStatus> {
    if (this.updater === null || this.availableVersion === null || this.isBusy()) {
      return this.status();
    }
    this.progressPercent = 0;
    this.setPhase('downloading');
    try {
      await this.updater.downloadUpdate();
    } catch (err) {
      this.fail(err);
    }
    return this.status();
  }

  /**
   * Installs a downloaded update: the ordinary close path first (the
   * save-before-exit prompt decides over dirty tabs — a cancel leaves
   * everything as it was), and the installer runs once the app has quit
   * (`finishQuit`, wired to `will-quit` in `main.ts`).
   */
  install(): void {
    if (this.updater === null || this.phase !== 'downloaded') {
      return;
    }
    const window = this.deps.getMainWindow();
    if (window !== null && !window.isDestroyed()) {
      // Only arm the install once the window really closed — a cancelled
      // exit prompt must leave the plain quit semantics untouched.
      window.once('closed', () => {
        this.installOnQuit = true;
      });
      window.close();
    } else {
      this.installOnQuit = true;
      app.quit();
    }
  }

  /**
   * At `will-quit` (all windows gone, will-quit hooks run): runs the
   * downloaded installer, which installs and relaunches Drey. One-shot —
   * the quit electron-updater itself triggers must not re-enter it.
   */
  finishQuit(): void {
    if (!this.installOnQuit || this.updater === null) {
      return;
    }
    this.installOnQuit = false;
    try {
      // Not silent: Drey's NSIS installer is the assisted one
      // (oneClick: false); the relaunch after install is the installer's
      // own default (electron-updater's autoRunAppAfterInstall).
      this.updater.quitAndInstall(false, true);
    } catch (err) {
      logLine(`[update] install at quit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Opens the releases page in the system browser — the manual fallback. */
  openReleasesPage(): void {
    void shell.openExternal(RELEASES_PAGE_URL);
  }

  private async check(reportErrors: boolean, shouldAsk?: (version: string) => boolean): Promise<void> {
    if (this.updater === null) {
      if (reportErrors) {
        await this.showUnsupported();
      }
      return;
    }
    if (this.isBusy()) {
      return;
    }
    this.errorMessage = null;
    this.setPhase('checking');
    try {
      const result = await this.updater.checkForUpdates();
      if (result === null) {
        // Updater inert (its own guards): treat as nothing found.
        this.availableVersion = null;
        this.setPhase('up-to-date');
        return;
      }
      const version = result.updateInfo.version;
      if (!isNewerVersion(app.getVersion(), version)) {
        // The positive result is status only — no dialog (req-45): the
        // renderer shows it as green inline text (status bar / Updates
        // page), so a "nothing to do" answer never blocks the user.
        this.availableVersion = null;
        this.setPhase('up-to-date');
        return;
      }
      this.availableVersion = version;
      this.setPhase('available');
      if (shouldAsk !== undefined && !shouldAsk(version)) {
        return; // the startup check for a skipped version: status only
      }
      const choice = await this.askDownload(version);
      if (choice === 'download') {
        await this.download();
      } else if (choice === 'skip') {
        const updates = this.deps.appConfig.get().updates;
        this.deps.appConfig.patch({
          updates: { ...updates, skippedVersion: version },
        });
      }
    } catch (err) {
      this.fail(err);
      if (reportErrors) {
        await this.showError(
          'The update check failed',
          `${err instanceof Error ? err.message : String(err)}\n\nCheck your internet connection ` +
            '(a corporate proxy can block github.com) — or open the releases page in your browser.',
        );
      }
    }
  }

  private async askDownload(version: string): Promise<DownloadChoice> {
    const { response } = await this.messageBox({
      type: 'info',
      title: 'Drey',
      message: 'A Drey update is available',
      detail:
        `Drey ${version} is available — this installation runs ${app.getVersion()}.\n\n` +
        'The download comes from the Drey releases on GitHub.',
      buttons: ['Download update', 'Skip this version', 'Remind me later'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return response === 0 ? 'download' : response === 1 ? 'skip' : 'later';
  }

  private async askInstall(): Promise<void> {
    const version = this.availableVersion;
    if (version === null) {
      return;
    }
    const { response } = await this.messageBox({
      type: 'info',
      title: 'Drey',
      message: 'Update downloaded',
      detail:
        `Drey ${version} is downloaded and ready to install.\n\n` +
        'Installing closes Drey — the usual exit prompt asks about unsaved tabs first — ' +
        'and the installer relaunches it when done.',
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      this.install();
    }
  }

  private async showUnsupported(): Promise<void> {
    await this.showInfo(
      'This installation cannot update itself',
      'Updates install over the Windows setup (NSIS) build. This is a development run, ' +
        'a different platform, or the portable build — download the new version from the ' +
        'releases page instead.',
    );
  }

  private showInfo(message: string, detail: string): Promise<void> {
    return this.messageBox({
      type: 'info',
      title: 'Drey',
      message,
      detail,
      buttons: ['OK'],
      noLink: true,
    }).then(() => undefined);
  }

  private showError(message: string, detail: string): Promise<void> {
    return this.messageBox({
      type: 'error',
      title: 'Drey',
      message,
      detail,
      buttons: ['OK'],
      noLink: true,
    }).then(() => undefined);
  }

  /** `dialog.showMessageBox`, attached to the main window when there is one. */
  private messageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const owner = this.dialogOwner();
    return owner !== null ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  }

  private dialogOwner(): BrowserWindow | null {
    const window = this.deps.getMainWindow();
    return window !== null && !window.isDestroyed() ? window : null;
  }

  /** A flow is already running (checking or downloading); a new one must not start. */
  private isBusy(): boolean {
    return this.phase === 'checking' || this.phase === 'downloading';
  }

  private fail(err: unknown): void {
    this.errorMessage = err instanceof Error ? err.message : String(err);
    this.progressPercent = null;
    this.setPhase('error');
  }

  private setPhase(phase: UpdatePhase): void {
    this.phase = phase;
    const status = this.status();
    for (const listener of [...this.listeners]) {
      try {
        listener(status);
      } catch {
        // A listener must never break the flow that notified it.
      }
    }
  }
}
