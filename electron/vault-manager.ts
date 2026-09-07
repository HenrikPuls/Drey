import { app, dialog } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sidecarPathFor } from '../shared/chat-thread';
import { VaultFileContent, VaultFileEntry } from '../shared/ipc-api';

interface VaultConfig {
  activeVaultPath: string | null;
}

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
