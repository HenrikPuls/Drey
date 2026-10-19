/**
 * Directory derivation and resolution for every writer (T-0041):
 * Drey's board service and the fleet runner both resolve the directory a
 * ticket move targets — never rebuild `tickets/<dir>/<id>.md` from a bare
 * phase id.
 *
 * Resolution reuses before it derives: an existing directory whose
 * prefix-stripped id matches the phase wins (the owner's hand-made
 * `35-qa`, or an unprefixed `inbox` from before the migration), and only
 * when nothing matches does the derived `NN-<id>` name appear. A move
 * never renumbers existing directories — inserting a pipeline column by
 * hand takes a gap number. Renumbering happens only on the owner's
 * explicit reorder or "Number folders" (req-50, `planFolderNumbering`),
 * in one commit.
 *
 * Electron-free on purpose (`node:fs`/`node:path` only): the fleet runner
 * imports compiled plugin siblings as plain Node.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { phaseDirectoryName, stripPhasePrefix } from '../shared/tickets';

/** Every directory directly under the tickets root, names only, sorted.
 *  A missing (or unreadable) root reads as no directories. */
export async function listTicketDirs(ticketsRootAbs: string): Promise<string[]> {
  const entries = await fsp.readdir(ticketsRootAbs, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The directory a write into phase `id` targets: the derived name when it
 * already exists; else any directory whose stripped id matches (the
 * owner's `35-qa`, an unprefixed `inbox`); else the derived name — the
 * writer creates it on first use.
 */
export function resolvePhaseDir(dirs: readonly string[], position1: number, id: string): string {
  const derived = phaseDirectoryName(position1, id);
  if (dirs.includes(derived)) {
    return derived;
  }
  return dirs.find((dir) => stripPhasePrefix(dir) === id) ?? derived;
}

/** One folder the numbering folds into its derived name. */
export interface FolderMove {
  readonly from: string;
  readonly to: string;
}

/**
 * The renames that bring every phase folder to its derived `NN-<id>`
 * name for the pipeline order `phaseIds` (req-50: an explicit reorder or
 * "Number folders" — the only times code renumbers). Several folders of
 * one phase (an unprefixed `inbox` beside a machine-made `10-inbox`) all
 * fold into the derived one. Folders that name no phase, `_meta` and
 * `archive` are never touched. Empty = already numbered.
 */
export function planFolderNumbering(dirs: readonly string[], phaseIds: readonly string[]): FolderMove[] {
  const moves: FolderMove[] = [];
  phaseIds.forEach((id, index) => {
    const target = phaseDirectoryName(index + 1, id);
    for (const dir of dirs) {
      if (dir !== target && dir !== '_meta' && dir !== 'archive' && stripPhasePrefix(dir) === id) {
        moves.push({ from: dir, to: target });
      }
    }
  });
  return moves;
}

/**
 * Carries out `moves` under `ticketsRootAbs`, file by file. Checked first
 * (two files of one name landing in one folder refuse the whole run, and
 * nothing is touched); then every source folder is parked under a
 * temporary name so a swap (`50-build` ↔ `50-review`) cannot collide, and
 * finally emptied into its target. Returns the folders touched, for the
 * commit's pathspec.
 */
export async function applyFolderNumbering(ticketsRootAbs: string, moves: readonly FolderMove[]): Promise<string[]> {
  if (moves.length === 0) {
    return [];
  }
  const sources = [...new Set(moves.map((m) => m.from))];
  const filesOf = new Map<string, string[]>();
  for (const dir of sources) {
    filesOf.set(dir, await fsp.readdir(path.join(ticketsRootAbs, dir)));
  }
  const landing = new Map<string, Set<string>>();
  for (const move of moves) {
    // A target that is not itself moved away keeps its own files.
    const staying = sources.includes(move.to)
      ? []
      : await fsp.readdir(path.join(ticketsRootAbs, move.to)).catch(() => [] as string[]);
    const names = landing.get(move.to) ?? new Set(staying);
    for (const name of filesOf.get(move.from) ?? []) {
      if (names.has(name)) {
        throw new Error(`tickets/${move.from}/${name} would overwrite a file of that name in tickets/${move.to}`);
      }
      names.add(name);
    }
    landing.set(move.to, names);
  }
  const stamp = Date.now().toString(36);
  const parked = new Map<string, string>();
  for (const dir of sources) {
    const temp = `.renumber-${stamp}-${dir}`;
    await fsp.rename(path.join(ticketsRootAbs, dir), path.join(ticketsRootAbs, temp));
    parked.set(dir, temp);
  }
  for (const move of moves) {
    const from = path.join(ticketsRootAbs, parked.get(move.from)!);
    const to = path.join(ticketsRootAbs, move.to);
    await fsp.mkdir(to, { recursive: true });
    for (const name of filesOf.get(move.from) ?? []) {
      await fsp.rename(path.join(from, name), path.join(to, name));
    }
    await fsp.rmdir(from);
  }
  return [...new Set([...sources, ...moves.map((m) => m.to)])];
}
