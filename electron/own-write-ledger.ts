/**
 * Self-write echo suppression for the vault watcher (ADR-0045). Every
 * mutating `VaultManager` method records itself here; watcher events that
 * match a recorded write are the app's own echoes and get dropped instead
 * of triggering a redundant refresh round.
 *
 * Two record kinds, because the two are suppressable with different
 * confidence:
 * - **Content writes** (`writeFile`) record the file's post-write
 *   `mtimeMs`. A watcher `add`/`change` event is our own echo when its
 *   stat mtime matches the recorded one -- the same `fs.stat` source on
 *   both sides, so an exact match (±2 ms, for filesystems with coarse
 *   timestamp granularity) is reliable no matter how late the event
 *   arrives. The latest write per path is kept.
 * - **Structural ops** (create/delete/rename/copy, asset saves) record the
 *   path with a short TTL, matched exactly or as a directory prefix (so a
 *   recursive delete covers the child events). TTL-based because there is
 *   no stable fingerprint to match afterwards.
 *
 * A missed suppression is never corruption -- it costs one redundant
 * re-index round, so ambiguity always resolves towards "external event".
 * Deliberately free of Electron/chokidar imports so the ng test runner can
 * load it directly (same pattern as `electron/mcp/vault-tools.ts`).
 */
export class OwnWriteLedger {
  /** Watcher events for paths under a structural record count as echoes for this long. */
  private static readonly STRUCTURAL_TTL_MS = 3_000;
  /** Recorded content writes older than this are pruned; echoes arrive within seconds. */
  private static readonly WRITE_MAX_AGE_MS = 30_000;
  /** Tolerance when comparing watcher-event mtimes against recorded ones. */
  private static readonly MTIME_TOLERANCE_MS = 2;

  private readonly writes = new Map<string, { mtimeMs: number; atMs: number }>();
  private readonly structural = new Map<string, { atMs: number }>();

  /** Records a content write: `relPath` now carries `mtimeMs` on disk. */
  recordWrite(relPath: string, mtimeMs: number, atMs: number = Date.now()): void {
    this.writes.set(OwnWriteLedger.key(relPath), { mtimeMs, atMs });
  }

  /** Records a structural op (create/delete/rename/copy/asset) at `relPath`. */
  recordStructural(relPath: string, atMs: number = Date.now()): void {
    this.structural.set(OwnWriteLedger.key(relPath), { atMs });
  }

  /**
   * Whether a watcher event is one of the app's own echoes. `mtimeMs` is
   * the event's stat mtime (`undefined` when chokidar delivered none --
   * without a fingerprint there is nothing to match, so the event counts
   * as external).
   */
  isOwnEvent(
    relPath: string,
    eventKind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir',
    mtimeMs?: number,
    now: number = Date.now(),
  ): boolean {
    const key = OwnWriteLedger.key(relPath);

    const structuralHit = this.matchesStructural(key, now);
    if (eventKind === 'add' || eventKind === 'change') {
      if (structuralHit) {
        return true;
      }
      if (mtimeMs === undefined) {
        return false;
      }
      const write = this.writes.get(key);
      return (
        write !== undefined &&
        Math.abs(write.mtimeMs - mtimeMs) <= OwnWriteLedger.MTIME_TOLERANCE_MS
      );
    }
    return structuralHit;
  }

  /** Drops stale entries; called once per watcher round as hygiene. */
  prune(now: number = Date.now()): void {
    for (const [key, write] of this.writes) {
      if (now - write.atMs > OwnWriteLedger.WRITE_MAX_AGE_MS) {
        this.writes.delete(key);
      }
    }
    for (const [key, entry] of this.structural) {
      if (!this.structuralLive(entry, now)) {
        this.structural.delete(key);
      }
    }
  }

  private matchesStructural(key: string, now: number): boolean {
    const exact = this.structural.get(key);
    if (exact !== undefined && this.structuralLive(exact, now)) {
      return true;
    }
    // A folder op covers the child events chokidar delivers for everything
    // inside it (`notes/x.md` echoes `notes`).
    for (const [entryKey, entry] of this.structural) {
      if (key.startsWith(`${entryKey}/`) && this.structuralLive(entry, now)) {
        return true;
      }
    }
    return false;
  }

  private structuralLive(entry: { atMs: number }, now: number): boolean {
    return now - entry.atMs <= OwnWriteLedger.STRUCTURAL_TTL_MS;
  }

  /** Windows paths are case-insensitive; ledger keys are normalised lowercase. */
  private static key(relPath: string): string {
    return relPath.replace(/\\/g, '/').toLowerCase();
  }
}
