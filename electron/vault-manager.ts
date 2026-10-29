import { app, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  assetFileName,
  ATTACHMENTS_DIR,
  imageExtension,
  sanitizedAssetFileName,
} from '../shared/asset-name';
import { sidecarPathFor } from '../shared/sidecar';
import { VaultFileContent, VaultFileEntry, VaultRegistration, VaultStatus } from '../shared/ipc-api';
import { uniqueCopyName } from '../shared/unique-name';
import { removeEntryFromDisk } from './trash-delete';
import { NOTE_FILE } from '../shared/wikilinks';
import type { NoteHistoryStore } from './history/note-history-store';
import { OwnWriteLedger } from './own-write-ledger';
import { refocusRenderer } from './focus';
import { openDocumentInDefaultProgram } from './open-document';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  readJsonObjectGuarded,
  type UnreadableFile,
} from './safe-file';
import { isReservedRootName } from './vault-scan-rules';

/**
 * `vault-config.json` v2 (ADR-0051): every registered vault plus which one
 * is active. The v1 shape was `{ activeVaultPath: string | null }` and is
 * migrated on first read (one registration, id minted, persisted straight
 * back).
 */
interface VaultRegistryFile {
  version: 2;
  vaults: VaultRegistration[];
  activeVaultId: string | null;
}

/** Cap for a downloaded web image (`saveAssetFromUrl`). */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const configFilePath = (): string => path.join(app.getPath('userData'), 'vault-config.json');

function mintVaultId(): string {
  // 10 hex chars -- URL/filesystem-safe, no `:` (the docKey and ledger key
  // formats rely on that), collision-practically-free.
  return `v${crypto.randomBytes(5).toString('hex')}`;
}

interface LoadedRegistry {
  file: VaultRegistryFile;
  problem: UnreadableFile | null;
  /** True when the file was in the v1 shape and `file` carries a freshly minted id. */
  migrated: boolean;
}

function readRegistryFile(): LoadedRegistry {
  const stored = readJsonObjectGuarded(configFilePath());
  if (stored.kind !== 'ok') {
    // First run, or an unusable file that was set aside: an empty registry.
    return {
      file: { version: 2, vaults: [], activeVaultId: null },
      problem: stored.kind === 'unreadable' ? stored.problem : null,
      migrated: false,
    };
  }
  const file = parseRegistry(stored.value);
  return { file, problem: null, migrated: stored.value['version'] !== 2 && file.vaults.length > 0 };
}

function parseRegistry(stored: Record<string, unknown>): VaultRegistryFile {
  const parsed = stored as Partial<VaultRegistryFile> & {
    activeVaultPath?: unknown;
  };
  if (parsed.version === 2 && Array.isArray(parsed.vaults)) {
    const vaults = parsed.vaults.filter(
      (v): v is VaultRegistration =>
        typeof v?.id === 'string' &&
        typeof v?.name === 'string' &&
        typeof v?.path === 'string',
    );
    const activeVaultId =
      typeof parsed.activeVaultId === 'string' && vaults.some((v) => v.id === parsed.activeVaultId)
        ? parsed.activeVaultId
        : null;
    return { version: 2, vaults, activeVaultId };
  }
  // v1 migration: the single path becomes the one registration. A missing
  // path stays an empty registry -- the same "no vault" fallback v1 had.
  const legacy =
    typeof parsed.activeVaultPath === 'string' && parsed.activeVaultPath !== ''
      ? parsed.activeVaultPath
      : null;
  if (legacy === null) {
    return { version: 2, vaults: [], activeVaultId: null };
  }
  const vault: VaultRegistration = {
    id: mintVaultId(),
    name: path.basename(legacy),
    path: legacy,
  };
  return { version: 2, vaults: [vault], activeVaultId: vault.id };
}

function writeRegistryFile(registry: VaultRegistryFile): void {
  const filePath = configFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(registry, null, 2));
}

/**
 * Vault registration (multi-vault since ADR-0051), the active vault, and
 * per-vault path resolution (see docs/05_building_block_view.md §5.0,
 * "Component reference"). A
 * vault is just a folder on disk -- this class remembers the registry (in
 * a small per-user config file, not the vault itself -- the vault stays
 * plain files, no database) and reads the folders' contents. No
 * note/frontmatter parsing here; that starts with the editor and tag
 * routing.
 *
 * Every operation takes an optional trailing `vaultId` defaulting to the
 * active vault, so existing single-vault call sites (daily notes, drafts,
 * chats) compile and behave unchanged -- they keep hitting the active
 * vault. A registration whose folder has disappeared (moved drive,
 * OneDrive not mounted) is kept and reported with `exists: false`; the
 * active-vault accessors then behave like "no active vault" so the
 * creating flows fail soft, exactly as the pre-registry version did.
 */
export class VaultManager {
  private registry: VaultRegistration[];
  private activeVaultId: string | null;

  /**
   * When present, every mutating method reports itself here so the vault
   * watcher (ADR-0045) can drop the app's own echoes. Optional so test
   * fakes and non-watcher setups construct the manager unchanged.
   */
  private readonly ownWrites?: OwnWriteLedger;

  /**
   * The local note history (ADR-0060): `writeFile` hands it the version a
   * write is about to replace, `renameEntry` keeps it attached to a moved
   * note. Optional for the same reason as the ledger.
   */
  private readonly history?: NoteHistoryStore;

  /**
   * Set when `vault-config.json` existed but could not be used: the
   * registry starts empty and the file was set aside. Main tells the user
   * once.
   */
  readonly loadProblem: UnreadableFile | null;

  constructor(ownWrites?: OwnWriteLedger, history?: NoteHistoryStore) {
    this.ownWrites = ownWrites;
    this.history = history;
    const { file, problem, migrated } = readRegistryFile();
    this.loadProblem = problem;
    this.registry = file.vaults;
    this.activeVaultId = file.activeVaultId;
    // Don't trust a stale registration blindly: the folder may have been
    // moved, renamed, or (on OneDrive/an external drive, see
    // specs/roadmap.md) just not mounted yet at this exact moment. Treat
    // it as "no active vault" for this session rather than erroring, but
    // leave the config file itself untouched -- if the path reappears
    // (e.g. a drive gets mounted after launch), the next restart picks it
    // up again.
    if (this.activeVaultId !== null && !fs.existsSync(this.pathOf(this.activeVaultId))) {
      this.activeVaultId = null;
    }
    // Only the v1->v2 migration rewrites the file here, so the minted id
    // is the vault's id from now on. The missing-folder guard above
    // deliberately does NOT persist on its own: the registration (and its
    // active flag) must survive so a remounted drive recovers on restart.
    if (migrated) {
      writeRegistryFile(file);
    }
  }

  private persist(): void {
    writeRegistryFile({ version: 2, vaults: this.registry, activeVaultId: this.activeVaultId });
  }

  /** Every registered vault with its live status, in registration order. */
  listVaults(): VaultStatus[] {
    return this.registry.map((v) => ({
      ...v,
      exists: fs.existsSync(v.path),
      active: v.id === this.activeVaultId,
    }));
  }

  getActiveVaultId(): string | null {
    return this.activeVaultId;
  }

  /** Absolute path of the active vault root, or null (none / folder gone). */
  getActiveVaultPath(): string | null {
    if (this.activeVaultId === null) {
      return null;
    }
    const reg = this.pathOf(this.activeVaultId);
    return fs.existsSync(reg) ? reg : null;
  }

  hasVault(vaultId: string): boolean {
    return this.registry.some((v) => v.id === vaultId);
  }

  /**
   * Resolves an optional vault id to a concrete one (default: the active
   * vault) -- for callers that need the id itself, e.g. to stamp an
   * announcement with the vault a write landed in.
   */
  resolveVaultId(vaultId?: string): string {
    return this.registrationFor(vaultId).id;
  }

  /**
   * Opens a native folder picker and registers the chosen folder. The
   * display name defaults to the folder's basename; a folder that is
   * already registered (case-insensitively resolved) is rejected. The
   * first vault ever registered becomes active automatically.
   */
  async addVault(): Promise<VaultRegistration | null> {
    const result = await dialog.showOpenDialog({
      title: 'Add vault folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    refocusRenderer();
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return this.addVaultAt(result.filePaths[0]);
  }

  /**
   * Registers an existing folder as a vault without a picker (T-0045:
   * the one click on "Register as vault" for a repository the scan
   * found under a parent vault). Same rules as {@link addVault}: the
   * name defaults to the folder's basename, an already-registered
   * folder is rejected, the first vault ever registered becomes active.
   */
  addVaultAt(folderPath: string): VaultRegistration {
    const chosen = path.resolve(folderPath);
    const existing = this.registry.find((v) => path.resolve(v.path).toLowerCase() === chosen.toLowerCase());
    if (existing) {
      throw new Error(`That folder is already registered as vault "${existing.name}".`);
    }
    const vault: VaultRegistration = { id: mintVaultId(), name: path.basename(chosen), path: chosen };
    this.registry = [...this.registry, vault];
    if (this.activeVaultId === null) {
      this.activeVaultId = vault.id;
    }
    this.persist();
    return vault;
  }

  /**
   * Removes a vault from the registry. Never touches the folder on disk.
   * Removing the active vault promotes the first remaining one (or none).
   */
  removeVault(vaultId: string): void {
    if (!this.hasVault(vaultId)) {
      return;
    }
    this.registry = this.registry.filter((v) => v.id !== vaultId);
    if (this.activeVaultId === vaultId) {
      this.activeVaultId = this.registry[0]?.id ?? null;
    }
    this.persist();
  }

  /** Renames a vault's display name; id and folder are untouched. */
  renameVault(vaultId: string, name: string): VaultStatus {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new Error('A vault name cannot be empty.');
    }
    const vault = this.registrationFor(vaultId);
    this.registry = this.registry.map((v) => (v.id === vaultId ? { ...v, name: trimmed } : v));
    this.persist();
    return { ...vault, name: trimmed, exists: fs.existsSync(vault.path), active: vault.id === this.activeVaultId };
  }

  /** Makes `vaultId` the active vault (the default target for new content). */
  setActiveVault(vaultId: string): void {
    this.registrationFor(vaultId); // throws on unknown id
    this.activeVaultId = vaultId;
    this.persist();
  }

  /** Shows the vault's folder in the OS file manager. */
  revealVaultFolder(vaultId: string): void {
    shell.showItemInFolder(this.pathOf(vaultId));
  }

  /**
   * Reveals a vault-relative file/folder in the OS file manager
   * (`shell.showItemInFolder` opens the containing folder with the item
   * selected -- for a folder row, the folder selected in its parent). Only
   * paths resolving inside a registered vault are reachable -- the
   * absolute path never crosses the IPC bridge.
   */
  revealPath(relativePath: string, vaultId?: string): void {
    shell.showItemInFolder(this.resolveInVault(relativePath, vaultId));
  }

  /**
   * Opens a vault file in the program the OS associates with it
   * (ADR-0066) -- only document types on the allowlist, and only a path
   * resolving inside a registered vault.
   */
  async openExternally(relativePath: string, vaultId?: string): Promise<void> {
    await openDocumentInDefaultProgram(this.resolveInVault(relativePath, vaultId));
  }

  /**
   * Opens the OS terminal with its working directory at the vault-relative
   * folder (a file row uses its containing folder). Detached + unref'd, so
   * the terminal outlives the app; spawned by ARG ARRAY with `cwd` -- the
   * path is never interpolated into a shell string. On Windows the first
   * candidate is Windows Terminal; the cmd fallback routes through `start`,
   * because a detached child is created with `DETACHED_PROCESS` and thus
   * never gets a console of its own -- a plain `cmd /K` opened no window.
   */
  async openTerminalIn(dirRelativePath: string, vaultId?: string): Promise<void> {
    const dir = this.resolveInVault(dirRelativePath, vaultId);
    if (process.platform === 'darwin') {
      if (!(await launchTerminal('open', ['-a', 'Terminal', dir]))) {
        throw new Error('Could not open Terminal.');
      }
      return;
    }
    const candidates: Array<{ cmd: string; args: string[]; cwd?: string; label: string }> =
      process.platform === 'win32'
        ? [
            { cmd: 'wt.exe', args: ['-d', dir], label: 'Windows Terminal' },
            {
              cmd: process.env['ComSpec'] ?? 'cmd.exe',
              // The empty-string arg is `start`'s window-title placeholder,
              // keeping `cmd` from being read as the title.
              args: ['/c', 'start', '', 'cmd'],
              cwd: dir,
              label: 'cmd',
            },
          ]
        : [
            {
              cmd: 'gnome-terminal',
              args: ['--working-directory=' + dir],
              label: 'gnome-terminal',
            },
            { cmd: 'konsole', args: ['--workdir', dir], label: 'konsole' },
            { cmd: 'kitty', args: ['--directory', dir], label: 'kitty' },
            { cmd: 'xdg-terminal-exec', args: [], cwd: dir, label: 'xdg-terminal-exec' },
          ];
    for (const candidate of candidates) {
      if (await launchTerminal(candidate.cmd, candidate.args, candidate.cwd)) {
        return;
      }
    }
    throw new Error(`No terminal found (tried ${candidates.map((c) => c.label).join(', ')}).`);
  }

  async pickSavePath(suggestedName: string, vaultId?: string): Promise<string | null> {
    const root = path.resolve(this.rootOf(vaultId));
    const name = suggestedName.trim() || 'untitled.md';
    const result = await dialog.showSaveDialog({
      title: 'Save note',
      defaultPath: path.join(root, name),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    refocusRenderer();
    if (result.canceled || !result.filePath) {
      return null;
    }
    let chosen = path.resolve(result.filePath);
    if (!chosen.toLowerCase().endsWith('.md')) {
      chosen += '.md';
    }
    if (chosen !== root && !chosen.startsWith(root + path.sep)) {
      throw new Error('The file must be saved inside the vault.');
    }
    return path.relative(root, chosen).split(path.sep).join('/');
  }

  async listFiles(vaultId?: string): Promise<VaultFileEntry[]> {
    const root = this.existingRootOf(vaultId);
    return readDirRecursive(root, root);
  }

  /**
   * Flat list of every `.md` file in the vault, vault-relative and
   * forward-slash separated. Feeds the tag index scan; dotfolders are
   * skipped, same as `listFiles`.
   */
  async listMarkdownFiles(vaultId?: string): Promise<string[]> {
    const root = this.existingRootOf(vaultId);
    const out: string[] = [];
    await collectMarkdown(root, root, out);
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  /**
   * Every `.md` file across ALL registered vaults, each stamped with its
   * vault id (ADR-0051) -- the "all vaults" search scope and the MCP regex
   * fallback scan. Missing folders contribute nothing.
   */
  async listAllMarkdownFiles(): Promise<Array<{ vaultId: string; path: string }>> {
    const out: Array<{ vaultId: string; path: string }> = [];
    for (const vault of this.registry) {
      if (!fs.existsSync(vault.path)) {
        continue;
      }
      const files: string[] = [];
      await collectMarkdown(vault.path, vault.path, files);
      for (const p of files) {
        out.push({ vaultId: vault.id, path: p });
      }
    }
    return out;
  }

  async readFile(relativePath: string, vaultId?: string): Promise<VaultFileContent> {
    const filePath = this.resolveInVault(relativePath, vaultId);
    const [content, stat] = await Promise.all([
      fsp.readFile(filePath, 'utf-8'),
      fsp.stat(filePath),
    ]);
    return { content, modifiedMs: stat.mtimeMs };
  }

  /**
   * Writes a text file. Before a note is overwritten, the version on disk
   * goes into the local history (ADR-0060) -- every writer passes through
   * here, so that is the one place that can promise "the previous text is
   * still somewhere". `origin` names the writer for the history list; a
   * `throttled` origin (the user's own saves) records at most one version
   * per few minutes.
   */
  async writeFile(
    relativePath: string,
    content: string,
    vaultId?: string,
    opts?: { origin?: string; throttled?: boolean },
  ): Promise<number> {
    const resolvedVault = this.registrationFor(vaultId);
    const filePath = this.resolveInVault(relativePath, resolvedVault.id);
    if (this.history !== undefined && NOTE_FILE.test(relativePath)) {
      const previous = await fsp.readFile(filePath, 'utf-8').catch(() => null);
      if (previous !== null && previous !== content) {
        await this.history.capture(resolvedVault.id, relativePath, previous, opts?.origin ?? 'app', {
          throttled: opts?.throttled,
        });
      }
    }
    // Create intermediate folders (e.g. `daily/` on the first save of a
    // calendar-created draft note) -- the write won't on its own.
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // Atomic: a crash or a sync client mid-write never leaves half a note.
    await atomicWriteFile(filePath, content);
    const stat = await fsp.stat(filePath);
    this.ownWrites?.recordWrite(resolvedVault.id, relativePath, stat.mtimeMs);
    return stat.mtimeMs;
  }

  /** The raw bytes of one vault file (milestone 64: a `.drawio.png` diagram). */
  async readBinaryFile(relativePath: string, vaultId?: string): Promise<Uint8Array> {
    const resolvedVault = this.registrationFor(vaultId);
    return fsp.readFile(this.resolveInVault(relativePath, resolvedVault.id));
  }

  /**
   * Overwrites (or creates) one binary file at an exact vault-relative
   * path (milestone 64: a `.drawio.png` diagram saved in place). Unlike
   * `saveAsset` the caller names the file. No history -- that is for notes.
   */
  async writeBinaryFile(relativePath: string, bytes: Uint8Array, vaultId?: string): Promise<number> {
    const resolvedVault = this.registrationFor(vaultId);
    const filePath = this.resolveInVault(relativePath, resolvedVault.id);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, bytes);
    const stat = await fsp.stat(filePath);
    this.ownWrites?.recordWrite(resolvedVault.id, relativePath, stat.mtimeMs);
    return stat.mtimeMs;
  }

  /**
   * Writes a binary asset (a pasted / dropped image) into an `attachments/`
   * folder beside the note that will reference it, and returns the path to
   * put in the `![](...)` -- relative to that note's own folder, so
   * `resolveVaultImageUrl` (renderer) resolves it straight back to a
   * `drey-asset://` URL.
   *
   * `noteRelPath` is the vault-relative path of the open document; when it
   * has no folder part (a bare name, or an unsaved scratch tab) the vault
   * root's `attachments/` is used. The file name is
   * `<timestamp>-<6 hex of sha256>.<ext>` (`shared/asset-name.ts`); a name
   * collision gets a `-2`, `-3`, ... suffix rather than overwriting.
   *
   * `preferredName` (ADR-0052) switches to name-preserving storage: the
   * base name is the sanitized source name instead of the timestamp+hash
   * form -- PDFs stay recognisable documents in the vault folder. The
   * collision suffixing works the same.
   */
  async saveAsset(
    bytes: Uint8Array,
    ext: string,
    noteRelPath: string,
    vaultId?: string,
    preferredName?: string,
  ): Promise<string> {
    const resolvedVault = this.registrationFor(vaultId);
    const baseName = preferredName
      ? sanitizedAssetFileName(preferredName, ext)
      : assetFileName({ date: new Date(), hashHex: crypto.createHash('sha256').update(bytes).digest('hex'), ext });

    const noteDir =
      noteRelPath.includes('/') ? noteRelPath.slice(0, noteRelPath.lastIndexOf('/')) : '';
    const dirRelToVault = noteDir ? `${noteDir}/${ATTACHMENTS_DIR}` : ATTACHMENTS_DIR;
    const absDir = this.resolveInVault(dirRelToVault, resolvedVault.id);
    await fsp.mkdir(absDir, { recursive: true });

    let name = baseName;
    const dot = baseName.lastIndexOf('.');
    for (let i = 2; fs.existsSync(path.join(absDir, name)); i++) {
      name = `${baseName.slice(0, dot)}-${i}${baseName.slice(dot)}`;
    }
    await fsp.writeFile(path.join(absDir, name), bytes);
    // Record the attachments folder: its own `addDir` echo (first paste
    // ever) and every file event under it both match it -- the file via
    // the ledger's directory-prefix rule.
    this.ownWrites?.recordStructural(resolvedVault.id, dirRelToVault);
    return `${ATTACHMENTS_DIR}/${name}`;
  }

  /**
   * Downloads a web image and stores it with {@link saveAsset} (ADR-0028).
   * `fetch` runs here in the main process (the renderer has no Node and
   * cross-origin hosts have no permissive CORS). Guarded: http(s) only,
   * redirects followed but the final URL's protocol re-checked, a 15 s
   * timeout, a 25 MB cap (Content-Length pre-check + the read length), and
   * an `image/*` content-type or a recognised image extension on the final
   * URL. Rejects with a short user-facing message.
   */
  async saveAssetFromUrl(url: string, noteRelPath: string, vaultId?: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('That is not a valid URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) image links can be downloaded.');
    }

    let response: Response;
    try {
      response = await fetch(parsed, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'image/*' },
      });
    } catch (error) {
      throw new Error(
        (error as Error)?.name === 'TimeoutError'
          ? 'Downloading the image timed out.'
          : `Could not download the image: ${(error as Error).message}`,
      );
    }

    const finalProtocol = new URL(response.url).protocol;
    if (finalProtocol !== 'http:' && finalProtocol !== 'https:') {
      throw new Error('The image link redirected somewhere unsafe.');
    }
    if (!response.ok) {
      throw new Error(`Could not download the image (HTTP ${response.status}).`);
    }

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      throw new Error('That image is too large (over 25 MB).');
    }

    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    // A server that explicitly says "not an image" is believed; only fall
    // back to the URL extension for a missing / generic type.
    if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
      throw new Error('That link is not an image.');
    }
    const ext = imageExtension(contentType) ?? imageExtension(new URL(response.url).pathname);
    if (!ext) {
      throw new Error('That link is not an image.');
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error('That image is too large (over 25 MB).');
    }

    return this.saveAsset(bytes, ext, noteRelPath, vaultId);
  }

  /**
   * Creates an empty file at `relativePath`, making any missing parent
   * folders on the way (e.g. the user creates `notes/ideas.md` under a
   * folder that only exists in the tree conceptually). The `wx` flag makes
   * the write itself fail if something raced in between the check and now,
   * so "already exists" is always reported rather than silently
   * overwriting a note.
   */
  async createFile(relativePath: string, vaultId?: string): Promise<string> {
    const resolvedVault = this.registrationFor(vaultId);
    const filePath = this.resolveInVault(relativePath, resolvedVault.id);
    if (fs.existsSync(filePath)) {
      throw new Error(`Already exists: ${relativePath}`);
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' });
    this.ownWrites?.recordStructural(resolvedVault.id, relativePath);
    return this.toRelative(filePath, resolvedVault.id);
  }

  /** Creates a directory at `relativePath`; rejects if anything is there. */
  async createDirectory(relativePath: string, vaultId?: string): Promise<string> {
    const resolvedVault = this.registrationFor(vaultId);
    const dirPath = this.resolveInVault(relativePath, resolvedVault.id);
    if (fs.existsSync(dirPath)) {
      throw new Error(`Already exists: ${relativePath}`);
    }
    await fsp.mkdir(dirPath, { recursive: true });
    this.ownWrites?.recordStructural(resolvedVault.id, relativePath);
    return this.toRelative(dirPath, resolvedVault.id);
  }

  /**
   * Removes the folder at `relativePath` when it is empty -- the tidy-up
   * after an attachment travelled with its note (milestone 59) and left
   * its `attachments/` folder behind with nothing in it. A non-empty or
   * missing folder, and the vault root, are left alone.
   */
  async removeDirIfEmpty(relativePath: string, vaultId?: string): Promise<void> {
    if (relativePath === '') {
      return;
    }
    const resolvedVault = this.registrationFor(vaultId);
    const dirPath = this.resolveInVault(relativePath, resolvedVault.id);
    try {
      if ((await fsp.readdir(dirPath)).length === 0) {
        this.ownWrites?.recordStructural(resolvedVault.id, relativePath);
        await fsp.rmdir(dirPath);
      }
    } catch {
      // Gone already, or not a folder -- nothing to tidy.
    }
  }

  /**
   * Deletes a file or folder -- by default to the OS recycle bin
   * (milestone 52), permanently for `{ trash: false }` (move-semantics
   * callers) and on volumes without a bin. `resolveInVault` is the path
   * guard; the vault root itself is refused. A `.md` note's assistant
   * sidecar (`.{name}.chat.json`) goes with it, mirroring the note's
   * disposition. `force` treats a missing target as success -- the tree
   * the renderer showed can be a step stale.
   */
  async deleteEntry(
    relativePath: string,
    vaultId?: string,
    opts?: { trash?: boolean },
  ): Promise<{ trashed: boolean }> {
    const resolvedVault = this.registrationFor(vaultId);
    const target = this.resolveInVault(relativePath, resolvedVault.id);
    if (target === path.resolve(resolvedVault.path)) {
      throw new Error('Refusing to delete the vault root.');
    }
    // Before the removal: the watcher's unlink echoes arrive right behind
    // it, and the record covers the children via the prefix rule.
    this.ownWrites?.recordStructural(resolvedVault.id, relativePath);
    const removal = await removeEntryFromDisk(target, opts, {
      trashItem: (p) => shell.trashItem(p),
      rm: (p) => fsp.rm(p, { recursive: true, force: true }),
    });
    if (relativePath.toLowerCase().endsWith('.md')) {
      const sidecar = this.resolveInVault(sidecarPathFor(relativePath), resolvedVault.id);
      // Best effort: a sidecar that will not move never blocks the note.
      await removeEntryFromDisk(
        sidecar,
        { trash: removal === 'trashed' },
        {
          trashItem: (p) => shell.trashItem(p),
          rm: (p) => fsp.rm(p, { force: true }).catch(() => undefined),
        },
      ).catch(() => undefined);
    }
    return { trashed: removal === 'trashed' };
  }

  /**
   * Renames / moves a file or folder. Both ends go through
   * `resolveInVault`; a vault root is refused, a missing source and an
   * occupied target both throw. Within one vault this is an `fsp.rename`;
   * ACROSS vaults (ADR-0051) it is a copy + delete, so it also works
   * between drives -- a `.md` note's assistant sidecar comes along, and a
   * failed copy cleans up after itself. Resolves to the new
   * vault-relative path inside the TARGET vault.
   */
  async renameEntry(fromRel: string, toRel: string, fromVaultId?: string, toVaultId?: string): Promise<string> {
    const fromVault = this.registrationFor(fromVaultId);
    const toVault = toVaultId ? this.registrationFor(toVaultId) : fromVault;
    const from = this.resolveInVault(fromRel, fromVault.id);
    const to = this.resolveInVault(toRel, toVault.id);
    if (from === path.resolve(fromVault.path)) {
      throw new Error('Refusing to rename the vault root.');
    }
    if (from === to) {
      return this.toRelative(to, toVault.id);
    }
    if (!fs.existsSync(from)) {
      throw new Error(`Not found: ${fromRel}`);
    }
    if (fs.existsSync(to)) {
      throw new Error(`Already exists: ${toRel}`);
    }

    if (fromVault.id === toVault.id) {
      // A folder must not land inside itself or its own subtree (the OS
      // rename would fail with something cryptic; copyEntry has the same
      // guard). Prefix + separator, so `a/b` -> `a/bc` stays legal.
      if (toRel.toLowerCase().startsWith(fromRel.toLowerCase() + '/')) {
        throw new Error('Cannot move a folder into itself.');
      }
      // Both ends: the source's unlink echo and the target's add echo.
      this.ownWrites?.recordStructural(fromVault.id, fromRel);
      this.ownWrites?.recordStructural(toVault.id, toRel);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      if (fromRel.toLowerCase().endsWith('.md') && toRel.toLowerCase().endsWith('.md')) {
        const sidecarFrom = this.resolveInVault(sidecarPathFor(fromRel), fromVault.id);
        const sidecarTo = this.resolveInVault(sidecarPathFor(toRel), toVault.id);
        if (fs.existsSync(sidecarFrom) && !fs.existsSync(sidecarTo)) {
          await fsp.rename(sidecarFrom, sidecarTo).catch(() => undefined);
        }
      }
      await this.history?.rename(fromVault.id, fromRel, toVault.id, toRel);
      return this.toRelative(to, toVault.id);
    }

    // Cross-vault move: copy + delete (EXDEV-safe). The ledger records the
    // structural op in BOTH vaults; the handlers announce an all-vaults
    // refresh afterwards so both sides' indexes rebuild.
    this.ownWrites?.recordStructural(fromVault.id, fromRel);
    this.ownWrites?.recordStructural(toVault.id, toRel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try {
      await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (error) {
      // Leave no partial copy behind.
      await fsp.rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await fsp.rm(from, { recursive: true, force: true });
    if (fromRel.toLowerCase().endsWith('.md') && toRel.toLowerCase().endsWith('.md')) {
      const sidecarFrom = this.resolveInVault(sidecarPathFor(fromRel), fromVault.id);
      const sidecarTo = this.resolveInVault(sidecarPathFor(toRel), toVault.id);
      if (fs.existsSync(sidecarFrom) && !fs.existsSync(sidecarTo)) {
        await fsp.cp(sidecarFrom, sidecarTo, { force: false }).catch(() => undefined);
        await fsp.rm(sidecarFrom, { force: true }).catch(() => undefined);
      }
    }
    await this.history?.rename(fromVault.id, fromRel, toVault.id, toRel);
    return this.toRelative(to, toVault.id);
  }

  /**
   * Copies a file or folder (recursively) into `destDirRel` (`''` = vault
   * root). The copy keeps the source's name, or gets a `" copy"` / `" copy
   * N"` suffix when that name is already taken in the destination. Copying
   * a folder into itself or its own subtree is refused. A `.md` note's
   * assistant sidecar is copied alongside it. Source and destination vault
   * may differ (a cross-vault copy, ADR-0051).
   */
  async copyEntry(srcRel: string, destDirRel: string, srcVaultId?: string, destVaultId?: string): Promise<string> {
    const srcVault = this.registrationFor(srcVaultId);
    const destVault = destVaultId ? this.registrationFor(destVaultId) : srcVault;
    const src = this.resolveInVault(srcRel, srcVault.id);
    if (!fs.existsSync(src)) {
      throw new Error(`Not found: ${srcRel}`);
    }
    const destDir = destDirRel
      ? this.resolveInVault(destDirRel, destVault.id)
      : this.resolveInVault('.', destVault.id);
    if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
      throw new Error(`Not a folder: ${destDirRel || '(vault root)'}`);
    }
    if (srcVault.id === destVault.id && (destDir === src || destDir.startsWith(src + path.sep))) {
      throw new Error('Cannot copy a folder into itself.');
    }

    const baseName = path.basename(src);
    const siblings = await fsp.readdir(destDir);
    const targetName = siblings.includes(baseName)
      ? uniqueCopyName(baseName, siblings)
      : baseName;
    const dest = path.join(destDir, targetName);

    await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });

    if (srcRel.toLowerCase().endsWith('.md')) {
      const sidecarSrc = this.resolveInVault(sidecarPathFor(srcRel), srcVault.id);
      if (fs.existsSync(sidecarSrc)) {
        const sidecarDest = path.join(destDir, sidecarPathFor(targetName));
        await fsp.cp(sidecarSrc, sidecarDest, { force: false }).catch(() => undefined);
      }
    }
    this.ownWrites?.recordStructural(destVault.id, this.toRelative(dest, destVault.id));
    return this.toRelative(dest, destVault.id);
  }

  /** Copies an entry next to itself, always with a `" copy"` suffix. */
  async duplicateEntry(srcRel: string, vaultId?: string): Promise<string> {
    const parent = srcRel.includes('/') ? srcRel.slice(0, srcRel.lastIndexOf('/')) : '';
    return this.copyEntry(srcRel, parent, vaultId, vaultId);
  }

  /**
   * Resolves a vault-relative asset path (e.g. an image referenced from a
   * note) to an absolute path, or `null` when the vault is unknown or the
   * path would escape it. Used by the `drey-asset://` protocol handler --
   * same guard as `resolveInVault`, but a bad path is "not found", not an
   * error to surface.
   */
  resolveAssetPath(relativePath: string, vaultId?: string): string | null {
    try {
      return this.resolveInVault(relativePath, vaultId);
    } catch {
      return null;
    }
  }

  /**
   * The registration for an explicit `vaultId`, or the active one when
   * omitted -- the single funnel every default-to-active operation goes
   * through, so daily notes, drafts and chats keep their active-vault
   * behavior by construction.
   */
  private registrationFor(vaultId?: string): VaultRegistration {
    if (vaultId !== undefined) {
      const known = this.registry.find((v) => v.id === vaultId);
      if (!known) {
        throw new Error(`Unknown vault: ${vaultId}`);
      }
      return known;
    }
    if (this.activeVaultId === null) {
      throw new Error('No vault is active.');
    }
    return this.registrationFor(this.activeVaultId);
  }

  /** Registration path by id; `''` for an unknown id (`revealVaultFolder` guard). */
  private pathOf(vaultId: string): string {
    return this.registry.find((v) => v.id === vaultId)?.path ?? '';
  }

  /** Root folder for an op; throws the historical errors for a missing folder. */
  private existingRootOf(vaultId?: string): string {
    const vault = this.registrationFor(vaultId);
    if (!fs.existsSync(vault.path)) {
      throw new Error(`Vault folder no longer exists: ${vault.path}`);
    }
    return vault.path;
  }

  /** Like `existingRootOf` but only demands a resolvable registration. */
  private rootOf(vaultId?: string): string {
    return this.registrationFor(vaultId).path;
  }

  /** Absolute path back to a forward-slash path relative to `vaultId`'s root. */
  private toRelative(absPath: string, vaultId: string): string {
    return path.relative(path.resolve(this.pathOf(vaultId)), absPath).split(path.sep).join('/');
  }

  /**
   * Turns a vault-relative path from the renderer into an absolute path
   * inside `vaultId`'s root (the active vault when omitted), and refuses
   * anything that would escape the root (`..`, absolute input,
   * symlink-free string check -- same defense-in-depth idea as the
   * `app://` protocol handler in app-protocols.ts). The renderer only ever sends
   * paths it got from `listFiles`, but read/write are a public IPC
   * surface, so the guard lives here rather than being assumed.
   */
  private resolveInVault(relativePath: string, vaultId?: string): string {
    const root = path.resolve(this.registrationFor(vaultId).path);
    const resolved = path.resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Path is outside the vault: ${relativePath}`);
    }
    return resolved;
  }
}

/**
 * Spawns one detached terminal candidate and resolves once it is clear
 * whether the process actually came up ('spawn') or failed ('error', e.g.
 * ENOENT for a not-installed terminal). The 'error' listener is what turns
 * a failed spawn into a `false` -- without it the event would surface as
 * an unhandled error in main and the caller would never learn.
 */
function launchTerminal(cmd: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd });
      child.once('error', () => resolve(false));
      child.once('spawn', () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** Same directory, slash-insensitive on win32 (the scan root compare). */
function samePath(a: string, b: string): boolean {
  const key = (p: string): string => {
    const resolved = path.resolve(p).replaceAll('\\', '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return key(a) === key(b);
}

async function collectMarkdown(dir: string, vaultRoot: string, out: string[]): Promise<void> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  // Root depth only (T-0044, ADR-0080): reserved `_`-folders (the
  // fleet's `_worktrees/` base) are machine state, not vault content —
  // `tickets/_meta` below the root stays indexed.
  const atRoot = samePath(dir, vaultRoot);
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.') || (atRoot && isReservedRootName(dirent.name))) {
      continue;
    }
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await collectMarkdown(fullPath, vaultRoot, out);
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
      out.push(path.relative(vaultRoot, fullPath).split(path.sep).join('/'));
    }
  }
}

async function readDirRecursive(dir: string, vaultRoot: string): Promise<VaultFileEntry[]> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries: VaultFileEntry[] = [];
  const atRoot = samePath(dir, vaultRoot);

  for (const dirent of dirents) {
    // Skips dotfiles/dotfolders (.git, .obsidian, ...). Nothing in the
    // Phase-1 spec needs those surfaced, and hiding them by default is
    // the conventional behavior for this kind of file tree. Reserved
    // `_`-folders at the root (T-0044) join them — machine state.
    if (dirent.name.startsWith('.') || (atRoot && isReservedRootName(dirent.name))) {
      continue;
    }

    const fullPath = path.join(dir, dirent.name);
    const relativePath = path.relative(vaultRoot, fullPath).split(path.sep).join('/');

    if (dirent.isDirectory()) {
      entries.push({
        name: dirent.name,
        relativePath,
        type: 'directory',
        children: await readDirRecursive(fullPath, vaultRoot),
      });
    } else if (dirent.isFile()) {
      entries.push({ name: dirent.name, relativePath, type: 'file' });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return entries;
}
