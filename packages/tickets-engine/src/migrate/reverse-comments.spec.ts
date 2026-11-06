import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATION_NOTE_PREFIX, readStoreComments } from './reverse-comments';

let dir = '';
const git = (...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  git('init', '-q', '-b', 'tickets');
  const comments = path.join(dir, 'tickets', 't', '0000', 't-17', 'comments');
  mkdirSync(comments, { recursive: true });
  const write = (name: string, at: string, author: string, text: string): void =>
    writeFileSync(path.join(comments, name), `---\nticket: t-17\nauthor: ${author}\ncreated_at: ${at}\n---\n\n${text}\n`);
  write('2026-11-06T09-00-00Z-b.md', '2026-11-06T09:00:00Z', 'b@x', 'Second.\nTwo lines.');
  write('2026-11-05T09-00-00Z-a.md', '2026-11-05T09:00:00Z', 'a@x', 'First.');
  write('2026-11-05T08-00-00Z-m.md', '2026-11-05T08:00:00Z', 'owner@legion', `${MIGRATION_NOTE_PREFIX} T-0049; entries outside the migrated set were removed from depends.`);
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readStoreComments', () => {
  it('reads the comment files of the ticket branch, oldest first, without the migration note', () => {
    const map = readStoreComments(dir);
    expect(map.get('t-17')).toEqual([
      { at: '2026-11-05T09:00:00Z', author: 'a@x', text: 'First.' },
      { at: '2026-11-06T09:00:00Z', author: 'b@x', text: 'Second.\nTwo lines.' },
    ]);
  });

  it('throws for a folder that is not a repository (the CLI then says comments are not carried)', () => {
    expect(() => readStoreComments(os.tmpdir() + path.sep + 'rc-missing-' + Date.now())).toThrow();
  });
});
