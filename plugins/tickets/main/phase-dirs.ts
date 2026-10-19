/**
 * Directory derivation and resolution for every writer (T-0041):
 * Drey's board service and the fleet runner both resolve the directory a
 * ticket move targets — never rebuild `tickets/<dir>/<id>.md` from a bare
 * phase id.
 *
 * Resolution reuses before it derives: an existing directory whose
 * prefix-stripped id matches the phase wins (the owner's hand-made
 * `35-qa`, or an unprefixed `inbox` from before the migration), and only
 * when nothing matches does the derived `NN-<id>` name appear. Code never
 * renumbers existing directories — inserting a pipeline column takes a
 * gap number, not a rename cascade.
 *
 * Electron-free on purpose (`node:fs`/`node:path` only): the fleet runner
 * imports compiled plugin siblings as plain Node.
 */
import { promises as fsp } from 'node:fs';
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
