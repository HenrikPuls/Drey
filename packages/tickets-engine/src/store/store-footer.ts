import { defaultGitRun, type GitRun } from './store-git-probe';
import { checkoutOf, type StoreSettings } from './store-settings';

/**
 * The footer line of a dricket board (D-9): where the tickets live and in what
 * state — store, branch, head, and whether the store is local or synced with a
 * remote. Never throws: what git cannot say is left out.
 */
export async function storeFooterLine(settings: StoreSettings, run: GitRun = defaultGitRun): Promise<string> {
  const checkout = checkoutOf(settings);
  const remote = settings.dkCheckout !== '' && settings.dkCheckout !== settings.dkStore;
  const parts: string[] = [`Ticket store ${remote ? (checkout ?? settings.dkStore) : settings.dkStore}`];
  if (checkout !== null) {
    const branch = await probe(run, ['rev-parse', '--abbrev-ref', 'HEAD'], checkout);
    const head = await probe(run, ['rev-parse', '--short', 'HEAD'], checkout);
    if (branch !== null && branch !== '') {
      parts.push(`branch ${branch}`);
    }
    if (head !== null && head !== '') {
      parts.push(`head ${head}`);
    }
  }
  if (!remote) {
    parts.push('local store');
  } else if (settings.dkSyncSeconds > 0) {
    parts.push(`synced every ${settings.dkSyncSeconds} s`);
  } else {
    parts.push('synced on demand');
  }
  return parts.join(' · ');
}

async function probe(run: GitRun, args: readonly string[], cwd: string): Promise<string | null> {
  try {
    return await run(args, cwd);
  } catch {
    return null;
  }
}
