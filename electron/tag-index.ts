/**
 * In-memory registry of every tag in the active vault and the
 * master-document metadata behind it (CLAUDE.md, "Relevant Components":
 * `TagIndex`). One source for two consumers: `#tag` autocomplete in the
 * editor (`tag:list`) and the classifier registry (`tag:registry`,
 * milestone 7).
 *
 * All parsing/aggregation is the pure `shared/` code; this class only
 * walks the vault and holds the result. Rebuilt on vault select and after
 * a `note:save` that changed tags -- there is no file watcher yet, so an
 * external edit is only reflected on the next full rebuild.
 */
import { TagEntry, TagRegistryEntry } from '../shared/ipc-api';
import { readFrontmatter } from '../shared/frontmatter';
import { collectTagEntries, ScannedFile } from '../shared/tag-registry';
import { VaultManager } from './vault-manager';

/** Structural folders are not topics -- excluded from the registry (specs/roadmap.md, docs/11). */
const EXCLUDED_PREFIXES = ['daily/', 'templates/'];

export class TagIndex {
  private tags: TagEntry[] = [];
  private registry: TagRegistryEntry[] = [];
  private byName = new Map<string, TagEntry>();

  constructor(private readonly vault: VaultManager) {}

  /** Rescans the whole vault. Safe to call with no active vault (clears the index). */
  async rebuild(): Promise<void> {
    let paths: string[];
    try {
      paths = await this.vault.listMarkdownFiles();
    } catch {
      this.set([], []);
      return;
    }

    const scanned: ScannedFile[] = [];
    for (const path of paths) {
      if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        continue;
      }
      try {
        const { content } = await this.vault.readFile(path);
        scanned.push({ path, frontmatter: readFrontmatter(content) });
      } catch {
        // Unreadable file -- skip it; the next rebuild picks it up.
      }
    }

    const { tags, registry } = collectTagEntries(scanned);
    this.set(tags, registry);
  }

  getTags(): TagEntry[] {
    return this.tags;
  }

  getRegistry(): TagRegistryEntry[] {
    return this.registry;
  }

  /** Resolves a tag or one of its aliases to its entry, if the vault knows it. */
  lookup(tag: string): TagEntry | undefined {
    return this.byName.get(tag.toLowerCase());
  }

  private set(tags: TagEntry[], registry: TagRegistryEntry[]): void {
    this.tags = tags;
    this.registry = registry;
    this.byName = new Map(
      tags.flatMap((entry) => [
        [entry.tag, entry] as const,
        ...entry.aliases.map((alias) => [alias.toLowerCase(), entry] as const),
      ]),
    );
  }
}
