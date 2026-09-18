import { BrowserWindow } from 'electron';

/**
 * Hands keyboard focus back to the renderer after a native surface closed
 * -- a `dialog.show*` call, or (historically) the renderer's own blocking
 * `confirm()`/`alert()`. Electron on Windows can leave the window painting
 * fine but with no focused webContents: no caret, typed characters dead,
 * mouse still working, an Alt+Tab round trip clears it (electron#41602).
 * Every main-side dialog path calls this as its dialog resolves; a no-op
 * when focus never left.
 */
export function refocusRenderer(win?: BrowserWindow | null): void {
  const target = win ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!target) {
    return;
  }
  if (target.isMinimized()) {
    target.restore();
  }
  target.focus();
  target.webContents.focus();
}
