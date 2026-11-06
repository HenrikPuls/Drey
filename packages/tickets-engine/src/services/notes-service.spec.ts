import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotesChange } from '../contracts/notes';
import { NotesService } from './notes-service';

/**
 * req-100: the notes of the active vault on a real folder: list, recent,
 * search, read, the save guard of ADR-0060, create, and what is never served.
 */

let root: string;
let outside: string;
let service: NotesService;
let changes: NotesChange[];

async function put(rel: string, text: string, mtime?: Date): Promise<void> {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text, 'utf8');
  if (mtime !== undefined) {
    await fsp.utimes(abs, mtime, mtime);
  }
}

const disk = (rel: string): Promise<string> => fsp.readFile(path.join(root, rel), 'utf8');

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'drey-notes-'));
  outside = await fsp.mkdtemp(path.join(tmpdir(), 'drey-notes-outside-'));
  changes = [];
  service = new NotesService({ root: async () => root, log: () => undefined, now: () => new Date('2026-11-06T10:00:00') });
  service.onChanged((change) => changes.push(change));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

describe('list', () => {
  it('shows one folder: its subfolders and notes, by name', async () => {
    await put('b.md', 'b');
    await put('a.md', 'a');
    await put('topics/deep/x.md', 'x');
    await put('picture.png', 'not a note');
    const reply = await service.list(undefined);
    expect(reply).toMatchObject({ ok: true, folder: '', vault: path.basename(root), folders: [{ path: 'topics', name: 'topics' }] });
    expect(reply.ok && reply.notes.map((n) => n.path)).toEqual(['a.md', 'b.md']);
    const inner = await service.list('topics');
    expect(inner).toMatchObject({ ok: true, folder: 'topics', notes: [], folders: [{ path: 'topics/deep', name: 'deep' }] });
  });

  it('never lists .drafts, chats, tickets or another dot-folder', async () => {
    await put('.drafts/untitled.md', 'draft');
    await put('.git/x.md', 'x');
    await put('chats/2026/q.md', 'chat');
    await put('tickets/10-inbox/T-0001.md', 'ticket');
    await put('project/tickets/_meta/pipeline.md', 'nested checkout');
    await put('project/plan.md', 'plan');
    const reply = await service.list('');
    expect(reply).toMatchObject({ ok: true, notes: [], folders: [{ path: 'project', name: 'project' }] });
    expect(await service.list('project')).toMatchObject({ ok: true, folders: [], notes: [{ path: 'project/plan.md' }] });
  });

  it('answers not_found for a missing folder and bad_path for a refused one', async () => {
    expect(await service.list('nope')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await service.list('.drafts')).toMatchObject({ ok: false, code: 'bad_path' });
    expect(await service.list('../')).toMatchObject({ ok: false, code: 'bad_path' });
  });

  it('answers no_vault when the vault folder is gone', async () => {
    const gone = new NotesService({ root: async () => path.join(root, 'gone'), log: () => undefined });
    expect(await gone.list('')).toMatchObject({ ok: false, code: 'no_vault' });
    expect(await gone.recent(5)).toMatchObject({ ok: false, code: 'no_vault' });
    expect(await gone.read('a.md')).toMatchObject({ ok: false, code: 'no_vault' });
  });
});

describe('recent', () => {
  it('orders the whole vault by mtime, newest first, up to the limit', async () => {
    await put('old.md', 'old', new Date('2026-01-01T00:00:00Z'));
    await put('topics/new.md', 'new', new Date('2026-11-01T00:00:00Z'));
    await put('mid.md', 'mid', new Date('2026-06-01T00:00:00Z'));
    await put('.drafts/newest.md', 'draft', new Date('2026-11-05T00:00:00Z'));
    const reply = await service.recent(2);
    expect(reply.ok && reply.notes.map((n) => n.path)).toEqual(['topics/new.md', 'mid.md']);
  });
});

describe('search', () => {
  it('finds all words of one section, ignoring case, and reports line and heading', async () => {
    await put('boat.md', '---\ntitle: Boat\n---\n# Rigging\nNew SAIL for the mast\n# Other\nsail alone\n');
    await put('car.md', 'tyres only\n');
    const reply = await service.search('sail mast', 10);
    expect(reply).toMatchObject({
      ok: true,
      query: 'sail mast',
      truncated: false,
      hits: [{ path: 'boat.md', name: 'boat', lines: [{ line: 5, heading: 'Rigging', text: 'New SAIL for the mast' }] }],
    });
  });

  it('reads no excluded folder', async () => {
    await put('.drafts/a.md', 'needle');
    await put('chats/a.md', 'needle');
    await put('tickets/a.md', 'needle');
    expect(await service.search('needle', 10)).toMatchObject({ ok: true, hits: [] });
  });

  it('stops at the limit, newest first, and says so', async () => {
    await put('old.md', 'needle', new Date('2026-01-01T00:00:00Z'));
    await put('new.md', 'needle', new Date('2026-11-01T00:00:00Z'));
    const reply = await service.search('needle', 1);
    expect(reply).toMatchObject({ ok: true, truncated: true, hits: [{ path: 'new.md' }] });
  });

  it('refuses an empty query', async () => {
    expect(await service.search('   ', 10)).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('read', () => {
  it('returns text, frontmatter, body, tags and mtime', async () => {
    await put('a.md', '---\r\ntitle: Boat\r\n---\r\nbody #Sailing\r\n', new Date('2026-05-05T05:05:05Z'));
    const reply = await service.read('a.md');
    expect(reply).toMatchObject({
      ok: true,
      path: 'a.md',
      name: 'a',
      text: '---\ntitle: Boat\n---\nbody #Sailing\n',
      body: 'body #Sailing\n',
      tags: ['sailing'],
      frontmatter: { title: 'Boat' },
      mtime: new Date('2026-05-05T05:05:05Z').getTime(),
    });
  });

  it('gives a note without a fence a null frontmatter', async () => {
    await put('a.md', 'plain');
    expect(await service.read('a.md')).toMatchObject({ ok: true, frontmatter: null, body: 'plain' });
  });

  it('answers not_found for a missing note', async () => {
    expect(await service.read('nope.md')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it.each([
    '../secret.md',
    'a/../../secret.md',
    '/etc/secret.md',
    'C:/secret.md',
    '..\\secret.md',
    'a\\b.md',
    '.drafts/untitled.md',
    '.DRAFTS/untitled.md',
    'topics/.drafts/untitled.md',
    '.git/config.md',
    'chats/2026/q.md',
    'CHATS/q.md',
    'chats./q.md',
    'tickets/10-inbox/T-0001.md',
    'project/Tickets/T-0001.md',
    'note.md:stream.md',
    'NUL.md',
    'a//b.md',
    './a.md',
    'folder.md/',
    'not-a-note.txt',
    '',
  ])('refuses %j without reading it', async (bad) => {
    await put('.drafts/untitled.md', 'secret');
    await put('chats/2026/q.md', 'secret');
    expect(await service.read(bad)).toMatchObject({ ok: false, code: 'bad_path' });
  });

  it('refuses a non-string path', async () => {
    expect(await service.read(null)).toMatchObject({ ok: false, code: 'bad_path' });
    expect(await service.read(['a.md'])).toMatchObject({ ok: false, code: 'bad_path' });
  });

  it('refuses a link inside the vault that leads out of it or into .drafts', async () => {
    await fsp.writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8');
    await put('.drafts/hidden.md', 'draft');
    const linked = await fsp.symlink(outside, path.join(root, 'linked'), 'junction').then(() => true, () => false);
    if (linked) {
      expect(await service.read('linked/secret.md')).toMatchObject({ ok: false, code: 'bad_path' });
      expect(await service.list('linked')).toMatchObject({ ok: false, code: 'bad_path' });
      expect(await service.create({ path: 'linked/new.md', text: 'x' }, 'phone')).toMatchObject({ ok: false, code: 'bad_path' });
    }
    const intoDrafts = await fsp.symlink(path.join(root, '.drafts'), path.join(root, 'shortcut'), 'junction').then(() => true, () => false);
    if (intoDrafts) {
      expect(await service.read('shortcut/hidden.md')).toMatchObject({ ok: false, code: 'bad_path' });
    }
  });
});

describe('save', () => {
  const base = new Date('2026-05-05T05:05:05Z');

  it('writes when the note is unchanged, returns the new mtime and announces the path', async () => {
    await put('topics/a.md', 'old', base);
    const reply = await service.save({ path: 'topics/a.md', text: 'new', baseMtime: base.getTime() }, 'phone');
    expect(reply).toMatchObject({ ok: true, path: 'topics/a.md', text: 'new' });
    expect(await disk('topics/a.md')).toBe('new');
    expect(reply.ok && reply.mtime).toBeGreaterThan(base.getTime());
    expect(changes).toEqual([{ vaultPath: root, changed: ['topics/a.md'] }]);
  });

  it('refuses with the disk text when the note changed since it was read, and writes nothing', async () => {
    await put('a.md', 'desk edit\r\n', base);
    const reply = await service.save({ path: 'a.md', text: 'phone edit', baseMtime: base.getTime() - 5000 }, 'phone');
    expect(reply).toMatchObject({ ok: false, code: 'conflict', disk: { text: 'desk edit\n', mtime: base.getTime() } });
    expect(await disk('a.md')).toBe('desk edit\r\n');
    expect(changes).toEqual([]);
  });

  it('lets the merged text through once it names the disk mtime', async () => {
    await put('a.md', 'desk edit', base);
    const first = await service.save({ path: 'a.md', text: 'phone', baseMtime: 1 }, 'phone');
    expect(first.ok).toBe(false);
    const mtime = !first.ok && first.code === 'conflict' ? first.disk.mtime : 0;
    expect(await service.save({ path: 'a.md', text: 'merged', baseMtime: mtime }, 'phone')).toMatchObject({ ok: true });
    expect(await disk('a.md')).toBe('merged');
  });

  it('tolerates the same 2 ms as note:save', async () => {
    await put('a.md', 'old', base);
    expect(await service.save({ path: 'a.md', text: 'new', baseMtime: base.getTime() + 2 }, 'phone')).toMatchObject({ ok: true });
  });

  it('bumps an existing updated: and adds nothing to a note without it', async () => {
    await put('with.md', '---\nupdated: "2020-01-01"\n---\nbody', base);
    const reply = await service.save({ path: 'with.md', text: '---\nupdated: "2020-01-01"\n---\nedited', baseMtime: base.getTime() }, 'phone');
    expect(reply.ok && reply.text).not.toContain('2020-01-01');
    expect(reply.ok && reply.text).toContain('2026-11-06');
    expect(await disk('with.md')).toContain('edited');
    await put('without.md', 'body', base);
    expect(await service.save({ path: 'without.md', text: 'edited', baseMtime: base.getTime() }, 'phone')).toMatchObject({ ok: true, text: 'edited' });
    expect(await disk('without.md')).toBe('edited');
  });

  it("keeps the file's CRLF line ends on disk and answers in LF", async () => {
    await put('a.md', 'one\r\ntwo\r\n', base);
    const reply = await service.save({ path: 'a.md', text: 'one\ntwo\nthree\n', baseMtime: base.getTime() }, 'phone');
    expect(reply).toMatchObject({ ok: true, text: 'one\ntwo\nthree\n' });
    expect(await disk('a.md')).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('leaves no temp file behind', async () => {
    await put('a.md', 'old', base);
    await service.save({ path: 'a.md', text: 'new', baseMtime: base.getTime() }, 'phone');
    expect(await fsp.readdir(root)).toEqual(['a.md']);
  });

  it('answers not_found for a note deleted since it was read, and does not recreate it', async () => {
    expect(await service.save({ path: 'gone.md', text: 'x', baseMtime: 1 }, 'phone')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await fsp.readdir(root)).toEqual([]);
  });

  it.each(['../a.md', '.drafts/a.md', 'chats/a.md', 'tickets/a.md'])('refuses to write %s', async (bad) => {
    expect(await service.save({ path: bad, text: 'x', baseMtime: 1 }, 'phone')).toMatchObject({ ok: false, code: 'bad_path' });
    expect(changes).toEqual([]);
  });

  it('runs two saves from the same base one after the other: the second is a conflict', async () => {
    await put('a.md', 'old', base);
    const [first, second] = await Promise.all([
      service.save({ path: 'a.md', text: 'first', baseMtime: base.getTime() }, 'phone'),
      service.save({ path: 'a.md', text: 'second', baseMtime: base.getTime() }, 'ipad'),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false, code: 'conflict', disk: { text: 'first' } });
    expect(await disk('a.md')).toBe('first');
  });
});

describe('create', () => {
  it('creates the note and its folders and announces it', async () => {
    const reply = await service.create({ path: 'topics/new/a.md', text: 'hello\r\n' }, 'phone');
    expect(reply).toMatchObject({ ok: true, path: 'topics/new/a.md', text: 'hello\n' });
    expect(await disk('topics/new/a.md')).toBe('hello\n');
    expect(changes).toEqual([{ vaultPath: root, changed: ['topics/new/a.md'] }]);
  });

  it('creates an empty note when no text is given', async () => {
    expect(await service.create({ path: 'a.md' }, 'phone')).toMatchObject({ ok: true, text: '' });
    expect(await disk('a.md')).toBe('');
  });

  it('refuses a name that exists, and leaves it alone', async () => {
    await put('a.md', 'kept');
    expect(await service.create({ path: 'a.md', text: 'x' }, 'phone')).toMatchObject({ ok: false, code: 'exists' });
    expect(await disk('a.md')).toBe('kept');
    expect(changes).toEqual([]);
  });

  it.each(['../a.md', '.drafts/a.md', 'chats/a.md', 'tickets/a.md', 'a.txt', 'CON.md'])('refuses to create %s', async (bad) => {
    expect(await service.create({ path: bad, text: 'x' }, 'phone')).toMatchObject({ ok: false, code: 'bad_path' });
  });

  it('refuses a folder that is a note', async () => {
    await put('a.md', 'x');
    expect(await service.create({ path: 'a.md/b.md', text: 'x' }, 'phone')).toMatchObject({ ok: false, code: 'bad_path' });
  });
});
