import * as nodePath from 'node:path';
import { OwnWriteLedger } from './own-write-ledger';
import { ExternalVaultChanges, VaultChangeAnnouncer } from './vault-change-announcer';

/**
 * The slice of chokidar's `FSWatcher` the watcher actually uses. Keeping
 * the type structural (and the real `chokidar.watch` an injected factory)
 * means this file imports chokidar types only, so the ng/vitest runner can
 * load and test the class without the native watcher stack.
 */
export interface MinimalFsWatcher {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  close(): Promise<void>;
}

export type VaultWatchEventKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface VaultWatcherDeps {
  /** The active vault's absolute path, or `null` when none is active. */
  getRoot: () => string | null;
  /** The watched vault's id (ADR-0051) -- stamps every announced batch. */
  getVaultId: () => string | null;
  /** Whether the user turned watching on (Settings → Vault). */
  isEnabled: () => boolean;
  ledger: OwnWriteLedger;
  announcer: VaultChangeAnnouncer;
  /** Creates the real watcher; `main.ts` supplies `(root) => chokidar.watch(root, …)`. */
  watchFactory: (root: string) => MinimalFsWatcher;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Trailing debounce; a burst (OneDrive sync) collapses into one round. */
  debounceMs?: number;
}

/**
 * The opt-in vault file watcher (ADR-0045, req-14): watches the active
 * vault for *external* changes and turns them into one announcer round
 * per burst -- per-file index events for `.md` changes plus the
 * `vault:changed` renderer push (tree, panels, clean-tab reloads).
 *
 * Deliberately dumb about *what* changed beyond the path list: the index
 * events and the tree reload are the same machinery a manual refresh
 * uses, just scoped. The app's own writes are suppressed through the
 * {@link OwnWriteLedger}, so only genuinely external edits announce.
 *
 * Lifecycle follows the active vault and the Settings switch via
 * {@link syncFromConfig} (startup, `vault:select`, `config:set`);
 * a watcher `error` (e.g. the vault folder vanished) logs a warning and
 * stops watching -- the next lifecycle event re-arms it.
 */
export class VaultWatcher {
  private static readonly DEFAULT_DEBOUNCE_MS = 300;
  private static readonly MD_PATH = /\.md$/i;

  private watcher: MinimalFsWatcher | null = null;
  private watchedRoot: string | null = null;
  /** chokidar's initial scan also fires per-file events -- gate on `ready`. */
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingChanged = new Set<string>();
  private readonly pendingDeleted = new Set<string>();
  /** The vault the pending batch belongs to (captured per event, ADR-0051). */
  private pendingVaultId: string | null = null;
  /** Non-Markdown files / folder events: tree reload only, no index events. */
  private structuralDirty = false;

  constructor(private readonly deps: VaultWatcherDeps) {}

  /**
   * Starts / stops / restarts the watcher to match (enabled ∧ root). A
   * no-op when that effective root is unchanged -- every lifecycle event
   * can call this freely.
   */
  async syncFromConfig(): Promise<void> {
    const root = this.deps.isEnabled() ? this.deps.getRoot() : null;
    if (this.watchedRoot === root) {
      return;
    }
    await this.stop();
    if (root === null) {
      return;
    }

    this.watchedRoot = root;
    this.ready = false;
    const watcher = this.deps.watchFactory(root);
    this.watcher = watcher;

    watcher.on('ready', () => {
      this.ready = true;
    });
    for (const kind of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
      watcher.on(kind, (pathArg: unknown, statsArg: unknown) =>
        this.onEvent(watcher, kind, pathArg, statsArg),
      );
    }
    watcher.on('error', (error: unknown) => {
      // A vanished vault root surfaces here on Windows/OneDrive. Stop
      // watching; the next vault switch / settings save re-arms.
      this.deps.log(
        `Vault watcher stopped: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      void this.stop();
    });

    this.deps.log(`Watching for external changes: ${root}`);
  }

  /** Closes the watcher and drops any pending (undelivered) batch. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingChanged.clear();
    this.pendingDeleted.clear();
    this.pendingVaultId = null;
    this.structuralDirty = false;
    this.ready = false;
    const watcher = this.watcher;
    this.watcher = null;
    this.watchedRoot = null;
    if (watcher !== null) {
      try {
        await watcher.close();
      } catch {
        // Closing a half-dead watcher must not reject the lifecycle path.
      }
    }
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }

  /** Visible for tests: fires the debounced round immediately. */
  flushForTests(): void {
    this.flush();
  }

  private onEvent(
    source: MinimalFsWatcher,
    kind: VaultWatchEventKind,
    pathArg: unknown,
    statsArg: unknown,
  ): void {
    // Events from a watcher this instance already stopped (close is async),
    // or from the initial scan before `ready` -- not external changes.
    if (this.watcher !== source || !this.ready || typeof pathArg !== 'string') {
      return;
    }
    const root = this.watchedRoot;
    if (root === null) {
      return;
    }
    const relative = nodePath.relative(root, pathArg).split(nodePath.sep).join('/');
    // Empty (the root itself) or outside the root -- both ignored.
    if (relative === '' || relative.startsWith('..')) {
      return;
    }

    const mtimeMs =
      typeof statsArg === 'object' &&
      statsArg !== null &&
      typeof (statsArg as { mtimeMs?: unknown }).mtimeMs === 'number'
        ? (statsArg as { mtimeMs: number }).mtimeMs
        : undefined;
    // One watcher instance only ever sees one vault's tree, so resolving
    // the vault id per event is exact; a root switch drops the pending
    // batch (`stop`), so it can't leak across a change of vault.
    const vaultId = this.deps.getVaultId();
    if (vaultId === null || this.deps.ledger.isOwnEvent(vaultId, relative, kind, mtimeMs)) {
      return;
    }
    this.pendingVaultId = vaultId;

    if (kind === 'add' || kind === 'change') {
      this.pendingDeleted.delete(relative);
      if (VaultWatcher.MD_PATH.test(relative)) {
        this.pendingChanged.add(relative);
      } else {
        this.structuralDirty = true;
      }
    } else if (kind === 'unlink' && VaultWatcher.MD_PATH.test(relative)) {
      this.pendingChanged.delete(relative);
      this.pendingDeleted.add(relative);
    } else {
      // Folder events and non-Markdown files. A folder's `.md` children
      // were already delivered as their own `unlink` events first, so the
      // file lists stay exact; the folder itself only dirties the tree.
      this.structuralDirty = true;
    }

    this.armDebounce();
  }

  private armDebounce(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.deps.debounceMs ?? VaultWatcher.DEFAULT_DEBOUNCE_MS);
  }

  private flush(): void {
    if (
      this.pendingChanged.size === 0 &&
      this.pendingDeleted.size === 0 &&
      !this.structuralDirty
    ) {
      return;
    }

    this.deps.ledger.prune();
    const vaultId = this.pendingVaultId;
    const changedPaths = [...this.pendingChanged].sort();
    const deletedPaths = [...this.pendingDeleted].sort();
    this.pendingChanged.clear();
    this.pendingDeleted.clear();
    this.pendingVaultId = null;
    this.structuralDirty = false;
    if (vaultId === null) {
      return; // defensive: every event captures its vault before queueing
    }

    this.deps.log(
      `Vault changed externally: ${changedPaths.length} changed, ${deletedPaths.length} deleted`,
    );
    const changes: ExternalVaultChanges = { vaultId, changedPaths, deletedPaths };
    this.deps.announcer.announceExternal(changes);
  }
}
