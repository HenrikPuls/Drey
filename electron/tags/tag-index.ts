/**
 * The vault's tag index (replaces the old frontmatter-scanning
 * `electron/tag-index.ts`). Two things, both derived purely from inline
 * `#tag`s in note bodies:
 *
 *  - a **vocabulary** (`tag` + how many sections carry it) for `#tag`
 *    autocomplete and the search panel's tag picker;
 *  - the **tagged sections** themselves (`SectionRecord[]`), which the tag
 *    search filters and reports on.
 *
 * The literal `templates/` folder is always skipped, and so is the
 * user-configured templates folder when that differs; everything else,
 * `daily/` included, is scanned. Full rebuild on vault open / manual
 * refresh; a single file is re-indexed on `note:save` and dropped on
 * delete -- there is no file watcher.
 */
import { runTagSearch, sectionRecordsFor } from '../../shared/tags';
import { TagEntry, TagSearchHit, TagSearchQuery } from '../../shared/ipc-api';
import { VaultManager } from '../vault-manager';

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

  /**
   * @param getTemplatesDir the configured templates folder (vault-relative,
   *   no slashes) -- its files are excluded too. Optional so existing
   *   call-sites / tests keep working; the literal `templates/` is always
   *   excluded regardless.
   */
  constructor(
    private readonly vault: VaultManager,
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
    let paths: string[];
    try {
      paths = await this.vault.listMarkdownFiles();
    } catch {
      return;
    }
    for (const path of paths) {
      if (this.isExcluded(path)) {
        continue;
      }
      try {
        const { content } = await this.vault.readFile(path);
        this.byPath.set(path, recordsFor(path, content));
      } catch {
        // Unreadable -- skip; the next rebuild picks it up.
      }
    }
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

  /** Tag + free-text search over the tagged sections (`shared/tags/runTagSearch`). */
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
