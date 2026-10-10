/**
 * The per-vault outlink index (milestone 54): every `.md` file's parsed
 * `[[wikilink]]` occurrences, kept fresh through the save-hook and
 * vault-change registries (the tag-index shape: a coalesced sweep per
 * rebuild, an incremental re-index per save/write, a drop per delete).
 * Resolution to backlink rows happens at QUERY time against a note index
 * built from the current file list — a rename or new file reshapes
 * resolution without re-reading every note's links.
 */
import { extractLinkTargets } from '../shared/link-targets';
import type { LinkOccurrence } from '../shared/link-targets';
import { buildNoteIndex, collectBacklinks } from '../shared/link-index';
import type { BacklinkRow, NoteIndex } from '../shared/link-index';

/** One vault's outlinks: the file list plus each file's occurrences. */
class VaultLinks {
  private paths: string[] = [];
  private links = new Map<string, LinkOccurrence[]>();

  /** Serialization for rebuilds — bursts collapse into one sweep (tag-index shape). */
  private rebuildChain: Promise<void> = Promise.resolve();
  private rebuildRequested = false;

  constructor(
    private readonly vaultId: string,
    private readonly listFiles: (vaultId: string) => Promise<readonly string[]>,
    private readonly readContent: (vaultId: string, path: string) => Promise<string>,
  ) {}

  /** Requests a full sweep, coalesced; resolves when a sweep covering it has run. */
  requestRebuild(): Promise<void> {
    this.rebuildRequested = true;
    const run = this.rebuildChain.then(async () => {
      while (this.rebuildRequested) {
        this.rebuildRequested = false;
        await this.rebuild();
      }
    });
    this.rebuildChain = run.catch(() => undefined);
    return run;
  }

  private async rebuild(): Promise<void> {
    let paths: readonly string[];
    try {
      paths = await this.listFiles(this.vaultId);
    } catch {
      return;
    }
    const nextLinks = new Map<string, LinkOccurrence[]>();
    for (const path of paths) {
      try {
        nextLinks.set(path, extractLinkTargets(await this.readContent(this.vaultId, path)));
      } catch {
        // Unreadable — skip; the next rebuild picks it up.
      }
    }
    this.paths = [...paths];
    this.links = nextLinks;
  }

  /** Re-indexes one file after a save; a first sighting joins the file list. */
  reindexFile(path: string, content: string): void {
    this.links.set(path, extractLinkTargets(content));
    if (!this.paths.includes(path)) {
      this.paths = [...this.paths, path];
    }
  }

  /** Drops a file after it is deleted. */
  removeFile(path: string): void {
    this.links.delete(path);
    this.paths = this.paths.filter((p) => p !== path);
  }

  /** The backlink rows for one note, resolved against the current file list. */
  backlinksFor(path: string): BacklinkRow[] {
    const index: NoteIndex = buildNoteIndex(this.paths);
    if (!index.all.includes(path)) {
      return [];
    }
    return collectBacklinks(path, this.links, index);
  }
}

export class BacklinkIndex {
  /** One index per registered vault, keyed by vault id (ADR-0051). */
  private byVault = new Map<string, VaultLinks>();

  constructor(
    private readonly listMarkdownFiles: (vaultId: string) => Promise<readonly string[]>,
    private readonly readContent: (vaultId: string, path: string) => Promise<string>,
  ) {}

  private vaultIndex(vaultId: string): VaultLinks {
    let index = this.byVault.get(vaultId);
    if (index === undefined) {
      index = new VaultLinks(vaultId, this.listMarkdownFiles, this.readContent);
      this.byVault.set(vaultId, index);
    }
    return index;
  }

  /** Full rebuild of one vault's index, coalesced per vault. */
  requestRebuild(vaultId: string): Promise<void> {
    return this.vaultIndex(vaultId).requestRebuild();
  }

  /** Re-indexes one file after a save. */
  reindexFile(vaultId: string, path: string, content: string): void {
    this.vaultIndex(vaultId).reindexFile(path, content);
  }

  /** Drops a file's links after it is deleted. */
  removeFile(vaultId: string, path: string): void {
    this.byVault.get(vaultId)?.removeFile(path);
  }

  /** Forgets a vault's index entirely (the vault was unregistered). */
  dropVault(vaultId: string): void {
    this.byVault.delete(vaultId);
  }

  /** Vault ids this index currently knows about. */
  knownVaults(): string[] {
    return [...this.byVault.keys()];
  }

  /** The backlink rows for one note in one vault (empty when unknown). */
  backlinksFor(vaultId: string, path: string): BacklinkRow[] {
    return this.byVault.get(vaultId)?.backlinksFor(path) ?? [];
  }
}
