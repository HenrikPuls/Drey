/**
 * The walkthrough videos of `ui` proofs (E11-1, concept v2 §5.3, owner
 * decision D12): the reserved `tickets/videos/` folder, the engine-owned
 * `.gitignore` that keeps them out of commits, and the size cap of ONE
 * video (E11-1c, owner decision 2026-11-04). The engine NEVER deletes a
 * video: retention is limited by the disk alone — no age, folder-size or
 * ticket-state rule. Specification: specs/ticket-schema.md, "Videos".
 *
 * The pure rules (names, the cap verdict) are plain functions;
 * `VideoService` composes them over the vault folder, the board and the
 * engine config keys `videos.inGit` / `videos.maxMb`.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { TicketsGit } from '../core/tickets-git';
import { normalizeVideoSettings, SETTINGS_KEYS } from '../server/settings';
import type { EngineBoardService } from './board-service';
import type { EngineHost } from './host';

export const VIDEOS_DIR = 'tickets/videos';
/** The name a served or stored video must have: no slash, no dot-dot, two containers. */
export const VIDEO_NAME = /^[A-Za-z0-9._-]+\.(mp4|webm)$/;
/** The ignore file the engine maintains: everything but itself. */
export const VIDEOS_GITIGNORE = '*\n!.gitignore\n';
/** `verify-20261101-143200-T-0042.webm` → `T-0042`; null for a name that carries no id. */
export function videoTicketId(name: string): string | null {
  return /-(T-\d{4,})\.(?:mp4|webm)$/.exec(name)?.[1] ?? null;
}

/** The cap of one video in bytes. */
export function maxVideoBytes(maxMb: number): number {
  return maxMb * 1024 * 1024;
}

export type VideoVerdict =
  | { readonly keep: true }
  | { readonly keep: false; readonly mb: number; readonly maxMb: number; readonly line: string };

/**
 * Whether a recording of `bytes` may be kept: exactly the cap is kept,
 * one byte over is not. The line is the honest sentence the ticket's
 * `## Verification` carries instead of the player.
 */
export function judgeVideoSize(bytes: number, maxMb: number): VideoVerdict {
  if (bytes <= maxVideoBytes(maxMb)) {
    return { keep: true };
  }
  const mb = Math.ceil((bytes / (1024 * 1024)) * 10) / 10;
  return { keep: false, mb, maxMb, line: `Video not kept: ${mb} MB exceeds the ${maxMb} MB limit.` };
}

export interface VideoFile {
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** Creates the folder and brings its `.gitignore` in line with `videos.inGit`. */
export async function ensureVideosDir(dir: string, inGit: boolean): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  const current = await fsp.readFile(ignore, 'utf8').catch(() => null);
  if (inGit) {
    // Only the engine's own rule is removed; a hand-edited file stays.
    if (current !== null && current.replace(/\r\n/g, '\n') === VIDEOS_GITIGNORE) {
      await fsp.rm(ignore, { force: true });
    }
  } else if (current === null || current.replace(/\r\n/g, '\n') !== VIDEOS_GITIGNORE) {
    await fsp.writeFile(ignore, VIDEOS_GITIGNORE, 'utf8');
  }
}

export async function listVideoFiles(dir: string): Promise<VideoFile[]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const files: VideoFile[] = [];
  for (const name of names) {
    if (!VIDEO_NAME.test(name)) {
      continue;
    }
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (stat !== null && stat.isFile()) {
      files.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}

export interface VideoServiceDeps {
  readonly board: EngineBoardService;
  readonly host: EngineHost;
  readonly git: TicketsGit;
  readonly config: {
    get<T>(key: string): Promise<T | undefined>;
    /** Drops a key; absent on a host whose store cannot (the retired key then just stays unread). */
    delete?(key: string): Promise<void>;
  };
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export class VideoService {
  private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;

  constructor(private readonly deps: VideoServiceDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  /** The folder's absolute path for the detected tickets vault; null without one. */
  async dir(): Promise<{ vaultId: string; abs: string } | null> {
    const vault = await this.deps.board.detect();
    if (vault === null) {
      return null;
    }
    const abs = this.deps.host.resolveAssetPath(vault.id, VIDEOS_DIR);
    return abs === null ? null : { vaultId: vault.id, abs };
  }

  async settings(): Promise<{ inGit: boolean; maxMb: number }> {
    const settings = normalizeVideoSettings(
      {
        inGit: await this.deps.config.get(SETTINGS_KEYS.videosInGit),
        maxMb: await this.deps.config.get(SETTINGS_KEYS.videosMaxMb),
      },
      0,
    );
    return { inGit: settings.inGit, maxMb: settings.maxMb };
  }

  /**
   * The per-video cap (E11-1c) applied to a recording that was just
   * stored as `name`: within the cap it stays; over it the file is
   * dropped (the only deletion the engine ever does — of the recording
   * it is about to reference, never of an existing video) and the
   * verdict carries the line for the ticket. A missing file is kept as
   * "keep": the caller already treats an absent file as no video.
   */
  async enforceCap(dir: string, name: string): Promise<VideoVerdict> {
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (stat === null || !stat.isFile()) {
      return { keep: true };
    }
    const verdict = judgeVideoSize(stat.size, (await this.settings()).maxMb);
    if (!verdict.keep) {
      await fsp.rm(path.join(dir, name), { force: true });
      this.log(`videos: ${name} not kept — ${verdict.mb} MB over the ${verdict.maxMb} MB cap`);
    }
    return verdict;
  }

  /** E11-1c: the retired folder-total key is dropped from the config; it governs nothing anymore. */
  private async dropRetiredKey(): Promise<void> {
    if (this.deps.config.delete === undefined) {
      return;
    }
    if ((await this.deps.config.get(SETTINGS_KEYS.videosLimitMbRetired)) !== undefined) {
      await this.deps.config.delete(SETTINGS_KEYS.videosLimitMbRetired).catch(() => undefined);
    }
  }

  /** The folder exists and its ignore file matches the config; returns the absolute path. */
  async prepare(): Promise<string | null> {
    await this.dropRetiredKey();
    const where = await this.dir();
    if (where === null) {
      return null;
    }
    await ensureVideosDir(where.abs, (await this.settings()).inGit);
    return where.abs;
  }

  /** Videos in the folder (the settings screen's "Include the n existing videos"). */
  async status(): Promise<{ count: number }> {
    const where = await this.dir();
    return { count: where === null ? 0 : (await listVideoFiles(where.abs)).length };
  }

  /** The bytes of one video for the route; null when the name is bad or the file absent. */
  async stat(name: string): Promise<{ file: string; bytes: number } | null> {
    if (!VIDEO_NAME.test(name)) {
      return null;
    }
    const where = await this.dir();
    if (where === null) {
      return null;
    }
    const file = path.join(where.abs, name);
    const stat = await fsp.stat(file).catch(() => null);
    return stat !== null && stat.isFile() ? { file, bytes: stat.size } : null;
  }

  /**
   * `videos.inGit` was switched: the ignore rule follows, and the owner's
   * "Include the n existing videos" tick commits what is there. Without
   * the tick nothing existing is committed (they stay untracked).
   */
  async applyInGit(includeExisting: boolean): Promise<string | null> {
    const where = await this.dir();
    if (where === null) {
      return null;
    }
    const { inGit } = await this.settings();
    await ensureVideosDir(where.abs, inGit);
    if (!inGit || !includeExisting) {
      return null;
    }
    const files = await listVideoFiles(where.abs);
    if (files.length === 0) {
      return null;
    }
    const vault = (await this.deps.host.listVaults()).find((v) => v.id === where.vaultId);
    const location = vault === undefined ? null : await this.deps.git.locate(vault.path);
    if (location === null) {
      return 'the tickets vault is not a git repository — the videos are not versioned';
    }
    try {
      await this.deps.git.commitPaths(
        location.root,
        files.map((f) => `${location.prefix}${VIDEOS_DIR}/${f.name}`),
        'tickets: include existing videos',
      );
      return null;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.log(`git commit of the existing videos failed: ${text}`, 'warn');
      return `git commit failed: ${text.split('\n')[0]}`;
    }
  }
}
