/**
 * IPC contract, application part: the window, the exit prompt, the Edit
 * menu, links to the outside, logging, the startup splash and the app
 * config (`shared/ipc-api.ts` is the barrel).
 */
import type { AppConfig } from '../app-config';

/**
 * Pushed to the renderer when the window is about to close with the exit
 * prompt undecided (bug-5). The renderer owns the dirty-document registry,
 * so the payload carries only the correlation id: no dirty docs -> it
 * replies `'discard'` (proceed) without showing anything; otherwise it
 * shows the exit dialog and replies with the chosen `ExitDecision`.
 */
export interface ExitConfirmRequest {
  id: number;
}

/** The renderer's answer to an `ExitConfirmRequest`. */
export type ExitDecision = 'save' | 'discard' | 'cancel';

/**
 * Standard editing commands the HTML Edit menu routes through the focused
 * `webContents` element (`electron/ipc/app-handlers.ts`). CodeMirror and native
 * `<input>` / `<textarea>` fields both honour these, so one path covers
 * every editable surface -- and it survives the menu click stealing DOM
 * focus, which a renderer-side dispatch would not.
 */
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

/** One renderer-sourced log entry written to the main process's log file. */
export interface LogEntry {
  level: 'error' | 'warn' | 'info';
  message: string;
  /** Optional structured payload (a stack, a state snapshot); JSON-stringified. */
  context?: unknown;
}

/**
 * One startup progress stage (milestone 62): `pct` is 0–100 on the
 * stage-weighted scale main and the renderer share (main: settings →
 * plugins → interface; renderer: workspace → session → ready).
 */
export interface StartupProgressReport {
  label: string;
  pct: number;
}

/**
 * Mirrors Node's `NodeJS.Platform` values. Spelled out explicitly instead
 * of importing the `NodeJS` global namespace: the renderer's tsconfig
 * deliberately excludes `@types/node` (see tsconfig.app.json, "types": [])
 * so browser code can't assume Node globals exist, and this file is
 * compiled in both contexts.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'
  | 'haiku';

/**
 * Basic runtime info from the main process. This is the milestone-1
 * smoke test for the IPC bridge -- later milestones add real channels
 * (vault listing, file read/write, classifier calls, ...) following the
 * same pattern.
 */
export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: Platform;
}

/** Window, exit, editing commands, logging, startup and config. */
export interface AppIpc {
  getAppInfo(): Promise<AppInfo>;

  /**
   * Custom-titlebar window controls. The renderer draws its own
   * minimize/maximize/close buttons because the window is frameless
   * (`titleBarStyle: 'hidden'`) -- see
   * docs/09_architecture_decisions/0019-*.md. No-ops if the window is gone.
   */
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  /** Toggles OS fullscreen (the `F11` command / View-menu row). */
  toggleFullScreen(): Promise<void>;
  isWindowFullScreen(): Promise<boolean>;

  /**
   * Fires when the window is about to close and the renderer must decide
   * (bug-5): save all dirty documents, exit without saving, or cancel the
   * close. Reply via `resolveExitConfirm`. Returns an unsubscribe.
   */
  onExitConfirmRequest(listener: (request: ExitConfirmRequest) => void): () => void;

  /** The renderer's answer to an `ExitConfirmRequest`. */
  resolveExitConfirm(id: number, decision: ExitDecision): Promise<void>;

  /**
   * Fires whenever the window is maximized or restored, so the titlebar's
   * maximize/restore glyph can follow along (main -> renderer push, same
   * shape as `onOpenDailyNote`). Returns an unsubscribe.
   */
  onWindowMaximizeChange(listener: (maximized: boolean) => void): () => void;

  /**
   * Fires when the window enters or leaves OS fullscreen, so the View
   * menu's "Full screen" check mark can follow along (main -> renderer
   * push, same shape as `onWindowMaximizeChange`). Returns an unsubscribe.
   */
  onWindowFullScreenChange(listener: (fullScreen: boolean) => void): () => void;

  /**
   * Runs a standard editing command against the focused editable element
   * (CodeMirror or a native field), via the window's `webContents`. Backs
   * the HTML Edit menu's Undo/Redo/Cut/Copy/Paste/Select all rows -- the
   * accelerators already work; this makes the menu clicks work too.
   */
  execEditCommand(command: EditCommand): Promise<void>;

  /**
   * Sets the whole renderer's zoom factor (`webContents.setZoomFactor`) --
   * the app-wide "Base font size" preset in Settings -> Appearance. `1` is
   * unscaled. Scales layout and pointer coordinates together, unlike a CSS
   * `zoom`, so drag gestures keep working. Resets on reload, so the renderer
   * re-applies it from config on startup.
   */
  setUiZoomFactor(factor: number): Promise<void>;

  /**
   * Opens an external URL in the OS default handler (`shell.openExternal`).
   * Only `http:`, `https:` and `mailto:` are honoured -- anything else is
   * ignored in the main process. Backs a `Ctrl`/`Cmd`-click on a link in
   * the editor.
   */
  openExternal(url: string): Promise<void>;

  /**
   * Opens the document a `file:` link in a note points at in its default
   * program (ADR-0066). Main honours only a path on this machine whose
   * extension is on the document allowlist (`shared/external-document.ts`);
   * rejects with a user message otherwise, or when the file is missing.
   */
  openLocalDocument(href: string): Promise<void>;

  /**
   * The absolute path of a file the user dropped or picked (Electron's
   * `webUtils.getPathForFile`); `''` for a `File` that has none (pasted
   * bytes). Renderer-only knowledge of where a dropped document lives --
   * backs the "link instead of copy" drop (ADR-0066).
   */
  pathForFile(file: File): string;

  /**
   * Appends a line to the main process's log file
   * (`<userData>/logs/drey.log`). Best-effort, fire-and-forget -- the
   * renderer mirrors `console.error` / `window.onerror` /
   * `unhandledrejection` here so a field problem in the packaged build
   * problem in the packaged build (no DevTools) leaves a trace.
   */
  logMessage(entry: LogEntry): Promise<void>;

  /**
   * Startup progress (milestone 62): fire-and-forget stage reports the
   * renderer feeds to main while the splash window is up — main forwards
   * them to the splash's bar + activity line. Silently ignored after the
   * handover.
   */
  reportStartupProgress(report: StartupProgressReport): void;
  /**
   * The workspace is ready: main shows the (until now hidden) main window
   * and closes the splash — the ADR-0062 handover. One-shot per boot.
   */
  reportStartupReady(): void;

  /** The full app config (`shared/app-config.ts`), always normalised/complete. */
  getConfig(): Promise<AppConfig>;

  /**
   * Replaces the whole app config and returns what was persisted (the
   * Settings screen holds the entire object and re-sends it on every
   * change). Rejects only on a filesystem write error.
   */
  setConfig(config: AppConfig): Promise<AppConfig>;

  /**
   * Flips one action trigger's "confirm" flag (the confirmation dialog's
   * "don't ask again") in the assistant plugin's own config — the narrow
   * write that replaced the whole-config round (ADR-0010 later change).
   */
  setTriggerConfirm(triggerId: string, confirm: boolean): Promise<void>;

  /**
   * Whether the quick-capture hotkey is registered (ADR-0073). Main
   * re-registers it on every `config:set`; `registered: false` with a
   * chord means another program holds the combo.
   */
  getCaptureHotkeyStatus(): Promise<CaptureHotkeyStatus>;
}

/** The quick-capture hotkey as main last registered it (ADR-0073). */
export interface CaptureHotkeyStatus {
  /** The stored chord (`shared/keybindings.ts` grammar); `null` = none set. */
  chord: string | null;
  registered: boolean;
}
