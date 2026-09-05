import { app, dialog } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { VaultFileEntry } from '../shared/ipc-api';

interface VaultConfig {
  activeVaultPath: string | null;
}

const configFilePath = (): string => path.join(app.getPath('userData'), 'vault-config.json');

function readConfig(): VaultConfig {
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VaultConfig>;
    return { activeVaultPath: typeof parsed.activeVaultPath === 'string' ? parsed.activeVaultPath : null };
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

  async listFiles(): Promise<VaultFileEntry[]> {
    if (!this.activeVaultPath) {
      throw new Error('No vault is active.');
    }
    if (!fs.existsSync(this.activeVaultPath)) {
      throw new Error(`Vault folder no longer exists: ${this.activeVaultPath}`);
    }
    return readDirRecursive(this.activeVaultPath, this.activeVaultPath);
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
