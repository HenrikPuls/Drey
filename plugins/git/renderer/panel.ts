/**
 * The "Source control" dock widget (board 9d, req-162): the header
 * buttons, the branch line, the busy line, the merge / amend / managed
 * banner, the commit field, the change groups and the history. It draws
 * the session's state and hands every click to a command.
 */
import type { DreyPluginApi, PluginWidgetContrib } from '../../../shared/plugin-api/renderer';
import { changeCount, describeKind, type GitChange } from '../shared/status.js';
import { el, formatWhen, iconButton } from './dom.js';
import { openDropdown } from './dropdown.js';
import { createFoldStore } from './fold-store.js';
import { openRepoActions } from './menu-actions.js';
import { openBranchPicker } from './picker-branch.js';
import type { RepoCommands } from './repo-commands.js';
import {
  branchLabel,
  branchTooltip,
  changeTitle,
  commitButtonLabel,
  commitWhen,
  distanceText,
  keyOf,
  pullButtonLabel,
  pushButtonLabel,
  repoLabel,
  syncText,
  type Group,
  type OkVault,
} from './repo-model.js';
import type { RepoSession } from './repo-session.js';

function setLabel(button: HTMLElement, text: string): void {
  button.title = text;
  button.setAttribute('aria-label', text);
}

/** The renderer's storage; null where it is blocked (the folds then last for the session). */
function storageOf(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The commit field grows by one line per line of text, up to this many. */
const MAX_LINES = 12;
const LINE_PX = 20;

export function createSourceControlWidget(
  api: DreyPluginApi,
  session: RepoSession,
  commands: RepoCommands,
): PluginWidgetContrib {
  const { state } = session;
  const t = api.i18n.t.bind(api.i18n);
  const icon = (name: string, label: string, onClick: () => void): HTMLButtonElement =>
    iconButton(api, name, label, onClick);
  /** Which groups are folded, per repository, kept across repaints and restarts. */
  const folds = createFoldStore(storageOf());
  /** The repository whose history was asked for after a start with History open. */
  let logAskedFor: string | null = null;

  const changeRow = (change: GitChange, group: Group, vault: OkVault): HTMLElement => {
    const { badge, tone } = describeKind(change.kind);
    const { vaultId, managedBy, discovered } = vault;
    const managed = managedBy !== null;
    const row = el('div', 'git-change');
    row.dataset['status'] = tone;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const slash = change.path.lastIndexOf('/');
    row.title = changeTitle(api.i18n, change.path, change.kind);
    row.append(el('span', 'name', change.path.slice(slash + 1)));
    row.appendChild(el('span', 'dir', slash > 0 ? change.path.slice(0, slash) : ''));
    const actions = el('span', 'actions');
    if (change.kind !== 'deleted') {
      actions.appendChild(
        icon('file-text', t('git.row.open'), () => void api.documents.open(change.path, undefined, { vaultId })),
      );
    }
    // A repository found by the scan keeps its read surface only: the
    // row's action buttons stay away (click-to-diff and the dialogs
    // still work); "Register as vault" is the way to work rights.
    if (!discovered) {
      if (group === 'conflicts') {
        actions.append(
          icon('arrow-left', t('git.row.keep_mine'), () => void commands.resolveConflict(change, 'ours')),
          icon('arrow-right', t('git.row.keep_theirs'), () => void commands.resolveConflict(change, 'theirs')),
        );
      }
      if (group === 'changes') {
        const discardButton = icon('rotate-ccw', t('git.row.discard'), () => void commands.discard(change));
        discardButton.disabled = managed;
        actions.appendChild(discardButton);
      }
      if (group === 'staged') {
        actions.appendChild(
          icon('minus', t('git.row.unstage'), () =>
            void session.run(t('git.busy.unstaging'), 'unstage', { vaultId, subPath: vault.subPath, paths: [change.path] }),
          ),
        );
      } else {
        // Staging (and resolving = staging) is refused for a plugin-managed vault.
        const stageButton = icon(
          'plus',
          t(group === 'conflicts' ? 'git.row.mark_resolved' : 'git.row.stage'),
          () => void session.run(t('git.busy.staging'), 'stage', { vaultId, subPath: vault.subPath, paths: [change.path] }),
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

  /**
   * A group head (board 9d, the Find group head): fold chevron + name,
   * the bulk action on hover, the count right.
   */
  const groupHead = (
    title: string,
    open: boolean,
    onToggle: () => void,
    count: number | null,
    action?: HTMLButtonElement,
  ): HTMLElement => {
    const head = el('div', 'git-group');
    const fold = el('button', 'fold');
    fold.type = 'button';
    fold.setAttribute('aria-expanded', String(open));
    fold.append(api.ui.icon(open ? 'chevron-down' : 'chevron-right', 14), el('span', 'title', title));
    fold.addEventListener('click', onToggle);
    head.appendChild(fold);
    if (action !== undefined) {
      const actions = el('span', 'actions');
      actions.appendChild(action);
      head.appendChild(actions);
    }
    if (count !== null) {
      head.appendChild(el('span', 'count', api.i18n.formatNumber(count)));
    }
    return head;
  };

  /** One titled group of changes; nothing at all when the group is empty. */
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
    if (action !== undefined) {
      action.disabled = vault.managedBy !== null;
    }
    const repo = keyOf(vault);
    const open = folds.isOpen(repo, group);
    list.appendChild(
      groupHead(
        title,
        open,
        () => {
          folds.setOpen(repo, group, !open);
          session.notify();
        },
        changes.length,
        action,
      ),
    );
    if (!open) {
      return;
    }
    for (const change of changes) {
      list.appendChild(changeRow(change, group, vault));
    }
  };

  /** A repository menu: the shown one checked (board 9d: only when there are several). */
  const openRepoMenu = (anchor: HTMLElement, vault: OkVault): void => {
    const entries = session.okVaults().map((repo) => ({
      label: repoLabel(repo, state.names.get(repo.vaultId)),
      checked: keyOf(repo) === keyOf(vault),
      run: () => session.select(keyOf(repo)),
    }));
    openDropdown(anchor, t('git.repository'), entries, () => api.ui.icon('check', 14));
  };

  /** The branch line: repository (several only), branch, and the distance or "Not published". */
  const renderHead = (head: HTMLElement, vault: OkVault | null): void => {
    head.textContent = '';
    head.hidden = vault === null;
    if (vault === null) {
      return;
    }
    const repos = session.okVaults();
    if (repos.length > 1) {
      const repo = el('button', 'git-line-btn git-repo');
      repo.type = 'button';
      repo.setAttribute('aria-label', t('git.repository'));
      repo.setAttribute('aria-haspopup', 'menu');
      repo.title = vault.root;
      repo.append(el('span', 'name', repoLabel(vault, state.names.get(vault.vaultId))), api.ui.icon('chevron-down', 12));
      repo.addEventListener('click', () => openRepoMenu(repo, vault));
      head.appendChild(repo);
    }
    const { branch, head: commitId } = vault.status;
    const button = el('button', 'git-line-btn git-branch-btn');
    button.type = 'button';
    button.title = branchTooltip(api.i18n, vault, formatWhen);
    button.setAttribute('aria-label', t('git.branch.switch'));
    // Switching rewrites the working tree — refused for a repository
    // found by the scan, so the button does not offer it either.
    button.disabled = state.busy !== null || vault.operation !== null || vault.discovered;
    button.append(api.ui.icon('git-branch', 14), el('span', 'name', branchLabel(api.i18n, branch, commitId)));
    button.addEventListener('click', () => void openBranchPicker(api, session, commands));
    head.appendChild(button);
    const sync = syncText(api.i18n, vault);
    if (sync !== '') {
      const badge = el('span', 'sync', sync);
      const { ahead, behind, upstream } = vault.status;
      badge.title = upstream === null ? t('git.branch.not_published_yet') : distanceText(api.i18n, ahead, behind);
      head.appendChild(badge);
    }
  };

  const renderBusy = (busy: HTMLElement): void => {
    busy.textContent = '';
    busy.hidden = state.busy === null;
    if (state.busy !== null) {
      busy.appendChild(el('span', 'label', state.busy));
      if (state.cancellable && state.current !== null) {
        const vaultId = state.current;
        const cancel = el('button', 'git-link', t('git.busy.cancel'));
        cancel.type = 'button';
        cancel.addEventListener('click', () => void api.backend.invoke('cancel', { vaultId }));
        busy.appendChild(cancel);
      }
    }
  };

  const bannerText = (title: string, sub: string): HTMLElement => {
    const text = el('span', 'text');
    text.append(el('span', 'title', title), el('span', 'sub', sub));
    return text;
  };

  /** A banner above the commit field: the merge in progress, a managed vault, or amend mode. */
  const renderBanner = (banner: HTMLElement, vault: OkVault | null): void => {
    banner.textContent = '';
    banner.hidden = true;
    banner.className = 'git-banner';
    if (vault === null) {
      return;
    }
    if (vault.operation !== null) {
      const conflictsLeft = vault.status.conflicts.length;
      banner.hidden = false;
      banner.classList.add('git-merge');
      banner.append(
        api.ui.icon('triangle-alert', 16),
        bannerText(
          vault.operation.source === null
            ? t('git.banner.merging')
            : t('git.banner.merging_source', { source: vault.operation.source }),
          conflictsLeft > 0
            ? t('git.banner.conflicts_left', { count: conflictsLeft })
            : t('git.banner.no_conflicts'),
        ),
        icon('x', t('git.banner.abort'), () => void commands.abortMerge()),
      );
    } else if (vault.managedBy !== null) {
      // SDK 1.32 plugin-managed vault: fully visible, read-only — the
      // managing plugin writes the history through its own flows.
      banner.hidden = false;
      banner.classList.add('git-managed');
      banner.append(
        api.ui.icon('lock', 16),
        bannerText(t('git.banner.managed', { plugin: vault.managedBy }), t('git.banner.managed_sub')),
      );
    } else if (state.amend) {
      banner.hidden = false;
      banner.classList.add('git-amend');
      banner.append(
        api.ui.icon('pencil', 16),
        bannerText(t('git.banner.amend'), t('git.banner.amend_sub')),
        icon('x', t('git.banner.stop_amend'), () => void commands.toggleAmend()),
      );
    }
  };

  const renderHistory = (list: HTMLElement, vault: OkVault): void => {
    const repo = keyOf(vault);
    const open = folds.isOpen(repo, 'history');
    if (state.historyOpen !== open) {
      state.historyOpen = open;
    }
    if (open && logAskedFor !== repo) {
      // History was left open (a restart, another repository): ask once.
      logAskedFor = repo;
      void session.loadLog();
    }
    const head = groupHead(
      t('git.group.history'),
      open,
      () => {
        folds.setOpen(repo, 'history', !open);
        state.historyOpen = !open;
        logAskedFor = repo;
        session.notify();
        void session.loadLog();
      },
      null,
    );
    head.classList.add('git-history');
    list.appendChild(head);
    if (!state.historyOpen) {
      return;
    }
    if (state.log.length === 0) {
      list.appendChild(el('p', 'git-empty', t('git.history.empty')));
    }
    const now = new Date();
    for (const entry of state.log) {
      const row = el('div', 'git-log-row');
      row.title = t('git.history.title', { hash: entry.hash, subject: entry.subject });
      const meta = el(
        'span',
        'meta',
        t('git.history.meta', { author: entry.author, when: commitWhen(api.i18n, entry.date, now), hash: entry.hash }),
      );
      if (entry.unpushed === true) {
        meta.append(el('span', 'sep', ' · '), el('span', 'unpushed', t('git.history.not_pushed')));
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
          t(found === null ? 'git.empty.no_vault' : found.state === 'no-git' ? 'git.empty.no_git' : 'git.empty.not_repo'),
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
      const hint = el('div', 'git-found');
      hint.append(el('span', 'title', t('git.found', { vault: state.names.get(vaultId) ?? vaultId })));
      const register = el('button', 'git-link', t('git.found.register'));
      register.type = 'button';
      register.title = vault.root;
      register.addEventListener('click', () =>
        void session.run(t('git.busy.registering'), 'registerVault', { path: vault.root }),
      );
      hint.appendChild(register);
      list.appendChild(hint);
    }
    appendGroup(list, t('git.group.conflicts'), conflicts, 'conflicts', vault);
    appendGroup(
      list,
      t('git.group.staged'),
      staged,
      'staged',
      vault,
      vault.discovered
        ? undefined
        : icon('minus', t('git.group.unstage_all'), () =>
            void session.run(t('git.busy.unstaging'), 'unstage', { vaultId, subPath: vault.subPath, paths: [] }),
          ),
    );
    appendGroup(
      list,
      t('git.group.changes'),
      unstaged,
      'changes',
      vault,
      vault.discovered
        ? undefined
        : icon('plus', t('git.group.stage_all'), () =>
            void session.run(t('git.busy.staging'), 'stage', { vaultId, subPath: vault.subPath, paths: [] }),
          ),
    );
    if (staged.length + unstaged.length + conflicts.length === 0) {
      list.appendChild(el('p', 'git-empty git-clean', t('git.empty.no_changes')));
    }
    renderHistory(list, vault);
  };

  return {
    id: 'git',
    title: t('git.panel.title'),
    icon: 'git-branch',
    defaultDock: 'left',
    defaultOpen: false,
    defaultFlex: 260,
    flush: true,
    status: () => {
      const vault = session.currentOk();
      const count = vault === null ? 0 : changeCount(vault.status);
      return count > 0 ? api.i18n.formatNumber(count) : null;
    },
    headerActions: (host) => {
      const pullButton = icon('arrow-down', t('git.pull'), () => void commands.remote(t('git.busy.pulling'), 'pull'));
      const pushButton = icon('arrow-up', t('git.push'), () => void commands.remote(t('git.busy.pushing'), 'push'));
      const moreButton: HTMLButtonElement = icon('more-horizontal', t('git.more'), () =>
        openRepoActions(api, session, commands, moreButton),
      );
      moreButton.setAttribute('aria-haspopup', 'menu');
      moreButton.setAttribute('aria-expanded', 'false');
      const render = (): void => {
        const vault = session.currentOk();
        const off = vault === null || state.busy !== null;
        // A plugin-managed vault (SDK 1.32) refuses pull and push
        // main-side; a repository found by the scan (T-0045) too.
        const locked = vault !== null && (vault.managedBy !== null || vault.discovered);
        pullButton.disabled = off || locked;
        pushButton.disabled = off || locked;
        moreButton.disabled = state.busy !== null;
        setLabel(pullButton, pullButtonLabel(api.i18n, vault?.status.behind ?? 0));
        setLabel(pushButton, pushButtonLabel(api.i18n, vault?.status.ahead ?? 0));
      };
      host.append(pullButton, pushButton, moreButton);
      render();
      return session.subscribe(render);
    },
    mount: (body) => {
      body.classList.add('git-panel');
      const head = el('div', 'git-head');
      const busy = el('div', 'git-busy');
      const compose = el('div', 'git-compose');
      const message = el('textarea', 'git-message');
      message.rows = 1;
      message.setAttribute('aria-label', t('git.commit.message'));
      message.spellcheck = true;
      const commitButton = icon('check', t('git.commit.commit'), () => void commands.commit());
      compose.append(message, commitButton);
      const banner = el('div', 'git-banner');
      const list = el('div', 'git-list');
      body.append(head, busy, banner, compose, list);

      /** One line, and one more per line of text (board 9d), up to {@link MAX_LINES}. */
      const fit = (): void => {
        message.style.height = 'auto';
        const height = Math.min(message.scrollHeight, MAX_LINES * LINE_PX + 10);
        message.style.height = `${height}px`;
        compose.classList.toggle('multi', message.value.includes('\n') || height > LINE_PX + 10);
      };

      message.addEventListener('input', () => {
        if (state.current !== null) {
          state.drafts.set(state.current, message.value);
        }
        fit();
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
        // No commit field for a repository found by the scan (T-0045):
        // there is nothing it could honestly send.
        compose.hidden = vault === null || vault.discovered;
        const draft = vault === null ? '' : (state.drafts.get(keyOf(vault)) ?? '');
        if (message.value !== draft) {
          message.value = draft;
        }
        // The commit field is inert for a plugin-managed vault: main refuses
        // the commit anyway, an empty field says why the button is off.
        const managed = vault !== null && vault.managedBy !== null;
        message.disabled = managed;
        commitButton.disabled = managed || state.busy !== null || (merging && conflictsLeft > 0);
        setLabel(commitButton, commitButtonLabel(api.i18n, merging, amending, conflictsLeft));
        if (!compose.hidden) {
          fit();
        }
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
