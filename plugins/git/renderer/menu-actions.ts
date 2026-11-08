import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { openFileHistory } from './dialog-file-history.js';
import { openStashList } from './dialog-stashes.js';
import { openDropdown, type DropdownEntry } from './dropdown.js';
import { openBranchPicker } from './picker-branch.js';
import type { RepoCommands } from './repo-commands.js';
import { pushCommitMenuLabel } from './repo-model.js';
import type { RepoSession } from './repo-session.js';

/**
 * The panel header's "More Git actions" menu (board 9d, in its order):
 * Fetch · Commit and push | Merge · Stash · Stashes · Amend | File history
 * · Refresh.
 */
export function openRepoActions(
  api: DreyPluginApi,
  session: RepoSession,
  commands: RepoCommands,
  anchor: HTMLElement,
): void {
  if (session.state.busy !== null) {
    return;
  }
  const t = api.i18n.t.bind(api.i18n);
  const refresh: DropdownEntry = { label: t('git.menu.refresh'), run: () => void session.pull('relocate') };
  const vault = session.currentOk();
  if (vault === null) {
    // No repository shown (yet): Refresh is the one way to look again
    // for a repository that was created after the start.
    openDropdown(anchor, t('git.more'), [refresh], () => api.ui.icon('check', 14), 284);
    return;
  }
  const merging = vault.operation !== null;
  const amending = session.state.amend && !merging;
  const dirtyTree = vault.status.staged.length + vault.status.unstaged.length > 0;
  // A repository found by the scan (T-0045) offers the read rows only:
  // fetch, commit, merge, stash and amend change the repository and are
  // refused main-side; the stash list and the file history stay (they
  // read). A plugin-managed vault (SDK 1.32) keeps fetch only — it
  // changes nothing in the working tree.
  const found = vault.discovered;
  const managed = vault.managedBy !== null;
  const conflictsLeft = vault.status.conflicts.length;
  const entries: DropdownEntry[] = [
    {
      label: t('git.menu.fetch'),
      disabled: found,
      run: () => void commands.remote(t('git.busy.fetching'), 'fetch'),
    },
    {
      label: pushCommitMenuLabel(api.i18n, merging, amending),
      hint: t('git.menu.commit_push.keys'),
      disabled: found || managed || (merging && conflictsLeft > 0),
      run: () => void commands.commit(true),
    },
    'separator',
    {
      label: t('git.menu.merge'),
      disabled: merging || found,
      run: () => void openBranchPicker(api, session, commands, 'merge'),
    },
    {
      label: t('git.menu.stash'),
      disabled: merging || !dirtyTree || found,
      run: () => void commands.stashChanges(),
    },
    {
      label: t('git.menu.stashes'),
      hint: vault.stashCount > 0 ? api.i18n.formatNumber(vault.stashCount) : undefined,
      disabled: vault.stashCount === 0,
      run: () => void openStashList(api, session),
    },
    {
      label: t(session.state.amend ? 'git.menu.stop_amend' : 'git.menu.amend'),
      disabled: merging || found,
      run: () => void commands.toggleAmend(),
    },
    'separator',
    { label: t('git.menu.file_history'), run: () => void openFileHistory(api, session) },
    refresh,
  ];
  openDropdown(anchor, t('git.more'), entries, () => api.ui.icon('check', 14), 284);
}
