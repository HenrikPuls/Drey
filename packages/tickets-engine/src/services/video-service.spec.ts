import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TicketsGit } from '../core/tickets-git';
import type { EngineBoardService } from './board-service';
import type { EngineHost } from './host';
import {
  ensureVideosDir,
  judgeVideoSize,
  maxVideoBytes,
  VIDEO_NAME,
  VIDEOS_GITIGNORE,
  videoTicketId,
  VideoService,
} from './video-service';

describe('names', () => {
  it('reads the ticket id out of the video name', () => {
    expect(videoTicketId('verify-20261101-143200-T-0042.webm')).toBe('T-0042');
    expect(videoTicketId('verify-20261101-143200-T-10000.mp4')).toBe('T-10000');
    expect(videoTicketId('clip.webm')).toBeNull();
  });

  it('pins served names to two containers and no path', () => {
    expect(VIDEO_NAME.test('verify-1-T-0001.webm')).toBe(true);
    expect(VIDEO_NAME.test('a/b.webm')).toBe(false);
    expect(VIDEO_NAME.test('..\\x.mp4')).toBe(false);
    expect(VIDEO_NAME.test('x.avi')).toBe(false);
  });
});

describe('the folder', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(tmpdir(), 'videos-dir-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('keeps videos out of git by default and lifts the rule with inGit', async () => {
    const target = path.join(dir, 'videos');
    await ensureVideosDir(target, false);
    expect(await fsp.readFile(path.join(target, '.gitignore'), 'utf8')).toBe(VIDEOS_GITIGNORE);
    await ensureVideosDir(target, true);
    await expect(fsp.stat(path.join(target, '.gitignore'))).rejects.toBeDefined();
    await ensureVideosDir(target, false);
    expect(await fsp.readFile(path.join(target, '.gitignore'), 'utf8')).toBe(VIDEOS_GITIGNORE);
  });

  it('does not delete a hand-edited ignore file', async () => {
    const target = path.join(dir, 'videos');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, '.gitignore'), 'keep-me\n');
    await ensureVideosDir(target, true);
    expect(await fsp.readFile(path.join(target, '.gitignore'), 'utf8')).toBe('keep-me\n');
  });
});

describe('VideoService', () => {
  const MB = 1024 * 1024;
  let root: string;
  let files: Map<string, string>;
  let commits: { paths: string[]; message: string }[];
  let config: Record<string, unknown>;
  let deleted: string[];

  function boot(): VideoService {
    const board = {
      detect: async () => ({ id: 'vault', name: 'vault', path: root, exists: true, active: true }),
    } as unknown as EngineBoardService;
    const host = {
      listVaults: async () => [{ id: 'vault', name: 'vault', path: root, exists: true, active: true }],
      resolveAssetPath: (_v: string, p: string) => path.join(root, p),
      read: async (_v: string, p: string) => files.get(p) ?? '',
      write: async (_v: string, p: string, text: string) => {
        files.set(p, text);
      },
      announceChanges: () => undefined,
    } as unknown as EngineHost;
    const git = {
      locate: async (p: string) => ({ root: p, prefix: '' }),
      commitPaths: async (_root: string, paths: readonly string[], message: string) => {
        commits.push({ paths: [...paths], message });
      },
    } as unknown as TicketsGit;
    return new VideoService({ board, host, git, config: {
        get: async <T,>(k: string) => config[k] as T | undefined,
        delete: async (k: string) => {
          deleted.push(k);
          delete config[k];
        },
      },
    });
  }

  async function video(name: string, megabytes: number, ageMs: number): Promise<void> {
    const file = path.join(root, 'tickets', 'videos', name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.alloc(megabytes * MB));
    const t = new Date(Date.now() - ageMs);
    await fsp.utimes(file, t, t);
  }

  const exists = (name: string): Promise<boolean> =>
    fsp.stat(path.join(root, 'tickets', 'videos', name)).then(() => true, () => false);

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'video-service-'));
    files = new Map();
    commits = [];
    config = {};
    deleted = [];
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('commits the existing videos only when asked, with inGit on', async () => {
    config['videos.inGit'] = true;
    await video('verify-1-T-0001.webm', 1, 1000);
    const service = boot();

    await service.applyInGit(false);
    expect(commits).toEqual([]);
    await service.applyInGit(true);
    expect(commits).toEqual([{ paths: ['tickets/videos/verify-1-T-0001.webm'], message: 'tickets: include existing videos' }]);
  });

  it('keeps a recording of exactly 25 MB and every other video, however many and however big', async () => {
    await video('verify-1-T-0001.webm', 25, 5000);
    await video('verify-0-T-0000.webm', 24, 9000);
    const service = boot();
    expect(await service.enforceCap(path.join(root, 'tickets', 'videos'), 'verify-1-T-0001.webm')).toEqual({ keep: true });
    expect(await exists('verify-1-T-0001.webm')).toBe(true);
    expect(await exists('verify-0-T-0000.webm')).toBe(true);
  });

  it('drops only the over-cap recording, with the honest line, and touches no older video', async () => {
    await video('verify-1-T-0001.webm', 26, 1000);
    await video('verify-0-T-0000.webm', 20, 99_000_000);
    const service = boot();
    const verdict = await service.enforceCap(path.join(root, 'tickets', 'videos'), 'verify-1-T-0001.webm');
    expect(verdict).toMatchObject({ keep: false, line: 'Video not kept: 26 MB exceeds the 25 MB limit.' });
    expect(await exists('verify-1-T-0001.webm')).toBe(false);
    expect(await exists('verify-0-T-0000.webm')).toBe(true);
  });

  it('reads the cap from videos.maxMb', async () => {
    config['videos.maxMb'] = 10;
    await video('verify-1-T-0001.webm', 11, 1000);
    const verdict = await boot().enforceCap(path.join(root, 'tickets', 'videos'), 'verify-1-T-0001.webm');
    expect(verdict).toMatchObject({ keep: false, maxMb: 10 });
  });

  it('has no sweep: nothing deletes automatically', async () => {
    expect((boot() as unknown as Record<string, unknown>)['sweep']).toBeUndefined();
    await video('verify-1-T-0001.webm', 60, 1000);
    await video('verify-2-T-0002.webm', 60, 2000);
    const service = boot();
    await service.prepare();
    await service.status();
    expect(await exists('verify-1-T-0001.webm')).toBe(true);
    expect(await exists('verify-2-T-0002.webm')).toBe(true);
  });

  it('drops a stored videos.limitMb and ignores it', async () => {
    config['videos.limitMb'] = 2000;
    const service = boot();
    expect(await service.settings()).toEqual({ inGit: false, maxMb: 25 });
    await service.prepare();
    expect(deleted).toEqual(['videos.limitMb']);
    expect(config['videos.limitMb']).toBeUndefined();
  });

  it('serves a stat for a real name only', async () => {
    await video('verify-1-T-0001.webm', 1, 1000);
    const service = boot();
    expect((await service.stat('verify-1-T-0001.webm'))?.bytes).toBe(MB);
    expect(await service.stat('nope.webm')).toBeNull();
    expect(await service.stat('../x.webm')).toBeNull();
  });
});

describe('the per-video cap (E11-1c)', () => {
  const MB = 1024 * 1024;

  it('keeps a recording of exactly the cap and drops one byte more', () => {
    expect(judgeVideoSize(25 * MB, 25)).toEqual({ keep: true });
    expect(judgeVideoSize(25 * MB - 1, 25)).toEqual({ keep: true });
    const over = judgeVideoSize(25 * MB + 1, 25);
    expect(over).toMatchObject({ keep: false, maxMb: 25, mb: 25.1, line: 'Video not kept: 25.1 MB exceeds the 25 MB limit.' });
  });

  it('writes the size and the cap into the line', () => {
    expect(judgeVideoSize(31 * MB, 25)).toMatchObject({ keep: false, line: 'Video not kept: 31 MB exceeds the 25 MB limit.' });
    expect(judgeVideoSize(3 * MB, 2)).toMatchObject({ keep: false, line: 'Video not kept: 3 MB exceeds the 2 MB limit.' });
    expect(maxVideoBytes(25)).toBe(26_214_400);
  });
});
