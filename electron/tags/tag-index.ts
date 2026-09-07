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
 * `templates/` is skipped; everything else, `daily/` included, is scanned.
 * Full rebuild on vault open / manual refresh; a single file is re-indexed
 * on `note:save` and dropped on delete -- there is no file watcher.
 */
import { extractInlineTags, splitSections } from '../../shared/tags';
import { TagEntry } from '../../shared/ipc-api';
import { VaultManager } from '../vault-manager';

/** One heading-delimited section of a note that carries at least one tag. */
export interface SectionRecord {
  /** Vault-relative path of the note. */
  path: string;
  /** Section heading, or the file's base name for the pre-heading part. */
  heading: string;
  /** Heading level 1–6, or 0 for the pre-heading section. */
  level: number;
  /** 1-based line the section starts on. */
  line: number;
  /** Distinct tags in the section (heading + body), lower-cased. */
  tags: string[];
  /** The section text (heading excluded). */
  text: string;
}

const EXCLUDED_PREFIX = 'templates/';

export class TagIndex {
  /** Records grouped by file, so one save re-indexes just that file. */
  private byPath = new Map<string, SectionRecord[]>();

  constructor(private readonly vault: VaultManager) {}

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
      if (path.startsWith(EXCLUDED_PREFIX)) {
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

  /** Re-indexes one file after a save (or drops it if it moved under `templates/`). */
  reindexFile(path: string, content: string): void {
    if (path.startsWith(EXCLUDED_PREFIX)) {
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
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function recordsFor(path: string, content: string): SectionRecord[] {
  const out: SectionRecord[] = [];
  for (const section of splitSections(content)) {
    const tags = extractInlineTags(`${section.heading}\n${section.text}`);
    if (tags.length === 0) {
      continue;
    }
    out.push({
      path,
      heading: section.heading || baseName(path),
      level: section.level,
      line: section.line,
      tags,
      text: section.text,
    });
  }
  return out;
}
