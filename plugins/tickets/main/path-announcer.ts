import * as path from 'node:path';

/**
 * D-3: tells Drey's vault layer about files the standalone engine wrote.
 *
 * The engine is a separate process; with the vault watcher off (the
 * default, ADR-0018/0045) nothing else would notice its moves and edits.
 * The engine reports the exact vault-relative paths on its event stream;
 * this batcher coalesces them and hands ONE `announceChanges` round per
 * burst to the vault layer -- the same external-change round the watcher
 * would run (index refresh, `vault:changed`, clean tabs reload, dirty tabs
 * are marked "Changed on disk"). It carries no ticket semantics: paths in,
 * paths out.
 *
 * - Debounced with a max wait: a fleet run writes constantly, so a burst
 *   is one round, and a never-ending stream still flushes.
 * - Last write wins per path: a file changed after it was deleted (or the
 *   reverse) counts once, as its final state.
 * - Over {@link MAX_PATHS} the round degrades to a full refresh of the
 *   vault (empty path lists) instead of a huge payload.
 * - A report names a folder: the hosted vault or a store's checkout (D-28).
 *   Every registered vault that holds that folder hears it, its paths
 *   relative to that vault.
 */

export interface PathsEvent {
  /** Absolute root of the vault the engine hosts, or of a store's checkout. */
  readonly vaultPath: string;
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

export interface DreyVaultRef {
  readonly id: string;
  readonly path: string;
  readonly exists: boolean;
}

export interface PathAnnouncerDeps {
  readonly listVaults: () => Promise<readonly DreyVaultRef[]>;
  readonly announce: (payload: { vaultId: string; changedPaths: string[]; deletedPaths?: string[] }) => void;
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly platform?: NodeJS.Platform;
}

export const DEFAULT_DEBOUNCE_MS = 400;
export const DEFAULT_MAX_WAIT_MS = 2_000;
export const MAX_PATHS = 400;

interface Pending {
  readonly vaultPath: string;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
  first: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PathAnnouncer {
  private readonly pending = new Map<string, Pending>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly platform: NodeJS.Platform;
  private disposed = false;

  constructor(private readonly deps: PathAnnouncerDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.platform = deps.platform ?? process.platform;
  }

  /** Queue one engine report. */
  add(event: PathsEvent): void {
    if (this.disposed || (event.changed.length === 0 && event.deleted.length === 0)) {
      return;
    }
    const key = this.key(event.vaultPath);
    let batch = this.pending.get(key);
    if (batch === undefined) {
      batch = { vaultPath: event.vaultPath, changed: new Set(), deleted: new Set(), first: Date.now(), timer: null };
      this.pending.set(key, batch);
    }
    for (const p of event.changed) {
      batch.deleted.delete(p);
      batch.changed.add(p);
    }
    for (const p of event.deleted) {
      batch.changed.delete(p);
      batch.deleted.add(p);
    }
    if (batch.timer !== null) {
      clearTimeout(batch.timer);
    }
    const wait = Math.max(0, Math.min(this.debounceMs, batch.first + this.maxWaitMs - Date.now()));
    batch.timer = setTimeout(() => void this.flush(key), wait);
  }

  /** Announce everything queued now (tests, deactivate). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((key) => this.flush(key)));
  }

  dispose(): void {
    this.disposed = true;
    for (const batch of this.pending.values()) {
      if (batch.timer !== null) {
        clearTimeout(batch.timer);
      }
    }
    this.pending.clear();
  }

  private key(vaultPath: string): string {
    const resolved = path.resolve(vaultPath);
    return this.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  /**
   * What a reported path needs in front to be relative to this vault: '' when the vault is
   * the reported folder, `sub/dir/` when the folder lies inside it (a store's checkout in a
   * larger vault, D-25/D-28); null when it lies outside.
   */
  private prefixInside(vaultPath: string, folder: string): string | null {
    const vault = this.key(vaultPath);
    const target = this.key(folder);
    if (target === vault) {
      return '';
    }
    const relative = path.relative(vault, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    // Measured on the folded paths, cut from the real one: the prefix keeps the folder's own case.
    const real = path.resolve(folder);
    return `${real.slice(real.length - relative.length).split(path.sep).join('/')}/`;
  }

  private async flush(key: string): Promise<void> {
    const batch = this.pending.get(key);
    if (batch === undefined) {
      return;
    }
    this.pending.delete(key);
    if (batch.timer !== null) {
      clearTimeout(batch.timer);
    }
    try {
      const vaults = await this.deps.listVaults();
      if (this.disposed) {
        return;
      }
      const total = batch.changed.size + batch.deleted.size;
      if (total === 0) {
        return;
      }
      for (const vault of vaults) {
        // Not a vault of Drey's, in no vault of Drey's: nothing to refresh.
        const prefix = vault.exists ? this.prefixInside(vault.path, batch.vaultPath) : null;
        if (prefix === null) {
          continue;
        }
        if (total > MAX_PATHS) {
          this.deps.announce({ vaultId: vault.id, changedPaths: [] });
          continue;
        }
        this.deps.announce({
          vaultId: vault.id,
          changedPaths: [...batch.changed].map((p) => `${prefix}${p}`),
          ...(batch.deleted.size > 0 ? { deletedPaths: [...batch.deleted].map((p) => `${prefix}${p}`) } : {}),
        });
      }
    } catch (error) {
      this.deps.log?.(`vault announce failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }
}
