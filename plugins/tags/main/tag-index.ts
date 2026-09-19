/**
 * The tag indexes, plugin-side (ADR-0017, converted in ADR-0044 stage 5,
 * per-vault since milestone 33). One {@link VaultIndex} per registered
 * vault, each deriving two things purely from the note bodies it scans:
 *
 *  - a **vocabulary** (`tag` + how many sections carry it) for `#tag`
 *    autocomplete and the search panel's tag picker;
 *  - the **sections** themselves (`SectionRecord[]`) — every
 *    heading-delimited section, tagged or not, so free-text search covers
 *    untagged notes too (milestone 33; tag-only queries still require the
 *    tags, so untagged sections only surface for text queries).
 *
 * The literal `templates/` folder is always skipped, and so is the
 * user-configured templates folder when that differs; everything else,
 * `daily/` included, is scanned. Full rebuild per vault on vault open /
 * refresh / vault-change events; a single file is re-indexed on `note:save`
 * (a save hook) and dropped on delete.
 */
import { runTagSearch } from '../shared/search';
import { sectionRecordsFor } from '../shared/section-records';
import type { TagSearchHit, TagSearchQuery } from '../shared/search';
import type { SectionSearchScope, TagEntry } from '../../../shared/plugin-api';

/** `{ tag, count }` for the vocabulary — the SDK's `TagEntry` shape. */
export type { TagEntry };

/**
 * One heading-delimited section of a note (milestone 33: whether or not it
 * carries a tag). Built by the shared `sectionRecordsFor` -- the same
 * routine the renderer runs over an open tab's unsaved buffer, so on-disk
 * and in-buffer hits are shaped identically.
 */
export interface SectionRecord {
  /** Vault-relative path of the note. */
  path: string;
  /** Section heading, or the file's base name for the pre-heading part. */
  heading: string;
  /** 1-based line the section starts on. */
  line: number;
  /** Distinct tags in the section (heading + body), lower-cased. */
  tags: string[];
  /** The section text (heading excluded). */
  text: string;
}

const ALWAYS_EXCLUDED_PREFIX = 'templates/';

/** One vault's index: files → their section records, with its own sweep state. */
class VaultIndex {
  /**
   * Records grouped by file, so one save re-indexes just that file. The
   * map a reader sees is ALWAYS complete: a rebuild sweep builds a fresh
   * map and swaps it in at the end — a `clear()` + gradual re-population
   * would hand every `vocabulary`/`search` pull made mid-sweep a torn
   * (partial/empty) snapshot.
   */
  private byPath = new Map<string, SectionRecord[]>();
  /** The sweep's build target while a rebuild is running (mutations go to both). */
  private sweep: Map<string, SectionRecord[]> | null = null;
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
    const next = new Map<string, SectionRecord[]>();
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
            next.set(path, recordsFor(path, content));
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
    const record = recordsFor(path, content);
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

  allRecords(): SectionRecord[] {
    return [...this.byPath.values()].flat();
  }

  getVocabulary(counts: Map<string, number>): void {
    for (const records of this.byPath.values()) {
      for (const record of records) {
        for (const tag of record.tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }
  }
}

export class TagIndex {
  /** One index per registered vault, keyed by vault id (ADR-0051). */
  private byVault = new Map<string, VaultIndex>();

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
  private vaultIndex(vaultId: string): VaultIndex {
    let index = this.byVault.get(vaultId);
    if (index === undefined) {
      index = new VaultIndex(
        vaultId,
        this.listMarkdownFiles,
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

  /** `{ tag, count }` for every known tag across ALL vaults, most-used first, then alphabetical. */
  getVocabulary(): TagEntry[] {
    const counts = new Map<string, number>();
    for (const index of this.byVault.values()) {
      index.getVocabulary(counts);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * Tag + free-text search (`shared/search/runTagSearch`), scoped:
   * omitted scope = the active vault (the pre-multi-vault behavior),
   * `{ kind: 'vault' }` = exactly that vault, `{ kind: 'all' }` = every
   * registered vault with hits stamped `vaultId` so a cross-vault click
   * opens the right file.
   */
  search(
    query: TagSearchQuery,
    scope: SectionSearchScope | undefined,
    activeVaultId: string | null,
  ): TagSearchHit[] {
    const ids = this.scopeVaultIds(scope, activeVaultId);
    const hits: TagSearchHit[] = [];
    for (const vaultId of ids) {
      for (const hit of runTagSearch(this.byVault.get(vaultId)?.allRecords() ?? [], query)) {
        hits.push({ ...hit, vaultId });
      }
    }
    return hits;
  }

  private scopeVaultIds(scope: SectionSearchScope | undefined, activeVaultId: string | null): string[] {
    if (scope === undefined) {
      return activeVaultId !== null && this.byVault.has(activeVaultId) ? [activeVaultId] : [];
    }
    if (scope.kind === 'vault') {
      return this.byVault.has(scope.vaultId) ? [scope.vaultId] : [];
    }
    return [...this.byVault.keys()];
  }
}

function recordsFor(path: string, content: string): SectionRecord[] {
  return sectionRecordsFor(path, content).map((record) => ({
    ...record,
    tags: [...record.tags],
  }));
}
