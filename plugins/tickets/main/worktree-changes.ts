/**
 * The Changes-so-far box's pure half (req-75 W4a): what the ticket's
 * branch changed against its base ref — committed (`<base>...HEAD`) and
 * uncommitted (the working tree vs `HEAD`) — parsed from git's numstat
 * and name-status outputs into one file list. No DOM, no git: the board
 * service runs the commands (`index.ts`), this turns them into data.
 */

/** One changed file as the thread's box shows it. */
export interface WorktreeFile {
  /** The git status letter (A/M/D/R/C…). */
  readonly status: string;
  readonly path: string;
  /** Lines added; null for a binary file. */
  readonly added: number | null;
  /** Lines removed; null for a binary file. */
  readonly removed: number | null;
}

/** The box never grows past this many files (the plan's cap). */
export const MAX_WORKTREE_FILES = 50;

interface Counts {
  added: number | null;
  removed: number | null;
}

/**
 * `git diff --numstat` output: `<added>\t<removed>\tpath` per line, `-`
 * for a binary side. Paths keep their tabs/spaces (numstat quotes what
 * needs it; a leading `"` stays as written — tolerant, never a throw).
 */
export function parseNumstat(text: string): ReadonlyMap<string, Counts> {
  const counts = new Map<string, Counts>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      continue;
    }
    const at = line.indexOf('\t');
    const rest = at < 0 ? '' : line.slice(at + 1);
    const second = rest.indexOf('\t');
    if (at < 0 || second < 0) {
      continue;
    }
    const addedRaw = line.slice(0, at);
    const removedRaw = rest.slice(0, second);
    const path = rest.slice(second + 1);
    if (path === '') {
      continue;
    }
    const num = (value: string): number | null => (/^\d+$/.test(value) ? Number.parseInt(value, 10) : null);
    counts.set(path, { added: num(addedRaw), removed: num(removedRaw) });
  }
  return counts;
}

/** One name-status entry: the letter (a rename/copy score drops its digits) and its path. */
export interface StatusEntry {
  readonly status: string;
  readonly path: string;
}

/**
 * `git diff --name-status` output: `<X>\tpath`, a rename or copy
 * `R100\told\tnew` — the entry keeps the letter and the NEW path.
 */
export function parseNameStatus(text: string): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }
    const status = parts[0]!.replace(/\d+$/, '').trim();
    const path = parts[parts.length - 1]!.trim();
    if (status === '' || path === '') {
      continue;
    }
    statuses.set(path, status);
  }
  return statuses;
}

const addCounts = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a + b;

/**
 * Both passes merged into one list, by path: the working-tree pass wins
 * the status (it is the file's latest state), the line counts sum, a
 * binary side in either pass stays null. Sorted by path, capped at
 * `MAX_WORKTREE_FILES`.
 */
export function mergeWorktreeChanges(
  passes: readonly { readonly numstat: string; readonly nameStatus: string }[],
): WorktreeFile[] {
  const counts = new Map<string, Counts>();
  const statuses = new Map<string, string>();
  for (const pass of passes) {
    for (const [path, entry] of parseNumstat(pass.numstat)) {
      const known = counts.get(path);
      counts.set(
        path,
        known === undefined ? entry : { added: addCounts(known.added, entry.added), removed: addCounts(known.removed, entry.removed) },
      );
    }
    for (const [path, status] of parseNameStatus(pass.nameStatus)) {
      statuses.set(path, status);
    }
  }
  return [...counts.keys()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_WORKTREE_FILES)
    .map((path) => {
      const entry = counts.get(path)!;
      return { status: statuses.get(path) ?? 'M', path, added: entry.added, removed: entry.removed };
    });
}
