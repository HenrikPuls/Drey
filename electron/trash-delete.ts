/**
 * The disk end of a vault delete (milestone 52). An explicit user delete
 * moves to the OS recycle bin (`shell.trashItem` -- files and folders) so
 * it can be undone; `trash: false` (move-semantics callers, e.g. a
 * Save-as out of `.drafts/`) and the trash-less fallback (no recycle bin
 * on a network share / some removable drives) remove permanently.
 *
 * The IO is injected because `shell` only exists inside a running
 * Electron -- the branches stay unit-testable under plain Node.
 */

/** Disk operations `removeEntryFromDisk` needs, injected by the caller. */
export interface TrashIo {
  /** `shell.trashItem` -- moves one file or folder to the OS recycle bin. */
  trashItem(absPath: string): Promise<void>;
  /** `fsp.rm(path, { recursive: true, force: true })`. */
  rm(absPath: string): Promise<void>;
}

/** How a delete disposed of its target. */
export type DiskRemoval = 'trashed' | 'removed';

/**
 * Removes one absolute path from disk, recycle bin first unless
 * `opts.trash === false`. A failing `trashItem` falls back to the
 * permanent `rm` -- the delete the user asked for still stands -- and the
 * `'removed'` result is what lets the caller surface the difference.
 */
export async function removeEntryFromDisk(
  absPath: string,
  opts: { trash?: boolean } | undefined,
  io: TrashIo,
): Promise<DiskRemoval> {
  if (opts?.trash !== false) {
    try {
      await io.trashItem(absPath);
      return 'trashed';
    } catch {
      // No recycle bin on this volume -- fall through to the permanent rm.
    }
  }
  await io.rm(absPath);
  return 'removed';
}
