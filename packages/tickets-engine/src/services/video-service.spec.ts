import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TicketCard } from '../contracts/tickets';
import type { TicketsGit } from '../core/tickets-git';
import type { EngineBoardService } from './board-service';
import type { EngineHost } from './host';
import {
  ensureVideosDir,
  LIMIT_NOTICE,
  pickVideosToRemove,
  replaceVideoWithNote,
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

describe('pickVideosToRemove', () => {
  const MB = 1024 * 1024;
  const files = [
    { name: 'new.webm', bytes: 40 * MB, mtimeMs: 300 },
    { name: 'old.webm', bytes: 40 * MB, mtimeMs: 100 },
    { name: 'mid.webm', bytes: 40 * MB, mtimeMs: 200 },
  ];

  it('removes nothing while the folder fits', () => {
    expect(pickVideosToRemove(files, 120 * MB, () => true)).toEqual([]);
  });

  it('removes the oldest first and stops as soon as it fits', () => {
    expect(pickVideosToRemove(files, 100 * MB, () => true)).toEqual(['old.webm']);
    expect(pickVideosToRemove(files, 50 * MB, () => true)).toEqual(['old.webm', 'mid.webm']);
  });

  it('never removes a video the rule keeps', () => {
    expect(pickVideosToRemove(files, 50 * MB, (name) => name !== 'old.webm')).toEqual(['mid.webm', 'new.webm']);
    expect(pickVideosToRemove(files, 0, () => false)).toEqual([]);
  });
});

describe('replaceVideoWithNote', () => {
  const section = '### Video\n\n![](../videos/a-T-0001.webm)\n\n- 0:03 build\n- 0:09 test\n\n### Findings\n';

  it('swaps the player and its chapters for the removal note', () => {
    expect(replaceVideoWithNote(section, 'a-T-0001.webm')).toBe('### Video\n\nVideo removed (size limit).\n\n### Findings\n');
  });

  it('leaves a text alone that does not hold the player', () => {
    expect(replaceVideoWithNote(section, 'other.webm')).toBe(section);
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

describe('VideoService.sweep', () => {
  const MB = 1024 * 1024;
  let root: string;
  let files: Map<string, string>;
  let commits: { paths: string[]; message: string }[];
  let config: Record<string, unknown>;

  const card = (id: string, phase: string): TicketCard =>
    ({ id, path: `tickets/${phase}/${id}.md`, phase, meta: {} }) as unknown as TicketCard;

  function boot(cards: readonly TicketCard[]): VideoService {
    const board = {
      detect: async () => ({ id: 'vault', name: 'vault', path: root, exists: true, active: true }),
      snapshot: async () => ({
        vaultId: 'vault',
        columns: ['build', 'done'].map((id) => ({ phase: { id }, tickets: cards.filter((c) => c.phase === id) })),
      }),
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
    return new VideoService({ board, host, git, config: { get: async <T,>(k: string) => config[k] as T | undefined } });
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
    config = { 'videos.limitMb': 100 };
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('removes the oldest videos of done tickets only, notes it in the ticket, never touches a running ticket', async () => {
    config['videos.limitMb'] = 130;
    await video('verify-1-T-0001.webm', 60, 3000); // done, oldest
    await video('verify-2-T-0002.webm', 60, 2000); // build — kept
    await video('verify-3-T-0003.webm', 60, 1000); // done
    files.set(
      'tickets/done/T-0001.md',
      '## Verification\n\n### Video\n\n![](../videos/verify-1-T-0001.webm)\n\n- 0:03 build\n\n### Findings\n',
    );
    const service = boot([card('T-0001', 'done'), card('T-0002', 'build'), card('T-0003', 'done')]);

    const removed = await service.sweep();

    expect(removed).toEqual(['verify-1-T-0001.webm']);
    expect(await exists('verify-1-T-0001.webm')).toBe(false);
    expect(await exists('verify-2-T-0002.webm')).toBe(true);
    expect(await exists('verify-3-T-0003.webm')).toBe(true);
    expect(files.get('tickets/done/T-0001.md')).toContain('Video removed (size limit).');
    expect(files.get('tickets/done/T-0001.md')).not.toContain('![](');
    expect(commits.map((c) => c.message)).toEqual(['tickets: videos removed (size limit)']);
  });

  it('removes a video whose ticket left the board, with no ticket text to touch', async () => {
    await video('verify-1-T-0009.webm', 120, 1000);
    const service = boot([]);
    expect(await service.sweep()).toEqual(['verify-1-T-0009.webm']);
    expect(commits).toEqual([]);
  });

  it('deletes nothing with inGit on and raises the notice', async () => {
    config['videos.inGit'] = true;
    await video('verify-1-T-0001.webm', 120, 1000);
    const service = boot([card('T-0001', 'done')]);

    expect(await service.sweep()).toEqual([]);
    expect(await exists('verify-1-T-0001.webm')).toBe(true);
    expect((await service.status()).notice).toBe(LIMIT_NOTICE);
  });

  it('says so when only unfinished tickets keep the folder over the limit', async () => {
    await video('verify-1-T-0001.webm', 120, 1000);
    const service = boot([card('T-0001', 'build')]);

    expect(await service.sweep()).toEqual([]);
    expect((await service.status()).notice).toContain('not done yet');
  });

  it('commits the existing videos only when asked, with inGit on', async () => {
    config['videos.inGit'] = true;
    await video('verify-1-T-0001.webm', 1, 1000);
    const service = boot([card('T-0001', 'done')]);

    await service.applyInGit(false);
    expect(commits).toEqual([]);
    await service.applyInGit(true);
    expect(commits).toEqual([{ paths: ['tickets/videos/verify-1-T-0001.webm'], message: 'tickets: include existing videos' }]);
  });

  it('serves a stat for a real name only', async () => {
    await video('verify-1-T-0001.webm', 1, 1000);
    const service = boot([]);
    expect((await service.stat('verify-1-T-0001.webm'))?.bytes).toBe(MB);
    expect(await service.stat('nope.webm')).toBeNull();
    expect(await service.stat('../x.webm')).toBeNull();
  });
});
