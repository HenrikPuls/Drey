/**
 * The walkthrough videos of `ui` proofs (E11-1, concept v2 §5.3, owner
 * decision D12): the reserved `tickets/videos/` folder, the engine-owned
 * `.gitignore` that keeps them out of commits, and the size limit that
 * frees the oldest videos of finished tickets. Specification:
 * specs/ticket-schema.md, "Videos".
 *
 * The pure rules (names, who may be removed, in which order) are plain
 * functions; `VideoService` composes them over the vault folder, the
 * board and the engine config keys `videos.inGit` / `videos.limitMb`.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { BoardSnapshot, TicketCard } from '../contracts/tickets';
import { TicketsGit } from '../core/tickets-git';
import { VIDEO_REMOVED_NOTE } from '../core/verification';
import { normalizeVideoSettings, SETTINGS_KEYS } from '../server/settings';
import type { EngineBoardService } from './board-service';
import type { EngineHost } from './host';

export const VIDEOS_DIR = 'tickets/videos';
/** The name a served or stored video must have: no slash, no dot-dot, two containers. */
export const VIDEO_NAME = /^[A-Za-z0-9._-]+\.(mp4|webm)$/;
/** The ignore file the engine maintains: everything but itself. */
export const VIDEOS_GITIGNORE = '*\n!.gitignore\n';
export const LIMIT_NOTICE = 'The limit no longer frees space.';

/** `verify-20261101-143200-T-0042.webm` → `T-0042`; null for a name that carries no id. */
export function videoTicketId(name: string): string | null {
  return /-(T-\d{4,})\.(?:mp4|webm)$/.exec(name)?.[1] ?? null;
}

export interface VideoFile {
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/**
 * The videos to delete so the folder fits `limitBytes`: oldest first,
 * only ones `removable` allows (a done ticket's), stopping as soon as
 * the total is under the limit. Nothing is removed when it already fits.
 */
export function pickVideosToRemove(
  files: readonly VideoFile[],
  limitBytes: number,
  removable: (name: string) => boolean,
): string[] {
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  const picked: string[] = [];
  for (const file of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))) {
    if (total <= limitBytes) {
      break;
    }
    if (removable(file.name)) {
      picked.push(file.name);
      total -= file.bytes;
    }
  }
  return picked;
}

/**
 * Swaps a removed video's player (and its chapter bullets) for the
 * removal note; the text is unchanged when the player is not there.
 */
export function replaceVideoWithNote(ticketText: string, videoName: string): string {
  const escaped = videoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const player = new RegExp(`^!\\[\\]\\(\\.\\./videos/${escaped}\\)[ \\t]*\\r?\\n(?:\\r?\\n)?(?:- \\d+:\\d{2} .*\\r?\\n?)*`, 'm');
  return ticketText.replace(player, `${VIDEO_REMOVED_NOTE}\n`);
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
  };
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export class VideoService {
  private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  private notice: string | null = null;
  private sweeping: Promise<string[]> | null = null;

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

  async settings(): Promise<{ inGit: boolean; limitMb: number }> {
    const settings = normalizeVideoSettings(
      {
        inGit: await this.deps.config.get(SETTINGS_KEYS.videosInGit),
        limitMb: await this.deps.config.get(SETTINGS_KEYS.videosLimitMb),
      },
      0,
    );
    return { inGit: settings.inGit, limitMb: settings.limitMb };
  }

  /** The folder exists and its ignore file matches the config; returns the absolute path. */
  async prepare(): Promise<string | null> {
    const where = await this.dir();
    if (where === null) {
      return null;
    }
    await ensureVideosDir(where.abs, (await this.settings()).inGit);
    return where.abs;
  }

  /** Videos in the folder and the standing notice (the settings screen reads both). */
  async status(): Promise<{ count: number; notice: string | null }> {
    const where = await this.dir();
    const count = where === null ? 0 : (await listVideoFiles(where.abs)).length;
    return { count, notice: this.notice };
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
    this.notice = null;
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

  /**
   * Enforces `videos.limitMb`. With `inGit` off the oldest videos of done
   * tickets (or of tickets no longer on the board) are deleted until the
   * folder fits; a video of a ticket that is not done is never touched.
   * With `inGit` on nothing is deleted — only the notice is raised.
   * Returns the removed names; concurrent calls share one pass.
   */
  sweep(): Promise<string[]> {
    this.sweeping ??= this.sweepNow().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async sweepNow(): Promise<string[]> {
    try {
      const where = await this.dir();
      if (where === null) {
        return [];
      }
      const { inGit, limitMb } = await this.settings();
      const files = await listVideoFiles(where.abs);
      const limitBytes = limitMb * 1024 * 1024;
      const total = files.reduce((sum, f) => sum + f.bytes, 0);
      if (total <= limitBytes) {
        this.notice = null;
        return [];
      }
      if (inGit) {
        this.notice = LIMIT_NOTICE;
        return [];
      }
      const snap = await this.deps.board.snapshot();
      const picked = pickVideosToRemove(files, limitBytes, (name) => this.isFinished(snap, name));
      const touched: string[] = [];
      for (const name of picked) {
        await fsp.rm(path.join(where.abs, name), { force: true });
        const card = this.cardOf(snap, name);
        if (card !== null && (await this.noteRemoval(where.vaultId, card, name))) {
          touched.push(card.path);
        }
      }
      if (touched.length > 0) {
        await this.commitTickets(where.vaultId, touched);
        this.deps.host.announceChanges(where.vaultId, touched);
      }
      const left = files.filter((f) => !picked.includes(f.name)).reduce((sum, f) => sum + f.bytes, 0);
      this.notice = left > limitBytes ? 'The limit is exceeded by videos of tickets that are not done yet.' : null;
      if (picked.length > 0) {
        this.log(`videos: removed ${picked.length} over the ${limitMb} MB limit`);
      }
      return picked;
    } catch (error) {
      this.log(`video sweep failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      return [];
    }
  }

  private cardOf(snap: BoardSnapshot, videoName: string): TicketCard | null {
    const id = videoTicketId(videoName);
    if (id === null) {
      return null;
    }
    for (const column of snap.columns) {
      const found = column.tickets.find((t) => t.id === id);
      if (found !== undefined) {
        return found;
      }
    }
    return null;
  }

  /** A video may go when its ticket sits in the terminal column or is no longer on the board. */
  private isFinished(snap: BoardSnapshot, videoName: string): boolean {
    if (videoTicketId(videoName) === null) {
      return false;
    }
    const card = this.cardOf(snap, videoName);
    if (card === null) {
      return true;
    }
    const last = snap.columns[snap.columns.length - 1];
    return last !== undefined && last.tickets.some((t) => t.id === card.id);
  }

  private async noteRemoval(vaultId: string, card: TicketCard, videoName: string): Promise<boolean> {
    const text = await this.deps.host.read(vaultId, card.path);
    const patched = replaceVideoWithNote(text, videoName);
    if (patched === text) {
      return false;
    }
    await this.deps.host.write(vaultId, card.path, patched);
    return true;
  }

  private async commitTickets(vaultId: string, vaultRelPaths: readonly string[]): Promise<void> {
    const vault = (await this.deps.host.listVaults()).find((v) => v.id === vaultId);
    const location = vault === undefined ? null : await this.deps.git.locate(vault.path);
    if (location === null) {
      return;
    }
    try {
      await this.deps.git.commitPaths(
        location.root,
        vaultRelPaths.map((p) => `${location.prefix}${p}`),
        'tickets: videos removed (size limit)',
      );
    } catch (error) {
      this.log(`git commit failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }
}
