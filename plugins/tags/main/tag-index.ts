/**
 * The vault's tag index, plugin-side (ADR-0017, converted in ADR-0044
 * stage 5). Two things, both derived purely from inline `#tag`s in note
 * bodies:
 *
 *  - a **vocabulary** (`tag` + how many sections carry it) for `#tag`
 *    autocomplete and the search panel's tag picker;
 *  - the **tagged sections** themselves (`SectionRecord[]`), which the tag
 *    search filters and reports on.
 *
 * The literal `templates/` folder is always skipped, and so is the
 * user-configured templates folder when that differs; everything else,
 * `daily/` included, is scanned. Full rebuild on vault open / refresh /
 * vault-change events; a single file is re-indexed on `note:save` (a save
 * hook) and dropped on delete -- there is no file watcher.
 */
import { runTagSearch } from '../shared/search';
import { sectionRecordsFor } from '../shared/section-records';
import type { TagSearchHit, TagSearchQuery } from '../shared/search';

/** `{ tag, count }` for the vocabulary — the SDK's `TagEntry` shape. */
export interface TagEntry {
  tag: string;
  count: number;
}

/**
 * One heading-delimited section of a note that carries at least one tag.
 * Built by the shared `sectionRecordsFor` -- the same routine the renderer
 * runs over an open tab's unsaved buffer, so on-disk and in-buffer hits are
 * shaped identically.
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

export class TagIndex {
  /** Records grouped by file, so one save re-indexes just that file. */
  private byPath = new Map<string, SectionRecord[]>();

  /** Serialization for `requestRebuild` — always resolved, unlike the per-call promises. */
  private rebuildChain: Promise<void> = Promise.resolve();
  /** Set by every `requestRebuild`, consumed by the next sweep pass. */
  private rebuildRequested = false;

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

  /**
   * @param listMarkdownFiles flattens the vault tree to `.md` paths
   *   (vault-relative, forward-slash).
   * @param getTemplatesDir the configured templates folder (vault-relative,
   *   no slashes) -- its files are excluded too. Optional; the literal
   *   `templates/` is always excluded regardless.
   */
  constructor(
    private readonly listMarkdownFiles: () => Promise<readonly string[]>,
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

  /** Rescans the whole vault. Safe with no active vault (clears the index). */
  async rebuild(): Promise<void> {
    this.byPath.clear();
    let paths: readonly string[];
    try {
      paths = await this.listMarkdownFiles();
    } catch {
      return;
    }
    for (const path of paths) {
      if (this.isExcluded(path)) {
        continue;
      }
      try {
        const content = await this.readContent(path);
        this.byPath.set(path, recordsFor(path, content));
      } catch {
        // Unreadable -- skip; the next rebuild picks it up.
      }
    }
  }

  private readContent: (path: string) => Promise<string> = async () => '';

  /** The plugin entry wires its vault `read` here before the first rebuild. */
  setReadContent(read: (path: string) => Promise<string>): void {
    this.readContent = read;
  }

  /** Re-indexes one file after a save (or drops it if it now sits under an excluded folder). */
  reindexFile(path: string, content: string): void {
    if (this.isExcluded(path)) {
      this.byPath.delete(path);
      return;
    }
    this.byPath.set(path, recordsFor(path, content));
  }

  /** Drops a file's records after it is deleted. */
  removeFile(path: string): void {
    this.byPath.delete(path);
  }

  /** `{ tag, count }` for every known tag, most-used first, then alphabetical. */
  getVocabulary(): TagEntry[] {
    const counts = new Map<string, number>();
    for (const records of this.byPath.values()) {
      for (const record of records) {
        for (const tag of record.tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Every tagged section in the vault, for the search matcher. */
  getSections(): SectionRecord[] {
    return [...this.byPath.values()].flat();
  }

  /** Tag + free-text search over the tagged sections (`shared/search/runTagSearch`). */
  search(query: TagSearchQuery): TagSearchHit[] {
    return runTagSearch(this.getSections(), query);
  }
}

function recordsFor(path: string, content: string): SectionRecord[] {
  return sectionRecordsFor(path, content).map((record) => ({
    ...record,
    tags: [...record.tags],
  }));
}
