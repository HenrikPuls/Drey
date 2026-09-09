/**
 * The vault's task index -- a per-file cache of every checkbox / `#task`
 * line, derived purely by `shared/tasks/scanTasks`. Backs the `tasks:list`
 * IPC channel that feeds the renderer's Tasks panel in "whole vault" scope
 * (document scope is scanned live from the open buffer).
 *
 * Same lifecycle and exclusion rules as `TagIndex` (`electron/tags/`):
 * `templates/` and the user-configured templates folder are skipped,
 * `daily/` is included; full rebuild on vault open / manual refresh, one
 * file re-indexed on `note:save`, dropped on delete. There is no file
 * watcher (ADR-0018), so an external edit is picked up on the next rebuild.
 */
import { scanTasks, TaskRecord } from '../../shared/tasks';
import { VaultManager } from '../vault-manager';

const ALWAYS_EXCLUDED_PREFIX = 'templates/';

export class TaskIndex {
  /** Records grouped by file, so one save re-indexes just that file. */
  private byPath = new Map<string, TaskRecord[]>();

  /**
   * @param getTemplatesDir the configured templates folder (vault-relative,
   *   no slashes) -- its files are excluded too, on top of the always-excluded
   *   literal `templates/`.
   */
  constructor(
    private readonly vault: VaultManager,
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
        this.byPath.set(path, scanTasks(path, content));
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
