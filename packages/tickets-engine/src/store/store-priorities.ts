import type { PriorityConfig } from '../contracts/tickets';
import { defaultGitRun, type GitRun } from './store-git-probe';

/**
 * A dricket store's priority vocabulary (D-11): `[priorities]` of `dricket.toml`,
 * which lives on the store's `main` branch, not on the ticket branch. On a dricket
 * board this is the vocabulary (dk refuses every other value), whatever
 * `pipeline.md` says. Read only: the file belongs to the store's admins.
 */

/** dk's starting set: what applies without a `[priorities]` table (dricket ADR-0005). */
export const DK_STARTING_PRIORITIES: PriorityConfig = { order: ['critical', 'high', 'normal', 'low'], default: 'normal' };

const stripComment = (line: string): string => {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      quoted = !quoted;
    } else if (line[i] === '#' && !quoted) {
      return line.slice(0, i);
    }
  }
  return line;
};

/** The vocabulary of a `dricket.toml` text; dk's starting set when it has no usable `[priorities]` table. */
export function parseStorePriorities(toml: string): PriorityConfig {
  const lines = toml.split(/\r?\n/).map(stripComment);
  const start = lines.findIndex((line) => line.trim() === '[priorities]');
  if (start === -1) {
    return DK_STARTING_PRIORITIES;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*\[[^\]"]*\]\s*$/.test(line));
  const table = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  const values = /(?:^|\n)\s*values\s*=\s*\[([^\]]*)\]/.exec(table)?.[1];
  const order = [...(values ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  if (order.length === 0) {
    return DK_STARTING_PRIORITIES;
  }
  const fallback = /(?:^|\n)\s*default\s*=\s*"([^"]+)"/.exec(table)?.[1];
  return { order, default: fallback !== undefined && order.includes(fallback) ? fallback : order[0]! };
}

/** Where dk finds the config: its private ref of a remote store, the local `main`, the checkout's remote branch. */
const CONFIG_REFS = ['refs/dricket/config', 'main', 'origin/main'] as const;

/** The store's vocabulary, or null when no ref holds a `dricket.toml` (unknown: the caller keeps what it has). */
export async function readStorePriorities(checkout: string, run: GitRun = defaultGitRun): Promise<PriorityConfig | null> {
  for (const ref of CONFIG_REFS) {
    try {
      return parseStorePriorities(await run(['show', `${ref}:dricket.toml`], checkout));
    } catch {
      // Not this ref: the next one, then "unknown".
    }
  }
  return null;
}
