import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { NoteHistoryEntry } from '../../shared/ipc-api';
import { isAutoSavePath } from '../../shared/structural-folders';
import { NOTE_FILE } from '../../shared/wikilinks';

/** `vault.history` as the store reads it at every call (config is live). */
export interface NoteHistoryLimits {
  enabled: boolean;
  keepDays: number;
  maxPerFile: number;
}

export interface CaptureOptions {
  /**
   * The user's own saves: at most one version per {@link THROTTLE_MS}, so a
   * Ctrl+S habit does not fill the history. Every other writer (assistant,
   * MCP, replace, link update, conflict) is recorded each time.
   */
  throttled?: boolean;
}

/** One version per file per window for throttled captures. */
export const THROTTLE_MS = 5 * 60 * 1000;
/** A note larger than this is not versioned. */
const MAX_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

type VaultIndex = Record<string, string>;

/**
 * Local note history (milestone 60, ADR-0060): earlier versions of a note,
 * kept OUTSIDE the vault under `<root>/<vaultId>/` so nothing syncs and the
 * vault stays plain files.
 *
 *   <root>/<vaultId>/index.json          vault-relative path -> folder id
 *   <root>/<vaultId>/<id>/entries.json   the versions, oldest first
 *   <root>/<vaultId>/<id>/<entry>.md     one version's text
 *
 * Folder ids are random rather than a mirror of the note's path: a deep
 * note under `<userData>` would run into the Windows path limit, and a
 * rename is then one index edit instead of a folder move.
 *
 * Every public method runs on one queue (the index is read-modify-write)
 * and none of them throws into its caller's write path -- the history is a
 * safety net, never a reason for a save to fail.
 */
export class NoteHistoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly limits: () => NoteHistoryLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records `content` as a version of `relPath`. Resolves to whether a
   * version was written: not for a non-note / auto-saved path, an
   * oversized or unchanged text, a throttled capture inside the window, or
   * with the history switched off.
   */
  capture(
    vaultId: string,
    relPath: string,
    content: string,
    origin: string,
    options: CaptureOptions = {},
  ): Promise<boolean> {
    return this.run(async () => {
      const limits = this.limits();
      if (
        !limits.enabled ||
        !NOTE_FILE.test(relPath) ||
        isAutoSavePath(relPath) ||
        Buffer.byteLength(content, 'utf-8') > MAX_BYTES
      ) {
        return false;
      }
      const index = await this.readIndex(vaultId);
      let key = findKey(index, relPath);
      if (key === null) {
        key = relPath;
        index[key] = crypto.randomBytes(8).toString('hex');
        await this.writeIndex(vaultId, index);
      }
      const dir = this.dirOf(vaultId, index[key]);
      const entries = await this.readEntries(dir);
      const newest = entries[entries.length - 1];
      const at = this.now();
      if (newest !== undefined) {
        if (options.throttled === true && at - newest.at < THROTTLE_MS) {
          return false;
        }
        const previous = await fsp.readFile(path.join(dir, `${newest.id}.md`), 'utf-8').catch(() => null);
        if (previous === content) {
          return false;
        }
      }
      const entry: NoteHistoryEntry = {
        id: `${at.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
        at,
        origin,
        bytes: Buffer.byteLength(content, 'utf-8'),
      };
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${entry.id}.md`), content, 'utf-8');
      await this.writeEntries(dir, await this.prune(dir, [...entries, entry], limits));
      return true;
    }, false);
  }

  /** The versions of `relPath`, newest first. */
  list(vaultId: string, relPath: string): Promise<NoteHistoryEntry[]> {
    return this.run(async () => {
      const index = await this.readIndex(vaultId);
      const key = findKey(index, relPath);
      if (key === null) {
        return [];
      }
      return (await this.readEntries(this.dirOf(vaultId, index[key]))).reverse();
    }, []);
  }

  /** One version's text, or `null` when it is gone. */
  read(vaultId: string, relPath: string, entryId: string): Promise<string | null> {
    return this.run(async () => {
      if (!/^[a-z0-9-]+$/.test(entryId)) {
        return null;
      }
      const index = await this.readIndex(vaultId);
      const key = findKey(index, relPath);
      if (key === null) {
        return null;
      }
      return fsp.readFile(path.join(this.dirOf(vaultId, index[key]), `${entryId}.md`), 'utf-8').catch(() => null);
    }, null);
  }

  /**
   * Follows a rename / move: `fromRel` itself and everything under it (a
   * folder) keeps its history under the new path. Across vaults the
   * version folders move to the target vault's store.
   */
  rename(fromVaultId: string, fromRel: string, toVaultId: string, toRel: string): Promise<void> {
    return this.run(async () => {
      const source = await this.readIndex(fromVaultId);
      const sameVault = fromVaultId === toVaultId;
      const target = sameVault ? source : await this.readIndex(toVaultId);
      const from = fromRel.toLowerCase();
      let changed = false;
      for (const key of Object.keys(source)) {
        const lower = key.toLowerCase();
        if (lower !== from && !lower.startsWith(`${from}/`)) {
          continue;
        }
        const id = source[key];
        const next = toRel + key.slice(fromRel.length);
        delete source[key];
        changed = true;
        const occupied = findKey(target, next);
        if (occupied !== null) {
          // The target path already had a history (an earlier file of that
          // name): the moved note's one replaces it.
          await fsp.rm(this.dirOf(toVaultId, target[occupied]), { recursive: true, force: true });
          delete target[occupied];
        }
        if (!sameVault) {
          await fsp.mkdir(path.join(this.root, toVaultId), { recursive: true });
          await fsp.rename(this.dirOf(fromVaultId, id), this.dirOf(toVaultId, id)).catch(() => undefined);
        }
        target[next] = id;
      }
      if (!changed) {
        return;
      }
      await this.writeIndex(fromVaultId, source);
      if (!sameVault) {
        await this.writeIndex(toVaultId, target);
      }
    }, undefined);
  }

  /** Drops expired versions everywhere -- run once at startup. */
  sweep(): Promise<void> {
    return this.run(async () => {
      const limits = this.limits();
      const vaults = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
      for (const vault of vaults) {
        if (!vault.isDirectory()) {
          continue;
        }
        const index = await this.readIndex(vault.name);
        let changed = false;
        for (const key of Object.keys(index)) {
          const dir = this.dirOf(vault.name, index[key]);
          const entries = await this.readEntries(dir);
          const kept = await this.prune(dir, entries, limits);
          if (kept.length === 0) {
            await fsp.rm(dir, { recursive: true, force: true });
            delete index[key];
            changed = true;
          } else if (kept.length !== entries.length) {
            await this.writeEntries(dir, kept);
          }
        }
        if (changed) {
          await this.writeIndex(vault.name, index);
        }
      }
    }, undefined);
  }

  /** Removes what the limits no longer allow; returns the survivors. */
  private async prune(
    dir: string,
    entries: NoteHistoryEntry[],
    limits: NoteHistoryLimits,
  ): Promise<NoteHistoryEntry[]> {
    const oldest = this.now() - limits.keepDays * DAY_MS;
    const fresh = entries.filter((e) => e.at >= oldest);
    const kept = fresh.slice(Math.max(0, fresh.length - limits.maxPerFile));
    const keep = new Set(kept.map((e) => e.id));
    for (const entry of entries) {
      if (!keep.has(entry.id)) {
        await fsp.rm(path.join(dir, `${entry.id}.md`), { force: true });
      }
    }
    return kept;
  }

  private run<T>(task: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.queue.then(task).catch((error: unknown) => {
      console.warn('[history]', error);
      return fallback;
    });
    this.queue = next;
    return next;
  }

  private dirOf(vaultId: string, id: string): string {
    return path.join(this.root, vaultId, id);
  }

  private async readIndex(vaultId: string): Promise<VaultIndex> {
    return readJson<VaultIndex>(path.join(this.root, vaultId, 'index.json'), {});
  }

  private async writeIndex(vaultId: string, index: VaultIndex): Promise<void> {
    await fsp.mkdir(path.join(this.root, vaultId), { recursive: true });
    await fsp.writeFile(path.join(this.root, vaultId, 'index.json'), JSON.stringify(index), 'utf-8');
  }

  private async readEntries(dir: string): Promise<NoteHistoryEntry[]> {
    const entries = await readJson<NoteHistoryEntry[]>(path.join(dir, 'entries.json'), []);
    return Array.isArray(entries) ? entries : [];
  }

  private async writeEntries(dir: string, entries: NoteHistoryEntry[]): Promise<void> {
    await fsp.writeFile(path.join(dir, 'entries.json'), JSON.stringify(entries), 'utf-8');
  }
}

/** The index key for `relPath`, matched case-insensitively (Windows paths). */
function findKey(index: VaultIndex, relPath: string): string | null {
  if (Object.prototype.hasOwnProperty.call(index, relPath)) {
    return relPath;
  }
  const lower = relPath.toLowerCase();
  return Object.keys(index).find((key) => key.toLowerCase() === lower) ?? null;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}
