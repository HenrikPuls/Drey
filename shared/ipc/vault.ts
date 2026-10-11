/**
 * IPC contract, vault part: the vault registry (ADR-0051), the file
 * tree and file IO, renames that keep links intact (ADR-0059) and the
 * change push (ADR-0045) (`shared/ipc-api.ts` is the barrel).
 */

/**
 * One registered vault (ADR-0051). `id` is minted once at registration and
 * never changes -- it survives folder renames/moves because it lives in
 * the registry (`<userData>/vault-config.json`), not on disk -- and is the
 * vault identity carried through IPC payloads, open-tab keys and asset
 * URLs. `name` is the user-editable display name (defaults to the folder
 * basename; duplicates allowed). `path` is the absolute OS path of the
 * vault root.
 */
export interface VaultRegistration {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/**
 * A `VaultRegistration` plus its live status, as `listVaults()` reports it
 * to the Files panel: `exists` is false for a registration whose folder
 * has disappeared (moved drive, OneDrive not mounted -- the registration
 * stays and the row greys out), `active` marks the one vault that new
 * content (daily notes, capture, chats) targets by default.
 */
export interface VaultStatus extends VaultRegistration {
  readonly exists: boolean;
  readonly active: boolean;
}

/**
 * Payload of the `vault:changed` push (ADR-0045): external vault changes
 * landed (watcher batch, manual refresh, or an MCP write). `paths` lists
 * the changed/deleted `.md` files, vault-relative and forward-slash, so
 * consumers can scope their work -- `EditorService` auto-reloads the
 * matching clean tabs. Omitted when the batch is too big to be worth
 * listing (over 200 paths); consumers then treat the push as a full
 * refresh and must not touch open tabs.
 *
 * `vaultId` (ADR-0051) scopes the push to one vault: only that vault's
 * tree and tabs react. Absent means registry-level / all vaults -- a
 * registry mutation (add/remove/rename/set-active) or a refresh round that
 * covered everything -- and consumers reload all trees (and the registry).
 */
export interface VaultChangedPush {
  readonly vaultId?: string;
  readonly paths?: readonly string[];
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
 * A rename / move whose links should stay intact (milestone 59, ADR-0059).
 * `buffers` are the source vault's DIRTY open notes (path before the
 * rename, `\n` content): they are planned against the buffer instead of
 * the file and come back patched in {@link RenameLinksResult.buffers}
 * rather than being written -- the next save would otherwise undo the
 * rewrite.
 */
export interface RenameLinksRequest {
  fromRel: string;
  toRel: string;
  fromVaultId: string;
  toVaultId: string;
  buffers: Array<{ path: string; content: string }>;
}

/** One note whose links the rename rewrites. `path` is before the rename. */
export interface RenameLinkFile {
  path: string;
  newPath: string;
  links: number;
  before: string;
  after: string;
}

/** An attachment that travels with its note (vault-relative paths). */
export interface RenameAssetMove {
  kind: 'move' | 'copy';
  from: string;
  to: string;
}

export interface RenameLinksPreview {
  files: RenameLinkFile[];
  assets: RenameAssetMove[];
}

export interface RenameLinksResult {
  /** The renamed entry's new vault-relative path (in the target vault). */
  path: string;
  /** Notes rewritten on disk -- paths AFTER the rename, in the source vault. */
  written: string[];
  /** Patched contents for the dirty buffers -- paths AFTER the rename. */
  buffers: Array<{ path: string; content: string }>;
  /** The attachments that actually moved / were copied. */
  assets: RenameAssetMove[];
  /** What could not be carried out, as user-readable lines. */
  failed: string[];
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

/** The vault registry, the file tree and file IO. */
export interface VaultIpc {
  /** Currently active vault path, or null if none is active. */
  getActiveVault(): Promise<string | null>;

  // --- Vault registry (ADR-0051) ----------------------------------------

  /** Every registered vault with live status, in registration order. */
  listVaults(): Promise<VaultStatus[]>;

  /** The active vault's id, or null when none is active. */
  getActiveVaultId(): Promise<string | null>;

  /**
   * Opens a native folder picker and registers the chosen folder as a new
   * vault (display name defaults to the folder basename). Resolves to the
   * new registration, or null when the user cancelled. Rejects when the
   * folder is already registered.
   */
  addVault(): Promise<VaultRegistration | null>;

  /**
   * Removes a vault from the registry -- never touches the folder on disk.
   * Removing the active vault promotes the first remaining one (or none).
   */
  removeVault(vaultId: string): Promise<void>;

  /** Renames a vault's display name (the id and folder are untouched). */
  renameVault(vaultId: string, name: string): Promise<VaultRegistration>;

  /** Makes `vaultId` the active vault (the default target for new content). */
  setActiveVault(vaultId: string): Promise<void>;

  /** Shows the vault's folder in the OS file manager. */
  revealVaultFolder(vaultId: string): Promise<void>;

  /**
   * Reveals a vault-relative file/folder in the OS file manager (selected
   * in its parent folder). Throws when the path resolves outside the
   * vault -- the absolute path never crosses the bridge.
   */
  revealVaultPath(relativePath: string, vaultId: string): Promise<void>;

  /**
   * Opens the OS terminal with its working directory at the vault-relative
   * folder. Throws when no terminal can be launched (Linux best effort).
   */
  openVaultFolderInTerminal(dirRelativePath: string, vaultId: string): Promise<void>;

  /**
   * Opens a vault file in the program the OS associates with it
   * (ADR-0066) -- Office documents and the like, which Drey has no viewer
   * for. Rejects when the extension is not on the document allowlist, the
   * file is missing, or the OS has no program for it.
   */
  openVaultFileExternally(relativePath: string, vaultId?: string): Promise<void>;

  /**
   * Recursively lists a vault's contents. `vaultId` defaults to the active
   * vault. Rejects if that vault's folder can't be read (e.g. moved/deleted
   * since it was registered -- plausible given a vault can live on
   * OneDrive, see specs/roadmap.md).
   */
  listVaultFiles(vaultId?: string): Promise<VaultFileEntry[]>;

  /**
   * Runs one full vault refresh round in main (ADR-0045): the plugins'
   * indexes rebuild and a `vault:changed` push follows, so the tree,
   * plugin panels and clean open tabs all reload from it. This is what
   * the Files panel's refresh button invokes -- it fixes the old gap
   * where a manual refresh re-pulled the tree but left the tag/task
   * indexes stale. Harmless with no vault active.
   */
  refreshVault(): Promise<void>;

  /**
   * Reads one file inside a vault. `relativePath` is a forward-slash path
   * relative to the vault root (as delivered by `listVaultFiles`);
   * `vaultId` defaults to the active vault. Rejects if the path resolves
   * outside the vault, or if the file can't be read.
   */
  readVaultFile(relativePath: string, vaultId?: string): Promise<VaultFileContent>;

  /**
   * Overwrites one file inside a vault with `content` (UTF-8). Same
   * `relativePath` rules and rejection conditions as `readVaultFile`;
   * `vaultId` defaults to the active vault. Resolves to the file's new
   * `modifiedMs` after the write.
   *
   * `opts.announce` (milestone 64) also runs the change round for this one
   * path -- the `vault:changed` push, so the file tree shows a new file
   * and pictures of the file reload. Off by default: most callers write a
   * file they are about to refresh themselves.
   */
  writeVaultFile(
    relativePath: string,
    content: string,
    vaultId?: string,
    opts?: { announce?: boolean },
  ): Promise<number>;

  /** The raw bytes of one vault file (milestone 64); path rules as `readVaultFile`. */
  readVaultBinary(relativePath: string, vaultId?: string): Promise<Uint8Array>;

  /**
   * Overwrites (or creates) one binary file at an exact vault-relative
   * path (milestone 64) -- unlike `saveVaultAsset`, the caller names the
   * file. Same path rules as `writeVaultFile`, including `opts.announce`.
   * Resolves to the file's new `modifiedMs`.
   */
  writeVaultBinary(
    relativePath: string,
    bytes: Uint8Array,
    vaultId?: string,
    opts?: { announce?: boolean },
  ): Promise<number>;

  /**
   * Saves a binary asset -- a pasted or dropped image -- into an
   * `attachments/` folder beside the note that references it (ADR-0024).
   * `noteRelPath` is the open document's vault-relative path (a bare name /
   * empty string falls back to the vault root's `attachments/`); `ext` is
   * the file extension without a dot (`imageExtension()` from
   * `shared/asset-name.ts`); `vaultId` defaults to the active vault.
   * Resolves to the path to drop into the `![](...)` -- relative to the
   * note's own folder, so `resolveVaultImageUrl` turns it straight back
   * into a `drey-asset://` URL. Rejects if the resolved folder escapes the
   * vault.
   */
  saveVaultAsset(
    bytes: Uint8Array,
    ext: string,
    noteRelPath: string,
    vaultId?: string,
    preferredName?: string,
  ): Promise<string>;

  /**
   * Downloads a web image and saves it like `saveVaultAsset` (ADR-0028) --
   * the main process `fetch`es `url` (http(s) only, redirects followed
   * with a final-protocol re-check, 15 s timeout, 25 MB cap, image
   * content-type / extension required), then writes the bytes into the
   * note's `attachments/`. Resolves to the note-relative path for
   * `![](...)`. Rejects with a short user-facing message on any of: not a
   * URL, non-http(s), HTTP error, timeout, too large, not an image.
   */
  saveVaultAssetFromUrl(url: string, noteRelPath: string, vaultId?: string): Promise<string>;

  /**
   * Creates an empty file inside a vault (any missing parent folders are
   * created too). `relativePath` follows the same forward-slash / no-escape
   * rules as `readVaultFile`; `vaultId` defaults to the active vault.
   * Rejects if a file or folder already exists at that path. Resolves to
   * the created file's vault-relative path (echoed back so the renderer
   * can open it in the editor).
   */
  createVaultFile(relativePath: string, vaultId?: string): Promise<string>;

  /**
   * Creates a directory inside a vault (missing parents included). Same
   * path rules as `createVaultFile`; `vaultId` defaults to the active
   * vault. Rejects if anything already exists at that path. Resolves to
   * the created directory's vault-relative path.
   */
  createVaultDirectory(relativePath: string, vaultId?: string): Promise<string>;

  /**
   * Renames / moves a file or folder. Both paths follow the
   * `readVaultFile` rules; refuses a vault root, a missing source and an
   * occupied target. When `fromVaultId` and `toVaultId` differ the entry
   * moves ACROSS vaults (copy + delete under the hood -- a `.md` note's
   * assistant sidecar comes along); both default to the active vault.
   * Resolves to the new vault-relative path (inside the target vault).
   */
  renameVaultEntry(
    fromRelativePath: string,
    toRelativePath: string,
    fromVaultId?: string,
    toVaultId?: string,
  ): Promise<string>;

  /**
   * What `renameVaultEntryWithLinks` would change (milestone 59): the notes
   * whose links need rewriting and the attachments that travel along.
   * Nothing is touched.
   */
  previewVaultRename(request: RenameLinksRequest): Promise<RenameLinksPreview>;

  /**
   * `renameVaultEntry` plus the link rewrite: the plan is computed fresh
   * (not taken from the preview), the entry is renamed, the affected notes
   * are rewritten and the attachments moved.
   */
  renameVaultEntryWithLinks(request: RenameLinksRequest): Promise<RenameLinksResult>;

  /**
   * Copies a file or folder (recursively) into `destDirRelativePath`
   * (`''` = vault root). Keeps the source name, or adds a `" copy"` /
   * `" copy N"` suffix on a collision. Refuses copying a folder into its
   * own subtree. A `.md` note's assistant sidecar is copied along.
   * `sourceVaultId`/`destVaultId` default to the active vault and may
   * differ (a cross-vault copy). Resolves to the new entry's
   * vault-relative path inside the destination vault.
   */
  copyVaultEntry(
    sourceRelativePath: string,
    destDirRelativePath: string,
    sourceVaultId?: string,
    destVaultId?: string,
  ): Promise<string>;

  /**
   * Copies an entry next to itself, always with a `" copy"` suffix.
   * `vaultId` defaults to the active vault. Resolves to the new entry's
   * vault-relative path.
   */
  duplicateVaultEntry(sourceRelativePath: string, vaultId?: string): Promise<string>;

  /**
   * Deletes a file or folder (recursively) inside a vault -- to the OS
   * recycle bin by default, permanently with `{ trash: false }`
   * (move-semantics callers). Same path rules as `readVaultFile`;
   * `vaultId` defaults to the active vault; refuses the vault root.
   * Deleting a `.md` note also removes its assistant sidecar
   * (`.{name}.chat.json`) if present. A missing target is not an error.
   * Rejects only on a bad path or a real filesystem failure. Resolves to
   * the paths that fell back to a permanent delete (their volume has no
   * recycle bin) -- empty unless asked otherwise and the bin was missing.
   */
  deleteVaultEntry(
    relativePath: string,
    vaultId?: string,
    opts?: { trash?: boolean },
  ): Promise<string[]>;

  /**
   * Deletes several files / folders (recursively) inside one vault in a
   * single round trip -- the Files panel's multi-select delete (bug-8).
   * Same per-path rules as `deleteVaultEntry`; `vaultId` defaults to the
   * active vault; overlapping paths (a folder and a file inside it) are
   * fine because a missing target is not an error. One vault-change
   * re-index fires for the whole batch, not per path. Resolves to the
   * paths that fell back to a permanent delete (no recycle bin on their
   * volume).
   */
  deleteVaultEntries(
    relativePaths: string[],
    vaultId?: string,
    opts?: { trash?: boolean },
  ): Promise<string[]>;

  /**
   * Fires when vault changes have landed in main (ADR-0045): a watcher
   * batch of external edits, a manual refresh, or an MCP `vault_write`.
   * The payload's `paths` (when present) scope the reaction -- reload the
   * file tree, re-pull panel data, auto-reload the matching clean tabs.
   * Returns an unsubscribe.
   */
  onVaultChanged(listener: (push: VaultChangedPush) => void): () => void;
}
