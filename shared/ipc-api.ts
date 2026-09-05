/**
 * Typed IPC contract between the Electron main process and the Angular
 * renderer, exposed via `contextBridge` (see electron/preload.ts).
 *
 * This file is imported by BOTH sides of the boundary -- main (which
 * implements it) and renderer (which consumes it) -- so a mismatch
 * between what main sends and what renderer expects is a compile error,
 * not a runtime surprise. See docs/09_architecture_decisions/0001-*.md.
 */

/**
 * Channel names. Most are `ipcMain.handle` / `ipcRenderer.invoke` request
 * pairs; `dailyOpen` is the first main -> renderer push
 * (`webContents.send` / `ipcRenderer.on`) -- fired by the quick-capture
 * hotkey to tell the renderer which file to open.
 */
export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  vaultGetActive: 'vault:get-active',
  vaultSelect: 'vault:select',
  vaultListFiles: 'vault:list-files',
  vaultReadFile: 'vault:read-file',
  vaultWriteFile: 'vault:write-file',
  vaultCreateFile: 'vault:create-file',
  vaultCreateDirectory: 'vault:create-directory',
  dailyOpen: 'daily:open',
  dailyBuildContent: 'daily:build-content',
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

/**
 * A single file's contents plus the modification time it had when read.
 * `modifiedMs` is epoch milliseconds (`fs.Stats.mtimeMs`) -- milestone 3
 * only round-trips it (read -> hold -> hand back on write) so the value is
 * there when the file watcher lands and needs a cheap "changed on disk
 * since we opened it?" check (see specs/roadmap.md, "Phase 1" file
 * watcher; docs/11_risks_and_technical_debt.md, autosave-vs-watcher).
 */
export interface VaultFileContent {
  content: string;
  modifiedMs: number;
}

/** The API surface exposed on `window.dreyApi` by the preload script. */
export interface DreyApi {
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

  /**
   * Reads one file inside the active vault. `relativePath` is a
   * forward-slash path relative to the vault root (as delivered by
   * `listVaultFiles`). Rejects if no vault is active, if the path resolves
   * outside the vault, or if the file can't be read.
   */
  readVaultFile(relativePath: string): Promise<VaultFileContent>;

  /**
   * Overwrites one file inside the active vault with `content` (UTF-8).
   * Same `relativePath` rules and rejection conditions as `readVaultFile`.
   * Resolves to the file's new `modifiedMs` after the write.
   */
  writeVaultFile(relativePath: string, content: string): Promise<number>;

  /**
   * Creates an empty file inside the active vault (any missing parent
   * folders are created too). `relativePath` follows the same forward-slash
   * / no-escape rules as `readVaultFile`. Rejects if a file or folder
   * already exists at that path, or if no vault is active. Resolves to the
   * created file's vault-relative path (echoed back so the renderer can
   * open it in the editor).
   */
  createVaultFile(relativePath: string): Promise<string>;

  /**
   * Creates a directory inside the active vault (missing parents included).
   * Same path rules as `createVaultFile`; rejects if anything already
   * exists at that path. Resolves to the created directory's
   * vault-relative path.
   */
  createVaultDirectory(relativePath: string): Promise<string>;

  /**
   * Builds the Markdown a fresh daily note for `date` (`YYYY-MM-DD`) would
   * start from -- the current `templates/daily.md` with its placeholders
   * substituted -- WITHOUT creating the file (and without scaffolding the
   * template either). The renderer opens the result as an unsaved draft
   * buffer when a calendar day with no note yet is clicked; `daily/<date>.md`
   * is written only once the user types something and saves, so clicking
   * around the calendar never litters the vault with empty notes.
   * `{{date}}` / `{{title}}` come from `date`; `{{time}}` / `{{datetime}}`
   * from the current wall-clock time. Rejects if no vault is active or
   * `date` is not a `YYYY-MM-DD` string.
   */
  buildDailyNoteContent(date: string): Promise<string>;

  /**
   * Subscribes to the quick-capture hotkey signal from the main process.
   * The payload is the vault-relative path of today's daily note --
   * already created from `templates/daily.md` (scaffolded on first use)
   * if it did not exist. The renderer opens it in the editor and starts a
   * fresh `## HH:mm` entry. Returns an unsubscribe function; the raw IPC
   * event is never forwarded (see docs/09_architecture_decisions/0001-*.md).
   */
  onOpenDailyNote(listener: (relativePath: string) => void): () => void;
}

declare global {
  interface Window {
    dreyApi: DreyApi;
  }
}
