import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { openFileHistory } from './dialog-file-history.js';
import { openStashList } from './dialog-stashes.js';
import { el } from './dom.js';
import { openBranchPicker } from './picker-branch.js';
import type { RepoCommands } from './repo-commands.js';
import type { RepoSession } from './repo-session.js';

interface ActionRow {
  icon: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/** The panel header's "More Git actions" menu: merge, stash, amend, file history. */
export function openRepoActions(api: DreyPluginApi, session: RepoSession, commands: RepoCommands): void {
  const vault = session.currentOk();
  if (vault === null || session.state.busy !== null) {
    return;
  }
  const merging = vault.operation !== null;
  const dirtyTree = vault.status.staged.length + vault.status.unstaged.length > 0;
  const rows: ActionRow[] = [
    {
      icon: 'git-merge',
      label: 'Merge a branch…',
      disabled: merging,
      run: () => void openBranchPicker(api, session, commands, 'merge'),
    },
    {
      icon: 'archive',
      label: 'Stash changes',
      disabled: merging || !dirtyTree,
      run: () => void commands.stashChanges(),
    },
    {
      icon: 'archive',
      label: 'Stashes…',
      hint: vault.stashCount > 0 ? String(vault.stashCount) : undefined,
      disabled: vault.stashCount === 0,
      run: () => void openStashList(api, session),
    },
    {
      icon: 'pencil',
      label: session.state.amend ? 'Stop amending' : 'Amend the last commit',
      disabled: merging,
      run: () => void commands.toggleAmend(),
    },
    { icon: 'history', label: 'Git history of this file…', run: () => void openFileHistory(api, session) },
  ];
  const close = api.ui.showModal((box) => {
    box.classList.add('git-branches');
    const list = el('div', 'git-branch-list');
    list.setAttribute('role', 'menu');
    for (const item of rows) {
      const row = el('button', 'git-branch');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.disabled = item.disabled === true;
      row.append(api.ui.icon(item.icon, 14), el('span', 'name', item.label));
      if (item.hint !== undefined) {
        row.appendChild(el('span', 'hint', item.hint));
      }
      row.addEventListener('click', () => {
        close();
        item.run();
      });
      list.appendChild(row);
    }
    box.appendChild(list);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
      }
    });
    queueMicrotask(() => (list.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus());
  });
}
