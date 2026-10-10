import { BrowserWindow } from 'electron';
import * as path from 'node:path';
import type { SplashProgress } from './splash-preload';

/**
 * The startup splash (milestone 62, ADR-0062): a small frameless window
 * shown before anything heavy runs, closed at the hidden-until-ready
 * handover. The controller owns only the window and the progress feed;
 * `main.ts` owns the handover logic and its fail-opens.
 *
 * The latest payload is latched and replayed on `did-finish-load` — a
 * push that races the page load would otherwise be dropped (nobody is
 * listening yet), and the very first stages always do race it.
 */
export class SplashController {
  private window: BrowserWindow | null = null;
  private last: SplashProgress | null = null;

  constructor(
    private readonly deps: {
      /** Renderer output dir — `splash.html` sits next to `index.html`. */
      readonly rendererDistDir: string;
      /** The dev server URL, when running against `ng serve`. */
      readonly rendererDevServerUrl: string | null;
      readonly iconPath: string | null;
    },
  ) {}

  /** Shows the splash. Once; later calls are no-ops. */
  create(): void {
    if (this.window !== null) {
      return;
    }
    const win = new BrowserWindow({
      width: 400,
      height: 300,
      useContentSize: true,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#1b1a19',
      autoHideMenuBar: true,
      ...(this.deps.iconPath !== null ? { icon: this.deps.iconPath } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Stricter than the main preload (ADR-0001): this preload imports
        // nothing from shared/, so the OS-level sandbox applies.
        sandbox: true,
        spellcheck: false,
      },
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
      }
    });
    // Replay whatever arrived before the page was listening.
    win.webContents.once('did-finish-load', () => {
      if (this.last !== null) {
        this.send(this.last);
      }
    });
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
      }
    });
    this.window = win;
    if (this.deps.rendererDevServerUrl !== null) {
      // `ng serve` serves public/ verbatim — same file, dev transport.
      win.loadURL(new URL('splash.html', this.deps.rendererDevServerUrl).toString());
    } else {
      win.loadFile(path.join(this.deps.rendererDistDir, 'splash.html'));
    }
  }

  /** Pushes one progress stage to the splash (no-op once closed). */
  progress(label: string, pct: number, version?: string): void {
    const payload: SplashProgress = {
      label,
      pct: Math.max(0, Math.min(100, Math.round(pct))),
      ...(version !== undefined ? { version } : {}),
    };
    this.last = payload;
    this.send(payload);
  }

  /** Closes the splash. Idempotent; never throws. */
  close(): void {
    const win = this.window;
    this.window = null;
    this.last = null;
    if (win !== null && !win.isDestroyed()) {
      win.close();
    }
  }

  get visible(): boolean {
    return this.window !== null;
  }

  private send(payload: SplashProgress): void {
    const win = this.window;
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send('splash:progress', payload);
    }
  }
}
