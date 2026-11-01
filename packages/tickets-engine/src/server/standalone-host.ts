import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { EngineHost, EngineVault } from '../services/host';
import type { ChangeHub } from './drey-port';

/**
 * The standalone host (ADR-0088, E2b): one tickets vault on disk, no Drey.
 * Reads/writes go through plain fs with the same vault-relative path
 * discipline (containment checked on every resolve); announcements and the
 * board-changed signal feed the gateway's SSE hub, so a paired phone and
 * the Drey plugin (when it adopts this engine) see live updates either
 * way. Dialog affordances a headless process cannot offer (pickFolder)
 * refuse honestly; reveal/launch shell out to the OS.
 */
export class FsEngineHost implements EngineHost {
  private readonly vault: EngineVault;

  constructor(
    /** The tickets vault's absolute root (the folder containing `tickets/`). */
    vaultPath: string,
    private readonly config: { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void> },
    /** The gateway's fan-out — board/fleet/remote events reach SSE here. */
    private readonly hub: ChangeHub,
    private readonly logSink: (message: string, level?: 'info' | 'warn' | 'error') => void,
    readonly userRoot: string,
  ) {
    this.vault = {
      id: 'standalone',
      name: path.basename(vaultPath),
      path: vaultPath,
      exists: true,
      active: true,
    };
  }

  private resolve(rel: string): string | null {
    const abs = path.resolve(this.vault.path, rel);
    const root = path.resolve(this.vault.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return null;
    }
    return abs;
  }

  async listVaults(): Promise<readonly EngineVault[]> {
    const exists = await fsp.stat(this.vault.path).then((s) => s.isDirectory()).catch(() => false);
    return [{ ...this.vault, exists }];
  }

  read = async (_vaultId: string, rel: string): Promise<string> => {
    const abs = this.resolve(rel);
    if (abs === null) {
      throw new Error('path escapes the vault');
    }
    return fsp.readFile(abs, 'utf8');
  };

  write = async (_vaultId: string, rel: string, text: string): Promise<void> => {
    const abs = this.resolve(rel);
    if (abs === null) {
      throw new Error('path escapes the vault');
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  };

  writeAnnounced = async (vaultId: string, rel: string, text: string): Promise<void> => {
    await this.write(vaultId, rel, text);
    this.announceChanges(vaultId, [rel]);
  };

  async listMarkdownFiles(_vaultId: string): Promise<readonly string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === '.git') {
            continue;
          }
          await walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          out.push(rel);
        }
      }
    };
    await walk(this.vault.path, '');
    return out;
  }

  resolveAssetPath = (_vaultId: string, rel: string): string | null => this.resolve(rel);

  announceChanges = (_vaultId: string, changedPaths: readonly string[], deletedPaths?: readonly string[]): void => {
    void changedPaths;
    void deletedPaths;
    this.hub.emit('board');
  };

  markManaged = (_vaultId: string | null): void => {
    // no registry to flag outside Drey — the discipline is the engine's own
  };

  configGet = <T>(key: string): Promise<T | undefined> => this.config.get<T>(key);

  configSet = async (key: string, value: unknown): Promise<void> => {
    await this.config.set(key, value);
  };

  emitBoardChanged = (): void => {
    this.hub.emit('board');
  };

  log = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
    this.logSink(message, level);
  };

  pickFolder = async (_title: string): Promise<string | null> => null;

  revealPath = async (absPath: string): Promise<string> => {
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(opener, [absPath], { detached: true, stdio: 'ignore' }).unref();
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  launchInConsole = (cwd: string, command: string): void => {
    // Best-effort twin of the plugin's runInNewConsole for a headless start.
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', command], { cwd, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(command, { cwd, detached: true, stdio: 'ignore', shell: true }).unref();
    }
  };
}
