import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

/**
 * The splash window's only bridge (milestone 62): main pushes progress
 * (`SplashController.progress`), the page renders it. Same shape rules as
 * the main preload (ADR-0001): a typed, minimal object — no `ipcRenderer`
 * reference, no Node globals. Lives beside `preload.ts`; tsc emits both
 * into `dist-electron/electron/`.
 */

/** One splash progress push. `pct` is 0–100 (stage-weighted, jumps). */
export interface SplashProgress {
  label: string;
  pct: number;
  /** Sent once with the first push so the splash can show the version. */
  version?: string;
}

contextBridge.exposeInMainWorld('splashApi', {
  onProgress: (listener: (progress: SplashProgress) => void): void => {
    const wrapped = (_event: IpcRendererEvent, progress: SplashProgress): void =>
      listener(progress);
    ipcRenderer.on('splash:progress', wrapped);
  },
});
