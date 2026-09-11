/**
 * The vault's task index, plugin-side (ADR-0033, converted in ADR-0044
 * stage 6): a per-file cache of every checkbox / `#task` line, derived
 * purely by `shared/tasks`. Backs the renderer panel's "whole vault" scope
 * (document scope is scanned live from the open buffer).
 *
 * Same lifecycle and exclusion rules as the Tags plugin's index: the
 * literal `templates/` folder is always skipped, and so is the
 * user-configured templates folder when that differs; everything else,
 * `daily/` included, is scanned. Full rebuild on vault open / refresh, one
 * file re-indexed on `note:save` (a save hook) and on a raw vault write,
 * dropped on delete -- there is no file watcher (ADR-0018).
 */
import { scanTasks, TaskRecord } from '../shared/tasks';

const ALWAYS_EXCLUDED_PREFIX = 'templates/';

export class TaskIndex {
  /** Records grouped by file, so one save re-indexes just that file. */
  private byPath = new Map<string, TaskRecord[]>();

  /**
   * @param listMarkdownFiles flattens the vault tree to `.md` paths
   *   (vault-relative, forward-slash).
   * @param getTemplatesDir the configured templates folder (vault-relative,
   *   no slashes) -- its files are excluded too. Optional; the literal
   *   `templates/` is always excluded regardless.
   */
  constructor(
    private readonly listMarkdownFiles: () => Promise<string[]>,
    private readonly getTemplatesDir?: () => string,
  ) {}

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
        this.byPath.set(path, scanTasks(path, content));
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
    this.byPath.set(path, scanTasks(path, content));
  }

  /** Drops a file's records after it is deleted. */
  removeFile(path: string): void {
    this.byPath.delete(path);
  }

  /** Every task line in the vault, file order then document order. */
  all(): TaskRecord[] {
    return [...this.byPath.values()].flat();
  }
}
