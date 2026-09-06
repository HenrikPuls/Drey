/**
 * Aggregates parsed frontmatter from every vault file into the tag
 * vocabulary (for `#tag` autocomplete) and the classifier tag registry
 * (`specs/classifier-spec.md`). Pure; `electron/tag-index.ts` feeds it the
 * scan results.
 */
import { Frontmatter, TagEntry, TagRegistryEntry } from './ipc-api';

/** One scanned vault file: its vault-relative path and parsed frontmatter (`null` if it has none). */
export interface ScannedFile {
  path: string;
  frontmatter: Frontmatter | null;
}

/**
 * Every tag seen in any file's `tags[]` gets a `TagEntry`. A tag whose
 * primary owner is a `type: master` file also carries that document's
 * `art` / `description` / `aliases` and `hasMaster: true`. The registry is
 * the subset of masters that have both `art` and `description` (what the
 * classifier prompt needs). Both lists are sorted by tag.
 */
export function collectTagEntries(files: readonly ScannedFile[]): {
  tags: TagEntry[];
  registry: TagRegistryEntry[];
} {
  const byTag = new Map<string, TagEntry>();
  const ensure = (tag: string): TagEntry => {
    let entry = byTag.get(tag);
    if (!entry) {
      entry = {
        tag,
        aliases: [],
        art: null,
        description: null,
        hasMaster: false,
        masterPath: null,
      };
      byTag.set(tag, entry);
    }
    return entry;
  };

  const registry: TagRegistryEntry[] = [];

  for (const { path, frontmatter } of files) {
    if (!frontmatter) {
      continue;
    }
    for (const raw of frontmatter.tags) {
      ensure(raw.toLowerCase());
    }

    const primary = frontmatter.tags[0]?.toLowerCase();
    if (frontmatter.type === 'master' && primary) {
      const entry = ensure(primary);
      entry.hasMaster = true;
      entry.masterPath = path;
      entry.art = frontmatter.art;
      entry.description = frontmatter.description;
      entry.aliases = dedupeLower(frontmatter.aliases);
      if (frontmatter.art && frontmatter.description) {
        registry.push({
          tag: primary,
          art: frontmatter.art,
          description: frontmatter.description,
          path,
        });
      }
    }
  }

  const tags = [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  registry.sort((a, b) => a.tag.localeCompare(b.tag));
  return { tags, registry };
}

/** Renders the registry as the prompt lines `- <tag> (<art>): <description>`. */
export function formatRegistry(registry: readonly TagRegistryEntry[]): string {
  return registry.map((entry) => `- ${entry.tag} (${entry.art}): ${entry.description}`).join('\n');
}

function dedupeLower(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
