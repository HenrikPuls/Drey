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

/** One file's unified diff as the proof card renders it (E5c). */
export interface DiffFile {
  /** The git status letter (A/M/D/R…). */
  readonly status: string;
  readonly path: string;
  /** The unified patch (`@@ …` hunks included); '' for binary files. */
  readonly patch: string;
}

export interface TicketDiff {
  readonly files: readonly DiffFile[];
  /** True when the caps cut content — the card says so honestly. */
  readonly truncated: boolean;
}

/** One file as it stands on the ticket branch (E11-2, the "Whole file" view). */
export type TicketFileReply =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly error: string };

/** The whole-file view stops here; a bigger file shows its head and says so. */
export const MAX_FILE_VIEW_BYTES = 200 * 1024;

/**
 * A repo-relative path the file route may hand to `git show HEAD:<path>`:
 * no empty or absolute path, no `..` segment, no backslash, colon or NUL
 * (git would read a colon as a revision separator).
 */
export function isSafeRepoPath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !/[\\:\0]/.test(path) &&
    !path.split('/').some((segment) => segment === '..' || segment === '')
  );
}

/** The caps keep one diff phone-sized and the route's body bounded. */
export const MAX_DIFF_FILES = 20;
export const MAX_DIFF_PATCH_BYTES = 24 * 1024;
export const MAX_DIFF_TOTAL_BYTES = 200 * 1024;

/**
 * Splits `git diff --unified=3 <base>...HEAD` into per-file patches
 * (pure, no git). Status comes from the file's header lines; binary
 * files keep an empty patch. Output order is the diff's order; the caps
 * cut at the file boundary and mark the result truncated.
 */
export function parseUnifiedDiff(text: string, caps: { maxFiles: number; maxPatchBytes: number; maxTotalBytes: number }): TicketDiff {
  const files: DiffFile[] = [];
  let truncated = false;
  let current: { status: string; path: string; lines: string[] } | null = null;
  let total = 0;
  const flush = (): void => {
    if (current === null) {
      return;
    }
    files.push({ status: current.status, path: current.path, patch: current.lines.join('\n') });
    total += current.lines.join('\n').length;
    current = null;
  };
  const header = /^diff --git a\/(.+) b\/(.+)$/;
  for (const line of text.split('\n')) {
    const start = header.exec(line);
    if (start !== null) {
      flush();
      if (files.length >= caps.maxFiles || total >= caps.maxTotalBytes) {
        truncated = true;
        break;
      }
      current = { status: 'M', path: start[2]!, lines: [line] };
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith('new file mode')) {
      current.status = 'A';
    } else if (line.startsWith('deleted file mode')) {
      current.status = 'D';
    } else if (line.startsWith('rename to ')) {
      current.status = 'R';
      current.path = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.lines.push(line);
    }
    const projected = current.lines.join('\n').length + line.length + 1;
    if (projected > caps.maxPatchBytes) {
      truncated = true;
      continue; // skip the overflow within this file, keep the file itself
    }
    current.lines.push(line);
  }
  flush();
  return { files, truncated };
}

/** The board service's diff run: one git call, capped parsing (E5c). */
export function diffOfOutput(gitDiff: string): TicketDiff {
  return parseUnifiedDiff(gitDiff, { maxFiles: MAX_DIFF_FILES, maxPatchBytes: MAX_DIFF_PATCH_BYTES, maxTotalBytes: MAX_DIFF_TOTAL_BYTES });
}
