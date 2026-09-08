import { app, dialog } from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { assetFileName, ATTACHMENTS_DIR, imageExtension } from '../shared/asset-name';
import { sidecarPathFor } from '../shared/chat-thread';
import { VaultFileContent, VaultFileEntry } from '../shared/ipc-api';
import { uniqueCopyName } from '../shared/unique-name';

interface VaultConfig {
  activeVaultPath: string | null;
}

/** Cap for a downloaded web image (`saveAssetFromUrl`). */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const configFilePath = (): string => path.join(app.getPath('userData'), 'vault-config.json');

function readConfig(): VaultConfig {
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VaultConfig>;
    return {
      activeVaultPath: typeof parsed.activeVaultPath === 'string' ? parsed.activeVaultPath : null,
    };
  } catch {
    // First run (no config file yet) or a corrupt/unreadable one -- either
    // way, "no vault selected" is the correct fallback, not a crash.
    return { activeVaultPath: null };
  }
}

function writeConfig(config: VaultConfig): void {
  const filePath = configFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Vault registration, active vault, and path resolution (see CLAUDE.md,
 * "Relevant Components"). A vault is just a folder on disk -- this class
 * only remembers which one is active (in a small per-user config file,
 * not the vault itself -- the vault stays plain files, no database) and
 * reads its contents. No note/frontmatter parsing here; that starts with
 * the editor (milestone 3) and tag routing (milestone 5).
 */
export class VaultManager {
  private activeVaultPath: string | null;

  constructor() {
    const configured = readConfig().activeVaultPath;
    // Don't trust a stale config blindly: the folder may have been moved,
    // renamed, or (if it lives on OneDrive/an external drive, see
    // specs/roadmap.md) just not mounted yet at this exact moment. Treat
    // it as inactive for this session rather than erroring, but leave the
    // config file itself untouched -- if the path reappears (e.g. a drive
    // gets mounted after launch), the next restart picks it up again.
    this.activeVaultPath = configured && fs.existsSync(configured) ? configured : null;
  }

  getActiveVaultPath(): string | null {
    return this.activeVaultPath;
  }

  async selectVault(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: 'Select vault folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return this.activeVaultPath;
    }

    this.activeVaultPath = result.filePaths[0];
    writeConfig({ activeVaultPath: this.activeVaultPath });
    return this.activeVaultPath;
  }

  /**
   * Native "Save note" dialog rooted at the vault. Returns the chosen
   * location as a forward-slash vault-relative path (with a `.md`
   * extension forced), or `null` on cancel. Refuses a location outside the
   * active vault -- the whole app is vault-relative, a note saved elsewhere
   * could never be reopened from the file tree or indexed.
   */
  async pickSavePath(suggestedName: string): Promise<string | null> {
    if (!this.activeVaultPath) {
      throw new Error('No vault is active.');
    }
    const root = path.resolve(this.activeVaultPath);
    const name = suggestedName.trim() || 'untitled.md';
    const result = await dialog.showSaveDialog({
      title: 'Save note',
      defaultPath: path.join(root, name),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    let chosen = path.resolve(result.filePath);
    if (!chosen.toLowerCase().endsWith('.md')) {
      chosen += '.md';
    }
    if (chosen !== root && !chosen.startsWith(root + path.sep)) {
      throw new Error('The file must be saved inside the current vault.');
    }
    return path.relative(root, chosen).split(path.sep).join('/');
  }

  async listFiles(): Promise<VaultFileEntry[]> {
    if (!this.activeVaultPath) {
      throw new Error('No vault is active.');
    }
    if (!fs.existsSync(this.activeVaultPath)) {
      throw new Error(`Vault folder no longer exists: ${this.activeVaultPath}`);
    }
    return readDirRecursive(this.activeVaultPath, this.activeVaultPath);
  }

  /**
   * Flat list of every `.md` file in the vault, vault-relative and
   * forward-slash separated. Feeds the tag index scan (milestone 6);
   * dotfolders are skipped, same as `listFiles`.
   */
  async listMarkdownFiles(): Promise<string[]> {
    if (!this.activeVaultPath) {
      throw new Error('No vault is active.');
    }
    if (!fs.existsSync(this.activeVaultPath)) {
      throw new Error(`Vault folder no longer exists: ${this.activeVaultPath}`);
    }
    const out: string[] = [];
    await collectMarkdown(this.activeVaultPath, this.activeVaultPath, out);
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  async readFile(relativePath: string): Promise<VaultFileContent> {
    const filePath = this.resolveInVault(relativePath);
    const [content, stat] = await Promise.all([
      fsp.readFile(filePath, 'utf-8'),
      fsp.stat(filePath),
    ]);
    return { content, modifiedMs: stat.mtimeMs };
  }

  async writeFile(relativePath: string, content: string): Promise<number> {
    const filePath = this.resolveInVault(relativePath);
    // Create intermediate folders (e.g. `daily/` on the first save of a
    // calendar-created draft note) -- `fsp.writeFile` won't on its own.
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content, 'utf-8');
    const stat = await fsp.stat(filePath);
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
   */
  async saveAsset(bytes: Uint8Array, ext: string, noteRelPath: string): Promise<string> {
    const hashHex = crypto.createHash('sha256').update(bytes).digest('hex');
    const baseName = assetFileName({ date: new Date(), hashHex, ext });

    const noteDir =
      noteRelPath.includes('/') ? noteRelPath.slice(0, noteRelPath.lastIndexOf('/')) : '';
    const dirRelToVault = noteDir ? `${noteDir}/${ATTACHMENTS_DIR}` : ATTACHMENTS_DIR;
    const absDir = this.resolveInVault(dirRelToVault);
    await fsp.mkdir(absDir, { recursive: true });

    let name = baseName;
    const dot = baseName.lastIndexOf('.');
    for (let i = 2; fs.existsSync(path.join(absDir, name)); i++) {
      name = `${baseName.slice(0, dot)}-${i}${baseName.slice(dot)}`;
    }
    await fsp.writeFile(path.join(absDir, name), bytes);
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
  async saveAssetFromUrl(url: string, noteRelPath: string): Promise<string> {
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
    return this.saveAsset(bytes, ext, noteRelPath);
  }

  /**
   * Creates an empty file at `relativePath`, making any missing parent
   * folders on the way (e.g. the user creates `notes/ideas.md` under a
   * folder that only exists in the tree conceptually). The `wx` flag makes
   * the write itself fail if something raced in between the check and now,
   * so "already exists" is always reported rather than silently
   * overwriting a note.
   */
  async createFile(relativePath: string): Promise<string> {
    const filePath = this.resolveInVault(relativePath);
    if (fs.existsSync(filePath)) {
      throw new Error(`Already exists: ${relativePath}`);
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' });
    return this.toRelative(filePath);
  }

  /** Creates a directory at `relativePath`; rejects if anything is there. */
  async createDirectory(relativePath: string): Promise<string> {
    const dirPath = this.resolveInVault(relativePath);
    if (fs.existsSync(dirPath)) {
      throw new Error(`Already exists: ${relativePath}`);
    }
    await fsp.mkdir(dirPath, { recursive: true });
    return this.toRelative(dirPath);
  }

  /**
   * Deletes a file or folder (recursively). `resolveInVault` is the path
   * guard; the vault root itself is refused. A `.md` note's assistant
   * sidecar (`.{name}.chat.json`) goes with it. `fsp.rm` with `force`
   * treats a missing target as success -- the tree the renderer showed can
   * be a step stale.
   */
  async deleteEntry(relativePath: string): Promise<void> {
    const target = this.resolveInVault(relativePath);
    if (!this.activeVaultPath || target === path.resolve(this.activeVaultPath)) {
      throw new Error('Refusing to delete the vault root.');
    }
    await fsp.rm(target, { recursive: true, force: true });
    if (relativePath.toLowerCase().endsWith('.md')) {
      const sidecar = this.resolveInVault(sidecarPathFor(relativePath));
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Renames / moves a file or folder from one vault-relative path to
   * another. Both ends go through `resolveInVault`; the vault root is
   * refused, a missing source and an occupied target both throw. A `.md`
   * note's assistant sidecar (`.{name}.chat.json`) moves with it.
   */
  async renameEntry(fromRel: string, toRel: string): Promise<string> {
    const from = this.resolveInVault(fromRel);
    const to = this.resolveInVault(toRel);
    if (!this.activeVaultPath || from === path.resolve(this.activeVaultPath)) {
      throw new Error('Refusing to rename the vault root.');
    }
    if (from === to) {
      return this.toRelative(to);
    }
    if (!fs.existsSync(from)) {
      throw new Error(`Not found: ${fromRel}`);
    }
    if (fs.existsSync(to)) {
      throw new Error(`Already exists: ${toRel}`);
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    if (fromRel.toLowerCase().endsWith('.md') && toRel.toLowerCase().endsWith('.md')) {
      const sidecarFrom = this.resolveInVault(sidecarPathFor(fromRel));
      const sidecarTo = this.resolveInVault(sidecarPathFor(toRel));
      if (fs.existsSync(sidecarFrom) && !fs.existsSync(sidecarTo)) {
        await fsp.rename(sidecarFrom, sidecarTo).catch(() => undefined);
      }
    }
    return this.toRelative(to);
  }

  /**
   * Copies a file or folder (recursively) into `destDirRel` (`''` = vault
   * root). The copy keeps the source's name, or gets a `" copy"` / `" copy
   * N"` suffix when that name is already taken in the destination. Copying
   * a folder into itself or its own subtree is refused. A `.md` note's
   * assistant sidecar is copied alongside it.
   */
  async copyEntry(srcRel: string, destDirRel: string): Promise<string> {
    const src = this.resolveInVault(srcRel);
    if (!fs.existsSync(src)) {
      throw new Error(`Not found: ${srcRel}`);
    }
    const destDir = destDirRel ? this.resolveInVault(destDirRel) : this.resolveInVault('.');
    if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
      throw new Error(`Not a folder: ${destDirRel || '(vault root)'}`);
    }
    if (destDir === src || destDir.startsWith(src + path.sep)) {
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
      const sidecarSrc = this.resolveInVault(sidecarPathFor(srcRel));
      if (fs.existsSync(sidecarSrc)) {
        const sidecarDest = path.join(destDir, sidecarPathFor(targetName));
        await fsp.cp(sidecarSrc, sidecarDest, { force: false }).catch(() => undefined);
      }
    }
    return this.toRelative(dest);
  }

  /** Copies an entry next to itself, always with a `" copy"` suffix. */
  async duplicateEntry(srcRel: string): Promise<string> {
    const parent = srcRel.includes('/') ? srcRel.slice(0, srcRel.lastIndexOf('/')) : '';
    return this.copyEntry(srcRel, parent);
  }

  /**
   * Resolves a vault-relative asset path (e.g. an image referenced from a
   * note) to an absolute path, or `null` when there is no active vault or
   * the path would escape it. Used by the `drey-asset://` protocol handler
   * -- same guard as `resolveInVault`, but a bad path is "not found", not an
   * error to surface.
   */
  resolveAssetPath(relativePath: string): string | null {
    try {
      return this.resolveInVault(relativePath);
    } catch {
      return null;
    }
  }

  /** Absolute path back to a forward-slash path relative to the vault root. */
  private toRelative(absPath: string): string {
    if (!this.activeVaultPath) {
      throw new Error('No vault is active.');
    }
    return path.relative(path.resolve(this.activeVaultPath), absPath).split(path.sep).join('/');
  }

  /**
   * Turns a vault-relative path from the renderer into an absolute path,
   * and refuses anything that would escape the vault root (`..`,
   * absolute input, symlink-free string check -- same defense-in-depth
   * idea as the `app://` protocol handler in main.ts). The renderer only
   * ever sends paths it got from `listFiles`, but read/write are a public
   * IPC surface, so the guard lives here rather than being assumed.
   */
  private resolveInVault(relativePath: string): string {
    if (!this.activeVaultPath) {
      throw new Error('No vault is active.');
    }
    const root = path.resolve(this.activeVaultPath);
    const resolved = path.resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Path is outside the active vault: ${relativePath}`);
    }
    return resolved;
  }
}

async function collectMarkdown(dir: string, vaultRoot: string, out: string[]): Promise<void> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) {
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

  for (const dirent of dirents) {
    // Skips dotfiles/dotfolders (.git, .obsidian, ...). Nothing in the
    // Phase-1 spec needs those surfaced, and hiding them by default is
    // the conventional behavior for this kind of file tree.
    if (dirent.name.startsWith('.')) {
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
