import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NoteHistoryLimits, NoteHistoryStore, THROTTLE_MS } from './note-history-store';

/**
 * `electron/history/note-history-store.ts` (ADR-0060). Real temp folders:
 * the store is nothing but file bookkeeping.
 */
describe('NoteHistoryStore', () => {
  let root: string;
  let now: number;
  let limits: NoteHistoryLimits;
  let store: NoteHistoryStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-history-'));
    now = 1_000_000_000_000;
    limits = { enabled: true, keepDays: 30, maxPerFile: 50 };
    store = new NoteHistoryStore(root, () => limits, () => now);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const texts = async (vault: string, rel: string): Promise<Array<string | null>> => {
    const entries = await store.list(vault, rel);
    return Promise.all(entries.map((e) => store.read(vault, rel, e.id)));
  };

  it('records versions newest first and reads them back', async () => {
    expect(await store.capture('v1', 'a.md', 'one', 'save')).toBe(true);
    now += 1000;
    expect(await store.capture('v1', 'a.md', 'two', 'mcp')).toBe(true);
    const entries = await store.list('v1', 'a.md');
    expect(entries.map((e) => e.origin)).toEqual(['mcp', 'save']);
    expect(await texts('v1', 'a.md')).toEqual(['two', 'one']);
    expect(await store.list('v1', 'other.md')).toEqual([]);
  });

  it('skips what it should not keep', async () => {
    expect(await store.capture('v1', 'pic.png', 'x', 'app')).toBe(false);
    expect(await store.capture('v1', 'chats/2026/c.md', 'x', 'app')).toBe(false);
    expect(await store.capture('v1', '.drafts/unnamed-1.md', 'x', 'app')).toBe(false);
    expect(await store.capture('v1', 'a.md', 'same', 'app')).toBe(true);
    expect(await store.capture('v1', 'a.md', 'same', 'app')).toBe(false);
    limits = { ...limits, enabled: false };
    expect(await store.capture('v1', 'a.md', 'different', 'app')).toBe(false);
  });

  it('throttles only throttled captures', async () => {
    await store.capture('v1', 'a.md', 'one', 'save', { throttled: true });
    now += THROTTLE_MS - 1;
    expect(await store.capture('v1', 'a.md', 'two', 'save', { throttled: true })).toBe(false);
    expect(await store.capture('v1', 'a.md', 'two', 'assistant')).toBe(true);
    now += THROTTLE_MS;
    expect(await store.capture('v1', 'a.md', 'three', 'save', { throttled: true })).toBe(true);
    expect(await texts('v1', 'a.md')).toEqual(['three', 'two', 'one']);
  });

  it('drops the oldest past the count and everything past the age', async () => {
    limits = { enabled: true, keepDays: 30, maxPerFile: 2 };
    for (const text of ['one', 'two', 'three']) {
      await store.capture('v1', 'a.md', text, 'app');
      now += 1000;
    }
    expect(await texts('v1', 'a.md')).toEqual(['three', 'two']);

    now += 31 * 24 * 60 * 60 * 1000;
    await store.sweep();
    expect(await store.list('v1', 'a.md')).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'v1'))).toEqual(['index.json']);
  });

  it('follows a renamed note, a renamed folder and a move to another vault', async () => {
    await store.capture('v1', 'dir/a.md', 'a', 'app');
    await store.capture('v1', 'dir/sub/b.md', 'b', 'app');
    await store.capture('v1', 'directory.md', 'c', 'app');

    await store.rename('v1', 'dir/a.md', 'v1', 'dir/renamed.md');
    expect(await texts('v1', 'dir/renamed.md')).toEqual(['a']);
    expect(await store.list('v1', 'dir/a.md')).toEqual([]);

    await store.rename('v1', 'dir', 'v1', 'moved');
    expect(await texts('v1', 'moved/renamed.md')).toEqual(['a']);
    expect(await texts('v1', 'moved/sub/b.md')).toEqual(['b']);
    // A sibling that merely shares the prefix is not part of the folder.
    expect(await texts('v1', 'directory.md')).toEqual(['c']);

    await store.rename('v1', 'moved/sub/b.md', 'v2', 'b.md');
    expect(await texts('v2', 'b.md')).toEqual(['b']);
    expect(await store.list('v1', 'moved/sub/b.md')).toEqual([]);
  });

  it('finds a note regardless of path case and refuses a foreign entry id', async () => {
    await store.capture('v1', 'Notes/A.md', 'one', 'app');
    expect(await texts('v1', 'notes/a.md')).toEqual(['one']);
    expect(await store.read('v1', 'Notes/A.md', '../index')).toBeNull();
  });
});
