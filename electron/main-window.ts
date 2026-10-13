import { app, BrowserWindow, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPC_CHANNELS } from '../shared/ipc-api';
import { rendererDevServerUrl, windowIconFor } from './app-paths';
import { buildContentSecurityPolicy, CSP_HEADER, isAppDocument } from './content-security-policy';
import type { ExitBridge } from './ipc';
import { logLine, watchWebContents } from './logger';
import { attachContextMenu } from './menu';

export interface MainWindowHostDeps {
  /** The renderer owns the dirty-document registry, so a close asks it (bug-5). */
  readonly exitBridge: ExitBridge;
  /** A window exists now -- plugins activated before it get it handed over. */
  readonly onCreated: (window: BrowserWindow) => void;
}

/**
 * The app's one main window: how it is created, and the save-before-exit
 * prompt every way of closing it runs through (bug-5).
 *
 * Exit-prompt state:
 * - `exitApproved` -- the renderer answered "save"/"exit without saving";
 *   the next `close` event is the real one and passes.
 * - `quitIntent` -- a quit was requested at app level (Cmd+Q, taskbar Quit)
 *   and routed through the prompt; `app.quit()` is called after the window
 *   actually closes. Reset when the user cancels (and when a fresh window
 *   opens, so a later close always prompts).
 */
export class MainWindowHost {
  private window: BrowserWindow | null = null;
  private exitApproved = false;
  private quitIntent = false;

  constructor(private readonly deps: MainWindowHostDeps) {}

  /** The main window, or null before the first one and after it closed. */
  get current(): BrowserWindow | null {
    return this.window;
  }

  /** Whether there is no usable main window (never created, closed or destroyed). */
  get isGone(): boolean {
    return this.window === null || this.window.isDestroyed();
  }

  /** Brings the window to the front; false when there is none. */
  raise(): boolean {
    if (!this.window) {
      return false;
    }
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.show();
    this.window.focus();
    return true;
  }

  /**
   * `before-quit`: an app-level quit (taskbar "Quit", Cmd+Q / role quit)
   * with the window still open routes through the same prompt: intercept
   * once, close the window -- the close handler asks the renderer -- and
   * re-issue the quit (`quitIntent`) after the window is really gone. The
   * no-window clause is load-bearing: after an approved plain window close,
   * window-all-closed -> app.quit() fires this with no window to ask
   * through, and it must not re-intercept.
   */
  interceptQuit(event: Electron.Event): void {
    if (this.exitApproved || this.quitIntent || !this.window || this.window.isDestroyed()) {
      return;
    }
    event.preventDefault();
    this.quitIntent = true;
    this.window.close();
  }

  create(
    getUiScaleFactor?: () => number,
    opts: { hiddenUntilReady?: boolean; themeId?: string } = {},
  ): BrowserWindow {
    // A fresh window is a fresh session: the next close prompts again.
    this.quitIntent = false;
    const icon = windowIconFor(opts.themeId ?? '');
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      // Milestone 62 (ADR-0062): the boot window stays hidden until the
      // renderer reports the workspace ready — the splash covers the parse
      // and the handover shows a painted app. Later windows (macOS
      // reopen) show immediately as before.
      show: opts.hiddenUntilReady !== true,
      // The frameless window draws no title bar, but this still sets the
      // taskbar / Alt-Tab icon (dev too, where there is no exe icon to
      // inherit). Follows the theme (req-42); `config:set` swaps it live.
      ...(icon !== null ? { icon } : {}),
      // Matches the default theme, Anthrazit (see CLAUDE.md, UI/UX Design) so the
      // window doesn't flash white while the renderer loads.
      backgroundColor: '#18191b',
      // Frameless: the renderer draws its own titlebar (accent square, the
      // File/Edit/Selection/View menu bar and the window controls) --
      // "VS Code style", ADR-0019. macOS keeps its traffic lights inset over
      // that bar; every other platform gets renderer-drawn buttons.
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      // Still bound so Alt reveals the (macOS-only) native menu and its
      // accelerators stay live where one exists.
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // The app ships its own spellchecker (nspell + CodeMirror
        // decorations, ADR-0013) and it is meant to be the only one.
        // Chromium's native checker would otherwise also underline every
        // <input>/<textarea> in its own default language (en-US on Windows,
        // never the configured one), with corrections reachable only through
        // a context menu we don't build -- exactly the "wrong language, no
        // way to fix a word" behaviour we're removing. Off, so spellcheck
        // looks and behaves identically everywhere.
        spellcheck: false,
        // Sandboxed (ADR-0001, later change). A sandboxed preload may only
        // require() a handful of built-ins, so `preload.js` is the single
        // file `scripts/bundle-preload.mjs` writes over tsc's output -- the
        // unbundled one would not run and leave window.dreyApi undefined.
        sandbox: true,
        // Chromium's built-in (PDFium) PDF viewer -- the only thing this
        // flag enables on modern Electron -- so PDF embeds
        // (`![](attachments/x.pdf)`, ADR-0052) and PDF tabs render inside
        // iframes instead of downloading or showing a blank frame.
        plugins: true,
      },
    });

    attachContextMenu(window);
    // Renderer-process failures -> the log file (ADR-0032).
    watchWebContents(window.webContents);

    // Belt-and-braces for the renderer's window-level drag/drop guard
    // (ADR-0027): a stray file / link drop must never navigate the window
    // away from the SPA, and an http(s) link opens in the OS browser.
    window.webContents.on('will-navigate', (event, url) => {
      const allowed = rendererDevServerUrl
        ? url.startsWith(rendererDevServerUrl)
        : url.startsWith('app://');
      if (!allowed) {
        event.preventDefault();
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Keep the renderer titlebar's maximize/restore glyph in sync with the
    // real window state.
    const emitMaximizeState = (): void => {
      window.webContents.send(IPC_CHANNELS.windowMaximizeChanged, window.isMaximized());
    };
    window.on('maximize', emitMaximizeState);
    window.on('unmaximize', emitMaximizeState);
    // Same sync for fullscreen (the View menu's "Full screen" check mark) --
    // also covers an F11 pressed outside the renderer's keybindings.
    const emitFullScreenState = (): void => {
      window.webContents.send(IPC_CHANNELS.windowFullScreenChanged, window.isFullScreen());
    };
    window.on('enter-full-screen', emitFullScreenState);
    window.on('leave-full-screen', emitFullScreenState);
    // The app is not a zoomable web page: Ctrl +/-/0 scales the editor
    // content in the renderer (ADR-0015), and the touchpad pinch gesture
    // must not zoom the whole window. Ctrl+wheel is suppressed renderer-side
    // (EditorZoomService).
    window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {
      // Older Electron rejects this off the main frame; harmless.
    });

    // Re-apply the app-wide "Base font size" (Settings -> Appearance) after
    // every load. `webContents.setZoomFactor` is reset by Chromium on each
    // navigation, and the renderer's own one-shot call on first config load
    // races the initial commit and is dropped -- so on a cold start the UI
    // opened unscaled even though the setting was stored. This is the
    // authoritative re-apply (ADR-0020).
    if (getUiScaleFactor) {
      window.webContents.on('did-finish-load', () => {
        const factor = getUiScaleFactor();
        if (Number.isFinite(factor) && factor > 0) {
          window.webContents.setZoomFactor(factor);
        }
      });
    }
    this.window = window;
    // Plugins activated before the window existed; deliver it to the ones
    // that subscribed via `ctx.app.onMainWindowCreated`.
    this.deps.onCreated(window);

    // Save-before-exit prompt (bug-5). Every close path -- the titlebar X
    // (window:close IPC), Alt+F4, the taskbar, a macOS role close -- ends up
    // here, so this is the one interception point: hold the window, ask the
    // renderer (which owns the dirty-document registry), and only let the
    // close through once it answers "save" or "exit without saving".
    window.on('close', (event) => {
      if (this.exitApproved) {
        return; // the deliberate second close() after the prompt
      }
      event.preventDefault();
      if (this.deps.exitBridge.hasPending()) {
        return; // a second X while the dialog is up -- keep waiting
      }
      void this.deps.exitBridge.requestDecision().then((decision) => {
        if (decision === 'cancel') {
          this.quitIntent = false;
          return;
        }
        this.exitApproved = true;
        window.close();
        // Non-darwin quits by itself via window-all-closed; on macOS closing
        // the window is not quitting -- finish an app-level quit explicitly.
        if (this.quitIntent) {
          app.quit();
        }
      });
    });

    window.on('closed', () => {
      this.window = null;
      // A fresh window (macOS reopen) prompts again.
      this.exitApproved = false;
    });

    if (rendererDevServerUrl) {
      // `ng serve` answers without our headers, so the same policy is added
      // to its page here; a production run gets it from the app:// handler.
      const devPolicy = buildContentSecurityPolicy(rendererDevServerUrl);
      window.webContents.session.webRequest.onHeadersReceived(
        { urls: [new URL('*', rendererDevServerUrl).toString()], types: ['mainFrame'] },
        (details, callback) => {
          if (!isAppDocument(new URL(details.url).pathname)) {
            callback({});
            return;
          }
          callback({ responseHeaders: { ...details.responseHeaders, [CSP_HEADER]: [devPolicy] } });
        },
      );
      window.loadURL(rendererDevServerUrl).catch(reportLoadFailure);
      window.webContents.openDevTools({ mode: 'detach' });
    } else {
      // Host segment ("app") is an arbitrary placeholder -- the `app://`
      // handler only looks at the path, not the host. Using a real host
      // instead of e.g. `app://index.html` keeps pathname unambiguous
      // (`/index.html`, not `/`) for this request and every relative
      // sub-resource request the page makes afterwards.
      window.loadURL('app://app/index.html').catch(reportLoadFailure);
    }

    return window;
  }
}

/** A page load that failed or was superseded; the window shows Chromium's own error. */
function reportLoadFailure(err: unknown): void {
  logLine(`[main/load] ${err instanceof Error ? err.message : String(err)}`);
}
