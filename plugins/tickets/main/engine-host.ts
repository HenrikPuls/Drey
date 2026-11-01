import { BrowserWindow, dialog, shell } from 'electron';
import type {
  EngineHost,
  EngineVault,
  FleetPort,
} from '../../../packages/tickets-engine/src/services/host';
import { runInNewConsole } from './open-terminal';
import type { FleetClient } from './fleet-client';

/**
 * The Drey host behind the engine's service layer (ADR-0088, E2a): every
 * EngineHost port over the plugin context. The standalone engine process
 * (E2b) implements the same interface over plain fs and its own config —
 * that is the whole point of the seam.
 */
export class DreyEngineHost implements EngineHost {
  constructor(
    private readonly ctx: {
      vault: {
        listVaults(): Promise<readonly EngineVault[]>;
        read(path: string, opts: { vaultId: string }): Promise<string>;
        write(path: string, text: string, opts: { vaultId: string }): Promise<unknown>;
        writeAnnounced(path: string, text: string, opts: { vaultId: string }): Promise<unknown>;
        listMarkdownFiles(opts: { vaultId: string }): Promise<readonly string[]>;
        resolveAssetPath(path: string, opts: { vaultId: string }): string | null;
        announceChanges(payload: {
          vaultId: string;
          changedPaths: readonly string[];
          deletedPaths?: readonly string[];
        }): void;
        markManaged(vaultId: string | null): void;
      };
      config: {
        get<T>(key: string): Promise<T | undefined>;
        set(key: string, value: unknown): Promise<unknown>;
      };
      ipc: { emit(event: string, payload?: unknown): void };
      log(message: string, level?: 'info' | 'warn' | 'error'): void;
      app: { userRoot: string };
    },
  ) {}

  listVaults = (): Promise<readonly EngineVault[]> => this.ctx.vault.listVaults();

  read = (vaultId: string, path: string): Promise<string> => this.ctx.vault.read(path, { vaultId });

  write = async (vaultId: string, path: string, text: string): Promise<void> => {
    await this.ctx.vault.write(path, text, { vaultId });
  };

  writeAnnounced = async (vaultId: string, path: string, text: string): Promise<void> => {
    await this.ctx.vault.writeAnnounced(path, text, { vaultId });
  };

  listMarkdownFiles = (vaultId: string): Promise<readonly string[]> => this.ctx.vault.listMarkdownFiles({ vaultId });

  resolveAssetPath = (vaultId: string, path: string): string | null => this.ctx.vault.resolveAssetPath(path, { vaultId });

  announceChanges = (vaultId: string, changedPaths: readonly string[], deletedPaths?: readonly string[]): void => {
    this.ctx.vault.announceChanges({
      vaultId,
      changedPaths: [...changedPaths],
      ...(deletedPaths !== undefined && deletedPaths.length > 0 ? { deletedPaths: [...deletedPaths] } : {}),
    });
  };

  markManaged = (vaultId: string | null): void => this.ctx.vault.markManaged(vaultId);

  configGet = <T>(key: string): Promise<T | undefined> => this.ctx.config.get<T>(key);

  configSet = async (key: string, value: unknown): Promise<void> => {
    await this.ctx.config.set(key, value);
  };

  emitBoardChanged = (): void => {
    this.ctx.ipc.emit('board-changed');
  };

  log = (message: string, level?: 'info' | 'warn' | 'error'): void => this.ctx.log(message, level);

  get userRoot(): string {
    return this.ctx.app.userRoot;
  }

  pickFolder = async (title: string): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow();
    const options = { title, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const outcome = win !== null ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return outcome.canceled ? null : (outcome.filePaths[0] ?? null);
  };

  revealPath = (absPath: string): Promise<string> => shell.openPath(absPath);

  launchInConsole = (cwd: string, command: string): void => runInNewConsole(cwd, command);
}

/** The plugin's FleetClient behind the engine's FleetPort. */
export class FleetClientPort implements FleetPort {
  constructor(private readonly fleet: FleetClient) {}

  runs = () => this.fleet.runs();

  start = (request: Parameters<FleetClient['start']>[0]) => this.fleet.start(request);

  configureChain = (config: Parameters<FleetClient['configureChain']>[0]) => this.fleet.configureChain(config);
}
