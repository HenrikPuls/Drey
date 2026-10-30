/**
 * The "Source control" dock widget: the header buttons, the repository
 * line, the busy line, the merge / amend banner, the commit box, the
 * change lists and the history. It draws the session's state and hands
 * every click to a command.
 */
import type { DreyPluginApi, PluginWidgetContrib } from '../../../shared/plugin-api/renderer';
import { changeCount, describeKind, type GitChange } from '../shared/status.js';
import { el, formatWhen, iconButton } from './dom.js';
import { openRepoActions } from './menu-actions.js';
import { openBranchPicker } from './picker-branch.js';
import type { RepoCommands } from './repo-commands.js';
import {
  branchLabel,
  branchTooltip,
  commitButtonLabel,
  counted,
  keyOf,
  pullButtonLabel,
  pushButtonLabel,
  pushCommitButtonLabel,
  repoLabel,
  syncBadge,
  type Group,
  type OkVault,
} from './repo-model.js';
import type { RepoSession } from './repo-session.js';

function setLabel(button: HTMLButtonElement, text: string): void {
  button.title = text;
  button.setAttribute('aria-label', text);
}

export function createSourceControlWidget(
  api: DreyPluginApi,
  session: RepoSession,
  commands: RepoCommands,
): PluginWidgetContrib {
  const { state } = session;
  const icon = (name: string, label: string, onClick: () => void): HTMLButtonElement =>
    iconButton(api, name, label, onClick);

  const changeRow = (change: GitChange, group: Group, vault: OkVault): HTMLElement => {
    const { badge, tone, label } = describeKind(change.kind);
    const { vaultId, managedBy, discovered } = vault;
    const managed = managedBy !== null;
    const row = el('div', 'git-change');
    row.dataset['status'] = tone;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const slash = change.path.lastIndexOf('/');
    row.title = `${change.path} — ${label}`;
    row.append(el('span', 'name', change.path.slice(slash + 1)));
    if (slash > 0) {
      row.appendChild(el('span', 'dir', change.path.slice(0, slash)));
    }
    const actions = el('span', 'actions');
    if (change.kind !== 'deleted') {
      actions.appendChild(
        icon('file-text', 'Open file', () => void api.documents.open(change.path, undefined, { vaultId })),
      );
    }
    // A repository found by the scan keeps its read surface only: the
    // row's action buttons stay away (click-to-diff and the dialogs
    // still work); "Register as vault" is the way to work rights.
    if (!discovered) {
      if (group === 'conflicts') {
        actions.append(
          icon('arrow-left', 'Keep mine (current branch)', () => void commands.resolveConflict(change, 'ours')),
          icon('arrow-right', 'Keep theirs (incoming)', () => void commands.resolveConflict(change, 'theirs')),
        );
      }
      if (group === 'changes') {
        const discardButton = icon('rotate-ccw', 'Discard changes', () => void commands.discard(change));
        discardButton.disabled = managed;
        actions.appendChild(discardButton);
      }
      if (group === 'staged') {
        actions.appendChild(
          icon('minus', 'Unstage', () =>
            void session.run('Unstaging…', 'unstage', { vaultId, subPath: vault.subPath, paths: [change.path] }),
          ),
        );
      } else {
        // Staging (and resolving = staging) is refused for a plugin-managed vault.
        const stageButton = icon(
          'plus',
          group === 'conflicts' ? 'Mark as resolved (stage)' : 'Stage',
          () => void session.run('Staging…', 'stage', { vaultId, subPath: vault.subPath, paths: [change.path] }),
        );
        stageButton.disabled = managed;
        actions.appendChild(stageButton);
      }
    }
    row.append(actions, el('span', 'badge', badge));
    const open = (): void => void commands.showDiff(change, group);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        open();
      }
    });
    return row;
  };

  /** One titled list of changes; nothing at all when the list is empty. */
  const appendGroup = (
    list: HTMLElement,
    title: string,
    changes: readonly GitChange[],
    group: Group,
    vault: OkVault,
    action?: HTMLButtonElement,
  ): void => {
    if (changes.length === 0) {
      return;
    }
    const header = el('div', 'git-group');
    header.append(el('span', 'title', title), el('span', 'count', String(changes.length)));
    if (action !== undefined) {
      action.disabled = vault.managedBy !== null;
      header.appendChild(action);
    }
    list.appendChild(header);
    for (const change of changes) {
      list.appendChild(changeRow(change, group, vault));
    }
  };

  /** Repository line: which repository (a select once there are several) and its branch. */
  const renderHead = (head: HTMLElement, vault: OkVault | null): void => {
    head.textContent = '';
    const repos = session.okVaults();
    if (repos.length > 1 && vault !== null) {
      const select = el('select', 'git-repo');
      select.setAttribute('aria-label', 'Repository');
      for (const repo of repos) {
        const option = el('option', undefined, repoLabel(repo, state.names.get(repo.vaultId)));
        option.value = keyOf(repo);
        option.selected = keyOf(repo) === keyOf(vault);
        option.title = repo.root;
        select.appendChild(option);
      }
      select.addEventListener('change', () => session.select(select.value));
      head.appendChild(select);
    }
    if (vault !== null) {
      const { branch, head: commitId, ahead, behind } = vault.status;
      const button = el('button', 'git-branch-btn');
      button.type = 'button';
      button.title = branchTooltip(vault, formatWhen);
      button.setAttribute('aria-label', 'Switch branch');
      // Switching rewrites the working tree — refused for a repository
      // found by the scan, so the button does not offer it either.
      button.disabled = state.busy !== null || vault.operation !== null || vault.discovered;
      button.append(api.ui.icon('git-branch', 14), el('span', 'name', branchLabel(branch, commitId)));
      const sync = syncBadge(ahead, behind);
      if (sync !== '') {
        button.appendChild(el('span', 'sync', sync));
      }
      button.addEventListener('click', () => void openBranchPicker(api, session, commands));
      head.appendChild(button);
    }
  };

  const renderBusy = (busy: HTMLElement): void => {
    busy.textContent = '';
    busy.hidden = state.busy === null;
    if (state.busy !== null) {
      busy.appendChild(el('span', 'label', state.busy));
      if (state.cancellable && state.current !== null) {
        const vaultId = state.current;
        const cancel = el('button', 'git-link', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', () => void api.backend.invoke('cancel', { vaultId }));
        busy.appendChild(cancel);
      }
    }
  };

  /** A banner above the commit box: the merge in progress, or amend mode. */
  const renderBanner = (banner: HTMLElement, vault: OkVault | null): void => {
    banner.textContent = '';
    banner.hidden = true;
    if (vault === null) {
      return;
    }
    if (vault.operation !== null) {
      const conflictsLeft = vault.status.conflicts.length;
      banner.hidden = false;
      banner.className = 'git-banner git-merge';
      const alert = api.ui.icon('triangle-alert', 14);
      alert.classList.add('alert');
      const text = el('span', 'text');
      text.append(
        el('span', undefined, vault.operation.source === null ? 'Merging' : `Merging ${vault.operation.source}`),
        el(
          'span',
          'sub',
          conflictsLeft > 0
            ? `${counted(conflictsLeft, 'conflict')} left`
            : 'No conflicts left. Commit to complete the merge.',
        ),
      );
      banner.append(alert, text, icon('x', 'Abort the merge', () => void commands.abortMerge()));
    } else if (vault.managedBy !== null) {
      // SDK 1.32 plugin-managed vault: fully visible, read-only — the
      // managing plugin writes the history through its own flows.
      banner.hidden = false;
      banner.className = 'git-banner git-managed';
      const text = el('span', 'text');
      text.append(
        el('span', undefined, `Managed by ${vault.managedBy}`),
        el('span', 'sub', 'Read-only — this repository\'s history is written by the plugin.'),
      );
      banner.append(api.ui.icon('lock', 14), text);
    } else if (state.amend) {
      banner.hidden = false;
      banner.className = 'git-banner git-amend';
      const text = el('span', 'text');
      text.append(
        el('span', undefined, 'Amending the last commit'),
        el('span', 'sub', 'Staged changes and this message replace it.'),
      );
      banner.append(api.ui.icon('pencil', 14), text, icon('x', 'Stop amending', () => void commands.toggleAmend()));
    }
  };

  const renderHistory = (list: HTMLElement): void => {
    const history = el('button', 'git-group git-history');
    history.type = 'button';
    history.setAttribute('aria-expanded', String(state.historyOpen));
    const twist = api.ui.icon('chevron-right', 14);
    twist.classList.add('twist');
    history.append(twist, el('span', 'title', 'History'));
    history.addEventListener('click', () => {
      state.historyOpen = !state.historyOpen;
      session.notify();
      void session.loadLog();
    });
    list.appendChild(history);
    if (!state.historyOpen) {
      return;
    }
    if (state.log.length === 0) {
      list.appendChild(el('p', 'git-empty', 'No commits yet.'));
    }
    for (const entry of state.log) {
      const row = el('div', 'git-commit');
      row.title = `${entry.hash} — ${entry.subject}`;
      const meta = el('span', 'meta', `${entry.author} · ${formatWhen(entry.date)} · ${entry.hash}`);
      if (entry.unpushed === true) {
        meta.append(' · ', el('span', 'unpushed', '↑ not pushed'));
      }
      row.append(el('span', 'subject', entry.subject), meta);
      list.appendChild(row);
    }
  };

  const renderList = (list: HTMLElement, vault: OkVault | null): void => {
    list.textContent = '';
    if (vault === null) {
      const found = session.currentState();
      list.appendChild(
        el(
          'p',
          'git-empty',
          found === null
            ? 'No vault is open.'
            : found.state === 'no-git'
              ? 'git was not found. Install Git or set its path in Settings → Git.'
              : 'This vault is not a Git repository.',
        ),
      );
      return;
    }
    const vaultId = vault.vaultId;
    const { staged, unstaged, conflicts } = vault.status;
    if (vault.discovered) {
      // Read-only by construction (T-0045): one click registers the
      // folder as its own vault, and the refresh round that follows
      // makes the panel swap this entry for the vault's own one.
      const hint = el('div', 'git-group git-found');
      hint.append(
        el('span', 'title', `Found by scanning ${state.names.get(vaultId) ?? vaultId} — read-only`),
      );
      const register = el('button', 'git-link', 'Register as vault');
      register.type = 'button';
      register.title = vault.root;
      register.addEventListener('click', () =>
        void session.run('Registering…', 'registerVault', { path: vault.root }),
      );
      hint.appendChild(register);
      list.appendChild(hint);
    }
    appendGroup(list, 'Merge conflicts', conflicts, 'conflicts', vault);
    appendGroup(
      list,
      'Staged changes',
      staged,
      'staged',
      vault,
      vault.discovered
        ? undefined
        : icon('minus', 'Unstage all', () =>
            void session.run('Unstaging…', 'unstage', { vaultId, subPath: vault.subPath, paths: [] }),
          ),
    );
    appendGroup(
      list,
      'Changes',
      unstaged,
      'changes',
      vault,
      vault.discovered
        ? undefined
        : icon('plus', 'Stage all changes', () =>
            void session.run('Staging…', 'stage', { vaultId, subPath: vault.subPath, paths: [] }),
          ),
    );
    if (staged.length + unstaged.length + conflicts.length === 0) {
      list.appendChild(el('p', 'git-empty', 'No changes.'));
    }
    renderHistory(list);
  };

  return {
    id: 'git',
    title: 'Source control',
    icon: 'git-branch',
    defaultDock: 'left',
    defaultOpen: false,
    defaultFlex: 260,
    flush: true,
    status: () => {
      const vault = session.currentOk();
      const count = vault === null ? 0 : changeCount(vault.status);
      return count > 0 ? String(count) : null;
    },
    headerActions: (host) => {
      const fetchButton = icon('download', 'Fetch from the remote', () => void commands.remote('Fetching…', 'fetch'));
      const pullButton = icon('arrow-down', 'Pull', () => void commands.remote('Pulling…', 'pull'));
      const pushButton = icon('arrow-up', 'Push', () => void commands.remote('Pushing…', 'push'));
      const moreButton = icon('more-horizontal', 'More Git actions', () => openRepoActions(api, session, commands));
      const buttons = [fetchButton, pullButton, pushButton, moreButton];
      const refresh = icon('refresh-cw', 'Refresh the status', () => void session.pull('relocate'));
      const render = (): void => {
        const vault = session.currentOk();
        const off = vault === null || state.busy !== null;
        // A plugin-managed vault (SDK 1.32) refuses pull and push main-side;
        // fetch stays — it changes nothing in the working tree. A
        // repository found by the scan (T-0045) refuses all three.
        const managed = vault !== null && vault.managedBy !== null;
        const found = vault !== null && vault.discovered;
        for (const button of buttons) {
          button.disabled = off;
        }
        fetchButton.disabled = off || managed || found;
        pullButton.disabled = off || managed || found;
        pushButton.disabled = off || managed || found;
        setLabel(pullButton, pullButtonLabel(vault?.status.behind ?? 0));
        setLabel(pushButton, pushButtonLabel(vault?.status.ahead ?? 0));
      };
      host.append(...buttons, refresh);
      render();
      return session.subscribe(render);
    },
    mount: (body) => {
      body.classList.add('git-panel');
      const head = el('div', 'git-head');
      const busy = el('div', 'git-busy');
      const compose = el('div', 'git-compose');
      const message = el('textarea', 'git-message');
      message.rows = 2;
      message.setAttribute('aria-label', 'Commit message');
      message.spellcheck = true;
      const commitButton = icon('check', 'Commit staged changes (Ctrl+Enter)', () => void commands.commit());
      const pushCommitButton = icon('upload', 'Commit and push (Ctrl+Shift+Enter)', () => void commands.commit(true));
      compose.append(message, commitButton, pushCommitButton);
      const banner = el('div', 'git-banner');
      const list = el('div', 'git-list');
      body.append(head, busy, banner, compose, list);

      message.addEventListener('input', () => {
        if (state.current !== null) {
          state.drafts.set(state.current, message.value);
        }
      });
      message.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void commands.commit(event.shiftKey);
        }
      });

      const renderCompose = (vault: OkVault | null): void => {
        const merging = vault !== null && vault.operation !== null;
        const amending = vault !== null && state.amend && !merging;
        const conflictsLeft = vault === null ? 0 : vault.status.conflicts.length;
        // No commit box for a repository found by the scan (T-0045):
        // there is nothing it could honestly send.
        compose.hidden = vault === null || vault.discovered;
        const draft = vault === null ? '' : (state.drafts.get(keyOf(vault)) ?? '');
        if (message.value !== draft) {
          message.value = draft;
        }
        // The commit box is inert for a plugin-managed vault: main refuses
        // the commit anyway, an empty box says why the buttons are off.
        const managed = vault !== null && vault.managedBy !== null;
        message.disabled = managed;
        const blocked = managed || state.busy !== null || (merging && conflictsLeft > 0);
        commitButton.disabled = blocked;
        pushCommitButton.disabled = blocked;
        setLabel(commitButton, commitButtonLabel(merging, amending, conflictsLeft));
        setLabel(pushCommitButton, pushCommitButtonLabel(merging, amending));
      };

      const render = (): void => {
        const vault = session.currentOk();
        renderHead(head, vault);
        renderBusy(busy);
        renderBanner(banner, vault);
        renderCompose(vault);
        renderList(list, vault);
      };

      render();
      return session.subscribe(render);
    },
  };
}
