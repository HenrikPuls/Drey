import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { GitStash } from '../shared/status.js';
import { ask } from './dialogs.js';
import { el, formatWhen, iconButton, messageOf, textButton } from './dom.js';
import type { RepoSession } from './repo-session.js';

/** The stash list: apply-and-remove or delete one stash. */
export async function openStashList(api: DreyPluginApi, session: RepoSession): Promise<void> {
  const vault = session.currentOk();
  if (vault === null || session.state.busy !== null) {
    return;
  }
  const vaultId = vault.vaultId;
  let stashes: GitStash[];
  try {
    stashes = (await api.backend.invoke('stashList', { vaultId, subPath: vault.subPath })) as GitStash[];
  } catch (error) {
    await api.ui.showMessage(messageOf(error), 'Git');
    return;
  }
  if (stashes.length === 0) {
    await api.ui.showMessage('There are no stashes.', 'Stashes');
    return;
  }
  // A repository found by the scan (T-0045) reads the list only —
  // applying or deleting a stash rewrites the tree or the history.
  const readOnly = vault.discovered;
  const close = api.ui.showModal((box) => {
    box.classList.add('git-dialog', 'wide');
    box.append(el('h2', 'git-dialog-title', 'Stashes'));
    const list = el('div', 'git-stash-list');
    for (const stash of stashes) {
      const row = el('div', 'git-stash');
      const text = el('span', 'text');
      text.append(el('span', 'subject', stash.message), el('span', 'meta', formatWhen(stash.date)));
      if (!readOnly) {
        const apply = iconButton(api, 'rotate-ccw', 'Apply and remove this stash', () => {
          close();
          void (async () => {
            if (await session.cleanTabsOrExplain(vaultId, 'Applying a stash')) {
              await session.run('Applying the stash…', 'stashPop', { vaultId, subPath: vault.subPath, index: stash.index });
            }
          })();
        });
        const drop = iconButton(api, 'trash', 'Delete this stash', () => {
          close();
          void (async () => {
            const answer = await ask(api, 'Delete stash', `"${stash.message}" is deleted for good.`, [
              { label: 'Delete', value: 'drop', danger: true },
            ]);
            if (answer !== null) {
              await session.run('Deleting the stash…', 'stashDrop', { vaultId, subPath: vault.subPath, index: stash.index });
            }
          })();
        });
        row.append(text, apply, drop);
      } else {
        row.append(text);
      }
      list.appendChild(row);
    }
    const actions = el('div', 'git-dialog-actions');
    actions.appendChild(textButton('git-btn primary', 'Close', () => close()));
    box.append(list, actions);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
      }
    });
  });
}
