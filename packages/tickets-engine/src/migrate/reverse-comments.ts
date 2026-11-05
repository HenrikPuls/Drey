import { execFileSync } from 'node:child_process';

import type { DricketComment } from './reverse';

/** The note `apply.ts` leaves on a ticket whose `blocked-by` it had to drop; the reverse restores the field itself. */
export const MIGRATION_NOTE_PREFIX = 'Migration: legacy blocked-by was';

/**
 * Comments of a LOCAL dricket store, read from the files of its ticket branch
 * (`tickets/<prefix>/<bucket>/<id>/comments/<stamp>-<author>.md`): `dk` has no
 * command that lists them. Keyed by dricket id (`t-17`), oldest first.
 */
export function readStoreComments(storeDir: string, branch = 'tickets'): Map<string, DricketComment[]> {
  const git = (args: string[]): string => execFileSync('git', ['-C', storeDir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = new Map<string, DricketComment[]>();
  const files = git(['ls-tree', '-r', '--name-only', `refs/heads/${branch}`]).split('\n').filter((p) => /\/comments\/[^/]+\.md$/.test(p));
  for (const file of files) {
    const id = /\/([^/]+)\/comments\/[^/]+\.md$/.exec(file)?.[1];
    if (id === undefined) {
      continue;
    }
    const parsed = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(git(['show', `refs/heads/${branch}:${file}`]).replace(/\r\n/g, '\n'));
    if (parsed === null) {
      continue;
    }
    const field = (name: string): string => new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(parsed[1]!)?.[1]?.trim() ?? '';
    const text = parsed[2]!.trim();
    if (text === '' || text.startsWith(MIGRATION_NOTE_PREFIX)) {
      continue;
    }
    const list = out.get(id) ?? [];
    list.push({ at: field('created_at'), author: field('author'), text });
    out.set(id, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
  }
  return out;
}