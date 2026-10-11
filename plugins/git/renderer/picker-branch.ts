import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { GitBranch } from '../shared/status.js';
import { el, messageOf } from './dom.js';
import type { RepoCommands } from './repo-commands.js';
import { branchOptions, type BranchOption } from './repo-model.js';
import type { RepoSession } from './repo-session.js';

/**
 * The branch picker: a filter field over the branch list. `switch`
 * checks a branch out or creates the typed name; `merge` merges the
 * chosen branch into the current one.
 */
export async function openBranchPicker(
  api: DreyPluginApi,
  session: RepoSession,
  commands: RepoCommands,
  mode: 'switch' | 'merge' = 'switch',
): Promise<void> {
  const vault = session.currentOk();
  if (vault === null || session.state.busy !== null) {
    return;
  }
  const vaultId = vault.vaultId;
  let branches: GitBranch[];
  try {
    branches = (await api.backend.invoke('branches', { vaultId })) as GitBranch[];
  } catch (error) {
    await api.ui.showMessage(messageOf(error), 'Git');
    return;
  }

  const choose = async (branch: BranchOption): Promise<void> => {
    close();
    if ('create' in branch) {
      await session.run('Creating branch…', 'createBranch', { vaultId, name: branch.create });
      return;
    }
    if (mode === 'merge') {
      await commands.mergeBranch(branch.name);
      return;
    }
    if (branch.current || !(await session.cleanTabsOrExplain(vaultId, 'Switching the branch'))) {
      return;
    }
    await session.run('Switching branch…', 'checkout', { vaultId, name: branch.name, remote: branch.remote });
  };

  const close = api.ui.showModal((box) => {
    box.classList.add('git-branches');
    const input = el('input', 'git-branch-filter');
    input.type = 'text';
    input.setAttribute('aria-label', mode === 'merge' ? 'Filter branches to merge' : 'Filter or name a branch');
    const list = el('div', 'git-branch-list');
    list.setAttribute('role', 'listbox');
    box.append(input, list);

    let options: BranchOption[] = [];
    let cursor = 0;
    const render = (): void => {
      options = branchOptions(branches, input.value.trim(), mode);
      cursor = Math.min(cursor, Math.max(0, options.length - 1));
      list.textContent = '';
      if (options.length === 0) {
        list.appendChild(el('p', 'git-empty', 'No branch matches.'));
      }
      options.forEach((option, i) => {
        const row = el('button', 'git-branch');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === cursor));
        row.classList.toggle('on', i === cursor);
        if ('create' in option) {
          row.append(api.ui.icon('plus', 14), el('span', 'name', `Create branch "${option.create}"`));
        } else {
          row.append(api.ui.icon(option.current ? 'check' : 'git-branch', 14), el('span', 'name', option.name));
          if (option.remote) {
            row.appendChild(el('span', 'hint', 'remote'));
          }
        }
        row.addEventListener('click', () => void choose(option));
        list.appendChild(row);
      });
    };
    input.addEventListener('input', () => {
      cursor = 0;
      render();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        cursor = Math.max(0, Math.min(options.length - 1, cursor + step));
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = options[cursor];
        if (option !== undefined) {
          void choose(option);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    render();
    queueMicrotask(() => input.focus());
  });
}
