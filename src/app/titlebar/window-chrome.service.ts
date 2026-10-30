import { Injectable, signal } from '@angular/core';

/**
 * Backs the renderer-drawn window controls in `Titlebar`. The window is
 * frameless (`titleBarStyle: 'hidden'`, ADR-0019) so minimize / maximize /
 * close go through IPC; `maximized` mirrors the real window state (pushed
 * from main) so the button can show a restore glyph. `fullscreen` mirrors
 * OS fullscreen the same way, for the View menu's "Full screen" check mark.
 *
 * `isMac` is `true` on Darwin, where the platform keeps the traffic lights
 * and its own menu bar -- the titlebar then hides its custom buttons and
 * leaves room for the inset controls.
 */
@Injectable({ providedIn: 'root' })
export class WindowChromeService {
  private readonly api = typeof window !== 'undefined' ? window.dreyApi : undefined;

  readonly maximized = signal(false);
  readonly fullscreen = signal(false);
  readonly isMac = signal(false);

  constructor() {
    this.api
      ?.isWindowMaximized()
      .then((v) => this.maximized.set(v))
      .catch(() => undefined);
    this.api?.onWindowMaximizeChange((v) => this.maximized.set(v));
    this.api
      ?.isWindowFullScreen()
      .then((v) => this.fullscreen.set(v))
      .catch(() => undefined);
    this.api?.onWindowFullScreenChange((v) => this.fullscreen.set(v));
    this.api
      ?.getAppInfo()
      .then((info) => this.isMac.set(info.platform === 'darwin'))
      .catch(() => undefined);
  }

  /** Brings the window to the front (a clicked OS notification, req-64). */
  focus(): Promise<void> {
    return this.api?.focusWindow() ?? Promise.resolve();
  }

  minimize(): void {
    void this.api?.minimizeWindow();
  }

  toggleMaximize(): void {
    void this.api?.toggleMaximizeWindow();
  }

  toggleFullScreen(): void {
    void this.api?.toggleFullScreen();
  }

  close(): void {
    void this.api?.closeWindow();
  }
}
