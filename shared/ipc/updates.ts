/**
 * IPC contract, update-system part (milestone 82, ADR-0074): the update
 * status, the manual check, download, install and the releases-page
 * fallback (`shared/ipc-api.ts` is the barrel).
 *
 * The whole flow runs in the main process — the renderer never touches
 * the network (CSP forbids it anyway); it triggers and displays.
 */

/** Where the update flow stands; `UpdateStatus.phase`. */
export type UpdatePhase =
  /** This build cannot self-update: a dev run, non-Windows, or the portable exe. */
  | 'unsupported'
  /** Before anything happened this session. */
  | 'idle'
  /** A check is in flight. */
  | 'checking'
  /** The last check found no newer release. */
  | 'up-to-date'
  /** A newer release was found, not yet downloading. */
  | 'available'
  /** The update is downloading; see `progressPercent`. */
  | 'downloading'
  /** Downloaded and ready — `installUpdate()` closes through the exit prompt. */
  | 'downloaded'
  /** The last operation failed; see `error`. */
  | 'error';

/** A snapshot of the update flow, pushed after every phase change. */
export interface UpdateStatus {
  phase: UpdatePhase;
  /** The running version (`app.getVersion()`). */
  currentVersion: string;
  /** The version the flow is about; `null` until one was found. */
  availableVersion: string | null;
  /** 0–100 while `downloading`, else `null`. */
  progressPercent: number | null;
  /** English, user-readable reason while `phase === 'error'`. */
  error: string | null;
}

/** The update system's slice of the bridge. */
export interface UpdatesIpc {
  /** The current status snapshot (no side effects). */
  getUpdateStatus(): Promise<UpdateStatus>;

  /**
   * A check the user asked for (Help menu, Settings → Updates). Main
   * shows the native result dialogs — including the ask before a
   * download — and resolves with the status after the user answered.
   */
  checkForUpdates(): Promise<UpdateStatus>;

  /**
   * Downloads the found update. Progress lands in the pushed status.
   * When it completes, main asks (native dialog) whether to install
   * now.
   */
  downloadUpdate(): Promise<UpdateStatus>;

  /**
   * Installs a downloaded update: closes the window through the
   * ordinary exit path — the save-before-exit prompt runs, unsaved tabs
   * are decided by the user — and runs the installer once the app has
   * quit. The installer relaunches Drey afterwards.
   */
  installUpdate(): Promise<void>;

  /**
   * Opens the GitHub releases page in the system browser — the
   * manual-download fallback for the portable build and for installs
   * that cannot self-update.
   */
  openReleasesPage(): Promise<void>;

  /** Pushed after every phase change. Returns an unsubscribe. */
  onUpdateStatusChanged(listener: (status: UpdateStatus) => void): () => void;
}
