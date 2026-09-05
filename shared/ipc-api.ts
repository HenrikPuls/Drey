/**
 * Typed IPC contract between the Electron main process and the Angular
 * renderer, exposed via `contextBridge` (see electron/preload.ts).
 *
 * This file is imported by BOTH sides of the boundary -- main (which
 * implements it) and renderer (which consumes it) -- so a mismatch
 * between what main sends and what renderer expects is a compile error,
 * not a runtime surprise. See docs/09_architecture_decisions/0001-*.md.
 */

/** Channel names for ipcMain.handle / ipcRenderer.invoke pairs. */
export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  vaultGetActive: 'vault:get-active',
  vaultSelect: 'vault:select',
  vaultListFiles: 'vault:list-files',
} as const;

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

/**
 * One entry in a vault's file tree, as returned by `listVaultFiles()`.
 * `relativePath` is relative to the vault root and always forward-slash
 * separated (even on Windows), so the renderer never has to know the
 * host's path separator convention.
 */
export interface VaultFileEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  /** Present (possibly empty) for directories only. */
  children?: VaultFileEntry[];
}

/** The API surface exposed on `window.cyberNotesApi` by the preload script. */
export interface CyberNotesApi {
  getAppInfo(): Promise<AppInfo>;

  /** Currently active vault path, or null if none has been selected yet. */
  getActiveVault(): Promise<string | null>;

  /**
   * Opens a native folder picker. Returns the resulting active vault path
   * (the newly picked one, or the previous one unchanged if the user
   * cancels the dialog) -- never rejects on cancel.
   */
  selectVault(): Promise<string | null>;

  /**
   * Recursively lists the active vault's contents. Rejects if no vault is
   * active, or if the vault folder can't be read (e.g. moved/deleted
   * since it was selected -- plausible given a vault can live on
   * OneDrive, see specs/roadmap.md).
   */
  listVaultFiles(): Promise<VaultFileEntry[]>;
}

declare global {
  interface Window {
    cyberNotesApi: CyberNotesApi;
  }
}
