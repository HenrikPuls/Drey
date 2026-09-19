/**
 * The task indexes, plugin-side (ADR-0033, converted in ADR-0044 stage 6,
 * per-vault since milestone 34 — the last piece of the M-B follow-up): one
 * {@link VaultTaskIndex} per registered vault, each a per-file cache of
 * every checkbox / `#task` line, derived purely by `shared/tasks`. Backs
 * the renderer panel's vault / all-vaults scopes (document scope is scanned
 * live from the open buffer).
 *
 * Same lifecycle and exclusion rules as the Tags plugin's index: the
 * literal `templates/` folder is always skipped, and so is the
 * user-configured templates folder when that differs; everything else,
 * `daily/` included, is scanned. Full rebuild per vault on vault open /
 * refresh, one file re-indexed on `note:save` (a save hook) and on a raw
 * vault write, dropped on delete — there is no file watcher (ADR-0018).
 */
import { scanTasks, TaskRecord } from '../shared/tasks';

const ALWAYS_EXCLUDED_PREFIX = 'templates/';

/** One vault's index: files → their task records, with its own sweep state. */
class VaultTaskIndex {
  /**
   * Records grouped by file, so one save re-indexes just that file. The
   * map a reader sees is ALWAYS complete: a rebuild sweep builds a fresh
   * map and swaps it in at the end — the old `byPath.clear()` + gradual
   * re-population handed every `list` pull made mid-sweep a torn
   * (partial/empty) snapshot, which the panel then rendered as a "reset"
   * until the next push.
   */
  private byPath = new Map<string, TaskRecord[]>();
  /** The sweep's build target while a rebuild is running (mutations go to both). */
  private sweep: Map<string, TaskRecord[]> | null = null;
  /** Files reindexed during the running sweep — their records beat the sweep's (older) read. */
  private sweepReindexed: Set<string> | null = null;

  /** Serialization for `requestRebuild` — always resolved, unlike the per-call promises. */
  private rebuildChain: Promise<void> = Promise.resolve();
  /** Set by every `requestRebuild`, consumed by the next sweep pass. */
  private rebuildRequested = false;

  constructor(
    private readonly vaultId: string,
    private readonly listFiles: (vaultId: string) => Promise<readonly string[]>,
    private readonly readContent: (vaultId: string, path: string) => Promise<string>,
    private readonly getTemplatesDir?: () => string,
  ) {}

  /** Path prefixes whose files are kept out of the index. */
  private excludedPrefixes(): string[] {
    const raw = (this.getTemplatesDir?.() ?? '').trim().replace(/^\/+|\/+$/g, '');
    const configured = raw === '' ? ALWAYS_EXCLUDED_PREFIX : `${raw}/`;
    return Array.from(new Set([ALWAYS_EXCLUDED_PREFIX, configured]));
  }

  private isExcluded(path: string): boolean {
    return this.excludedPrefixes().some((prefix) => path.startsWith(prefix));
  }

  /**
   * Requests a full rebuild, coalesced: bursts collapse into at most one
   * extra sweep per pass, never one sweep per request, and two sweeps
   * never interleave their `byPath.clear()` + per-file reads (watcher
   * bursts vs the boot refresh round). Resolves when a sweep has run that
   * covers this request.
   */
  requestRebuild(): Promise<void> {
    this.rebuildRequested = true;
    const run = this.rebuildChain.then(async () => {
      // Each pass honors everything requested so far; a request landing
      // mid-sweep re-arms the flag and gets its own pass.
      while (this.rebuildRequested) {
        this.rebuildRequested = false;
        await this.rebuild();
      }
    });
    this.rebuildChain = run.catch(() => undefined);
    return run;
  }

  /** Rescans the whole vault. Safe when the vault is unreadable (clears the index). */
  private async rebuild(): Promise<void> {
    let paths: readonly string[];
    try {
      paths = await this.listFiles(this.vaultId);
    } catch {
      return;
    }
    const next = new Map<string, TaskRecord[]>();
    const reindexed = new Set<string>();
    this.sweep = next;
    this.sweepReindexed = reindexed;
    try {
      for (const path of paths) {
        if (this.isExcluded(path)) {
          continue;
        }
        try {
          const content = await this.readContent(this.vaultId, path);
          // A reindexFile that landed while this read was in flight
          // carries the NEWER content — its record stays.
          if (!reindexed.has(path)) {
            next.set(path, scanTasks(path, content, this.vaultId));
          }
        } catch {
          // Unreadable -- skip; the next rebuild picks it up.
        }
      }
    } finally {
      this.sweep = null;
      this.sweepReindexed = null;
    }
    this.byPath = next;
  }

  /** Re-indexes one file after a save (or drops it if it now sits under an excluded folder). */
  reindexFile(path: string, content: string): void {
    if (this.isExcluded(path)) {
      this.removeFile(path);
      return;
    }
    const record = scanTasks(path, content, this.vaultId);
    // A landing save during a sweep must survive the swap — and must not
    // be overwritten by the sweep's older in-flight read of the file.
    if (this.sweep !== null) {
      this.sweep.set(path, record);
      this.sweepReindexed?.add(path);
    }
    this.byPath.set(path, record);
  }

  /** Drops a file's records after it is deleted. */
  removeFile(path: string): void {
    if (this.sweep !== null) {
      this.sweep.delete(path);
    }
    this.byPath.delete(path);
  }

  /** Every task line in the vault, file order then document order. */
  all(): TaskRecord[] {
    return [...this.byPath.values()].flat();
  }
}

export class TaskIndex {
  /** One index per registered vault, keyed by vault id (ADR-0051). */
  private byVault = new Map<string, VaultTaskIndex>();

  /**
   * @param listMarkdownFiles flattens one vault's tree to `.md` paths
   *   (vault-relative, forward-slash).
   * @param getTemplatesDir the configured templates folder (vault-relative,
   *   no slashes) -- its files are excluded too. Optional; the literal
   *   `templates/` is always excluded regardless.
   */
  constructor(
    private readonly listMarkdownFiles: (vaultId: string) => Promise<readonly string[]>,
    private readonly getTemplatesDir?: () => string,
  ) {}

  private readContent: (vaultId: string, path: string) => Promise<string> = async () => '';

  /** The plugin entry wires its vault `read` here before the first rebuild. */
  setReadContent(read: (vaultId: string, path: string) => Promise<string>): void {
    this.readContent = read;
  }

  /** The vault's index, created on first touch. */
  private vaultIndex(vaultId: string): VaultTaskIndex {
    let index = this.byVault.get(vaultId);
    if (index === undefined) {
      index = new VaultTaskIndex(
        vaultId,
        this.listMarkdownFiles,
        // Reads through the parent field, so a `setReadContent` that lands
        // after a vault index exists still takes effect.
        (id, path) => this.readContent(id, path),
        this.getTemplatesDir,
      );
      this.byVault.set(vaultId, index);
    }
    return index;
  }

  /** Full rebuild of one vault's index, coalesced per vault. */
  requestRebuild(vaultId: string): Promise<void> {
    return this.vaultIndex(vaultId).requestRebuild();
  }

  /** Full rebuild of every known vault's index (a registry-level round). */
  async requestRebuildAll(vaultIds: readonly string[]): Promise<void> {
    await Promise.all(vaultIds.map((id) => this.requestRebuild(id)));
  }

  /** Forgets a vault's index entirely (the vault was unregistered). */
  dropVault(vaultId: string): void {
    this.byVault.delete(vaultId);
  }

  /** Vault ids this index currently knows about (for dropping unregistered ones). */
  knownVaults(): string[] {
    return [...this.byVault.keys()];
  }

  /** Re-indexes one file after a save (or drops it if it now sits under an excluded folder). */
  reindexFile(vaultId: string, path: string, content: string): void {
    this.vaultIndex(vaultId).reindexFile(path, content);
  }

  /** Drops a file's records after it is deleted. */
  removeFile(vaultId: string, path: string): void {
    this.byVault.get(vaultId)?.removeFile(path);
  }

  /** Every task line in every known vault, each stamped with its `vaultId`. */
  all(): TaskRecord[] {
    const out: TaskRecord[] = [];
    for (const index of this.byVault.values()) {
      out.push(...index.all());
    }
    return out;
  }
}
