/**
 * Crash-safe file IO for everything the app must not lose: notes in a
 * vault and the JSON files under the user-data dir.
 *
 * - **Atomic replace** (`atomicWriteFile` / `atomicWriteFileSync`): the new
 *   content goes to a temp file beside the target, is flushed, and is then
 *   renamed over it. A crash, a power cut or a sync client reading mid-write
 *   sees either the old file or the new one, never a truncated one. The
 *   temp name starts with a dot, so the file tree, the indexes and the
 *   vault watcher (which all skip dot-entries) never see it.
 * - **Guarded JSON read** (`readJsonObjectGuarded`): a config file that
 *   exists but cannot be used is moved aside instead of being silently
 *   replaced by defaults on the next write.
 *
 * Deliberately free of Electron imports so it runs under the plain-Node
 * spec runner.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Waits between rename attempts. On Windows a virus scanner or a sync
 * client holding the target open for a moment fails the rename with one of
 * the codes below; it is gone a few milliseconds later.
 */
const RENAME_RETRY_DELAYS_MS = [10, 40, 120];
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function tempPathFor(target: string): string {
  const suffix = crypto.randomBytes(4).toString('hex');
  return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !TRANSIENT_RENAME_CODES.has(errorCode(err) ?? '')) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Replaces (or creates) `filePath` with `data` atomically. Strings are
 * written as UTF-8.
 *
 * Falls back to a plain in-place write wherever the atomic path cannot
 * apply or fails -- a read-only target (so the error the user saw before
 * still surfaces), a target another program keeps locked, a name too long
 * for the temp file. A save therefore never fails where a plain write
 * would have succeeded.
 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  // A linked note is written through; the link is not replaced by a file.
  const target = await fsp.realpath(filePath).catch(() => filePath);
  const existing = await fsp.stat(target).catch(() => null);
  if (existing !== null && (!existing.isFile() || (existing.mode & 0o200) === 0)) {
    await fsp.writeFile(target, data);
    return;
  }
  const tmp = tempPathFor(target);
  try {
    const handle = await fsp.open(tmp, 'wx', existing === null ? undefined : existing.mode & 0o777);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, target);
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    await fsp.writeFile(target, data);
  }
}

/** The synchronous form, for the small config files written during a call. */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = tempPathFor(filePath);
  try {
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, data, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // A leftover temp file is harmless; the write below still decides.
    }
    fs.writeFileSync(filePath, data, 'utf-8');
  }
}

/** A stored file that existed but could not be used. */
export interface UnreadableFile {
  /** The file that could not be read. */
  filePath: string;
  /** Where its content was kept, or `null` when it could not be kept. */
  backupPath: string | null;
  reason: string;
}

export type GuardedJsonObject =
  | { kind: 'missing' }
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'unreadable'; problem: UnreadableFile };

function backupStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Moves an unusable file to `<name>.corrupt-<timestamp>` so the next start
 * finds no file (plain defaults, no second report) and the content stays
 * recoverable by hand. A file that cannot be moved is copied instead.
 */
function setAside(filePath: string, now: Date): string | null {
  const backupPath = `${filePath}.corrupt-${backupStamp(now)}`;
  try {
    fs.renameSync(filePath, backupPath);
    return backupPath;
  } catch {
    try {
      fs.copyFileSync(filePath, backupPath);
      return backupPath;
    } catch {
      return null;
    }
  }
}

/**
 * Copies a file to `<name>.<tag>-<timestamp>` and leaves the original in
 * place -- for a file that is still usable but about to lose something on
 * its next write. Returns the copy's path, `null` when it could not be made.
 */
export function keepCopy(filePath: string, tag: string, now: Date = new Date()): string | null {
  const copyPath = `${filePath}.${tag}-${backupStamp(now)}`;
  try {
    fs.copyFileSync(filePath, copyPath);
    return copyPath;
  } catch {
    return null;
  }
}

/**
 * Reads a JSON file that must hold an object. A missing file is the normal
 * first run; anything else that is not a usable object -- unreadable,
 * empty, cut off, not JSON, an array -- is set aside and reported, so the
 * caller can start from defaults without destroying what was there.
 */
export function readJsonObjectGuarded(filePath: string, now: Date = new Date()): GuardedJsonObject {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return { kind: 'missing' };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'unreadable', problem: { filePath, backupPath: setAside(filePath, now), reason } };
  }
  let reason: string;
  try {
    // A hand-edited file may carry a byte-order mark, which JSON.parse rejects.
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ''));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'ok', value: parsed as Record<string, unknown> };
    }
    reason = 'the file does not hold a JSON object';
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  return { kind: 'unreadable', problem: { filePath, backupPath: setAside(filePath, now), reason } };
}
