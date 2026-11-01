import type { RunInfo } from '../fleet/protocol';
import type { ChainConfig, RunRequest } from '../fleet/protocol';

/**
 * The engine's host ports (ADR-0088, E2a). The service layer is pure
 * domain plus IO injected here: the Drey plugin supplies a host over its
 * plugin context, the standalone engine process (E2b) supplies one over
 * plain fs against a single tickets vault. Every Drey- or
 * Electron-only affordance a service needs lands in this interface —
 * never an `electron` import in `packages/`.
 */

/** A registered vault the engine can work against (the plugin's vault shape, host-neutral). */
export interface EngineVault {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** Registered and the folder still there (the detector skips the rest). */
  readonly exists: boolean;
  /** The user's active vault in the host's registry. */
  readonly active: boolean;
}

/** The vault-change round the host forwards to {@link EngineBoardService.onVaultEvent} (structural twin of the plugin SDK's event). */
export interface EngineVaultChangeEvent {
  readonly vaultId?: string;
  readonly kind: 'refresh' | 'write' | 'delete' | 'rename';
}

export interface EngineHost {
  /** Every registered vault (exists or not — the detector filters). */
  listVaults(): Promise<readonly EngineVault[]>;
  read(vaultId: string, path: string): Promise<string>;
  /** Announced on write: the change round the save would have triggered. */
  writeAnnounced(vaultId: string, path: string, text: string): Promise<void>;
  write(vaultId: string, path: string, text: string): Promise<void>;
  listMarkdownFiles(vaultId: string): Promise<readonly string[]>;
  /** Absolute path for a vault-relative path, null when it escapes the vault (sync — pure path resolution). */
  resolveAssetPath(vaultId: string, path: string): string | null;
  /** One external-change round for exactly these paths (plus the board-changed signal, debounced, via emitBoardChanged). */
  announceChanges(vaultId: string, changedPaths: readonly string[], deletedPaths?: readonly string[]): void;
  /** The plugin-managed flag (ADR-0082): detection sets it both ways. */
  markManaged(vaultId: string | null): void;
  configGet<T>(key: string): Promise<T | undefined>;
  configSet(key: string, value: unknown): Promise<void>;
  /** The renderer's `board-changed` push — the host debounces and emits. */
  emitBoardChanged(): void;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
  /** The machine-local root (run history, the legacy worktree base). */
  readonly userRoot: string;

  /** A native folder picker; null when cancelled (Drey: the Electron dialog). */
  pickFolder(title: string): Promise<string | null>;
  /** Open a path in the OS shell; resolves '' on success, the failure text otherwise. */
  revealPath(absPath: string): Promise<string>;
  /** Run a command in a new console that outlives the app (Launch this version). */
  launchInConsole(cwd: string, command: string): void;
}

/** The fleet-runner control the service layer needs (the plugin's FleetClient fits it). */
export interface FleetPort {
  runs(): Promise<readonly RunInfo[]>;
  start(request: RunRequest): Promise<{ ok: true; run: RunInfo } | { ok: false; error: string }>;
  configureChain(config: ChainConfig): Promise<void>;
}
