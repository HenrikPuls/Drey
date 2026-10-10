import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';
import {
  changeCount,
  decorationsFor,
  describeKind,
  isPlausibleBranchName,
  type GitBranch,
  type GitChange,
  type GitLogEntry,
  type VaultGitState,
} from '../shared/status.js';

/**
 * The Git plugin's renderer (milestone 65, ADR-0065): the "Source control"
 * dock panel and the Files-panel decorations. All git work happens in the
 * plugin's main entry; this side shows the pushed state, asks before
 * anything that can lose text, and hands the status to the Files panel
 * (`api.ui.setFileDecorations`).
 *
 * The panel shows ONE repository: the vault of the focused document when
 * that vault is a Git repository, otherwise the last one shown.
 */

type Group = 'staged' | 'changes' | 'conflicts';

const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Removes the window listener `activate` installed. */
let cleanup: (() => void) | null = null;

const plugin: PluginRendererModule = {
  async activate(api: DreyPluginApi) {
    const state = {
      vaults: [] as VaultGitState[],
      names: new Map<string, string>(),
      /** The vault whose repository the panel shows. */
      current: null as string | null,
      /** The command in flight (`Pulling…`), or null. */
      busy: null as string | null,
      /** True while the running command can be cancelled (network). */
      cancellable: false,
      /** Commit message drafts, per vault. */
      drafts: new Map<string, string>(),
      historyOpen: false,
      log: [] as GitLogEntry[],
      /** Vault ids that had decorations last time, to clear the ones that lost them. */
      decorated: new Set<string>(),
    };

    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const listener of [...listeners]) {
        listener();
      }
    };

    const okVaults = (): Array<Extract<VaultGitState, { state: 'ok' }>> =>
      state.vaults.filter((v): v is Extract<VaultGitState, { state: 'ok' }> => v.state === 'ok');
    const currentState = (): VaultGitState | null =>
      state.vaults.find((v) => v.vaultId === state.current) ?? null;
    const currentOk = (): Extract<VaultGitState, { state: 'ok' }> | null => {
      const found = currentState();
      return found !== null && found.state === 'ok' ? found : null;
    };

    /** Follows the focused document's vault when it is a repository. */
    const pickCurrent = (): void => {
      const repos = okVaults();
      const activeVault = api.documents.active()?.vaultId ?? null;
      if (activeVault !== null && repos.some((v) => v.vaultId === activeVault)) {
        state.current = activeVault;
      } else if (state.current === null || !state.vaults.some((v) => v.vaultId === state.current)) {
        state.current = repos[0]?.vaultId ?? state.vaults[0]?.vaultId ?? null;
      } else if (currentOk() === null && repos.length > 0) {
        state.current = repos[0].vaultId;
      }
    };

    const applyStates = (vaults: readonly VaultGitState[]): void => {
      state.vaults = [...vaults];
      const decorated = new Set<string>();
      for (const vault of state.vaults) {
        if (vault.state === 'ok') {
          const decorations = decorationsFor(vault.status);
          api.ui.setFileDecorations(vault.vaultId, decorations);
          if (decorations.length > 0) {
            decorated.add(vault.vaultId);
          }
        }
      }
      for (const id of state.decorated) {
        if (!decorated.has(id)) {
          api.ui.setFileDecorations(id, null);
        }
      }
      state.decorated = decorated;
      pickCurrent();
      notify();
    };

    const loadNames = async (): Promise<void> => {
      const vaults = await api.vault.listVaults();
      state.names = new Map(vaults.map((v) => [v.id, v.name]));
    };

    /**
     * Pulls the state: `cached` = what main already knows, `refresh` = run
     * git status again, `relocate` = also look again which vaults are
     * repositories (somebody may have run `git init` or moved a folder).
     */
    const pull = async (mode: 'cached' | 'refresh' | 'relocate'): Promise<void> => {
      try {
        await loadNames();
        applyStates(
          (await api.backend.invoke('status', {
            refresh: mode !== 'cached',
            relocate: mode === 'relocate',
          })) as VaultGitState[],
        );
      } catch (error) {
        api.ui.showMessage(messageOf(error), 'Git').catch(() => undefined);
      }
    };

    const loadLog = async (): Promise<void> => {
      const vaultId = state.current;
      if (!state.historyOpen || vaultId === null || currentOk() === null) {
        state.log = [];
        notify();
        return;
      }
      try {
        const log = (await api.backend.invoke('log', { vaultId })) as GitLogEntry[];
        if (state.current === vaultId) {
          state.log = log;
          notify();
        }
      } catch {
        state.log = [];
        notify();
      }
    };

    // -- dialogs -----------------------------------------------------------

    /** A question with labelled answers; resolves the chosen value, or null when dismissed. */
    const ask = <T extends string>(
      title: string,
      message: string,
      answers: ReadonlyArray<{ label: string; value: T; primary?: boolean; danger?: boolean }>,
    ): Promise<T | null> =>
      new Promise<T | null>((resolve) => {
        let settled = false;
        const settle = (value: T | null): void => {
          if (!settled) {
            settled = true;
            resolve(value);
            close();
          }
        };
        const close = api.ui.showModal((box) => {
          box.classList.add('git-dialog');
          box.append(el('h2', 'git-dialog-title', title), el('p', 'git-dialog-text', message));
          const row = el('div', 'git-dialog-actions');
          const cancel = el('button', 'git-btn', 'Cancel');
          cancel.type = 'button';
          cancel.addEventListener('click', () => settle(null));
          row.appendChild(cancel);
          for (const answer of answers) {
            const button = el('button', 'git-btn', answer.label);
            button.type = 'button';
            button.classList.toggle('primary', answer.primary === true);
            button.classList.toggle('danger', answer.danger === true);
            button.addEventListener('click', () => settle(answer.value));
            row.appendChild(button);
          }
          box.appendChild(row);
          box.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
              settle(null);
            }
          });
          queueMicrotask(() => {
            (row.lastElementChild as HTMLElement | null)?.focus();
            // A backdrop click closes the modal without an answer: watch for
            // the overlay leaving the page and count that as "Cancel".
            const backdrop = box.parentElement;
            if (backdrop === null) {
              return;
            }
            const observer = new MutationObserver(() => {
              if (!backdrop.isConnected) {
                observer.disconnect();
                settle(null);
              }
            });
            observer.observe(document.body, { childList: true });
          });
        });
      });

    // -- commands ----------------------------------------------------------

    const dirtyDocs = (vaultId: string) =>
      api.documents.list().filter((d) => d.vaultId === vaultId && d.kind === 'text' && d.dirty);

    /** Runs one backend command with the busy line, the error dialog and the new state. */
    const run = async (
      label: string,
      method: string,
      payload: Record<string, unknown>,
      cancellable = false,
    ): Promise<boolean> => {
      if (state.busy !== null) {
        return false;
      }
      state.busy = label;
      state.cancellable = cancellable;
      notify();
      try {
        const result = await api.backend.invoke(method, payload);
        if (Array.isArray(result)) {
          applyStates(result as VaultGitState[]);
        }
        return true;
      } catch (error) {
        const message = messageOf(error);
        if (message !== 'Cancelled.') {
          await api.ui.showMessage(message, 'Git');
        }
        return false;
      } finally {
        state.busy = null;
        state.cancellable = false;
        notify();
        void loadLog();
      }
    };

    /** Refuses a command that rewrites files while the vault has unsaved tabs. */
    const cleanTabsOrExplain = async (vaultId: string, what: string): Promise<boolean> => {
      const dirty = dirtyDocs(vaultId);
      if (dirty.length === 0) {
        return true;
      }
      await api.ui.showMessage(
        `${what} can rewrite files of this vault, and ${dirty.length === 1 ? `"${dirty[0].name}" has` : `${dirty.length} tabs have`} unsaved changes. Save or close them first.`,
        'Unsaved changes',
      );
      return false;
    };

    const commit = async (): Promise<void> => {
      const vault = currentOk();
      if (vault === null || state.busy !== null) {
        return;
      }
      const vaultId = vault.vaultId;
      const message = (state.drafts.get(vaultId) ?? '').trim();
      if (message === '') {
        await api.ui.showMessage('Enter a commit message.', 'Commit');
        return;
      }
      const dirty = dirtyDocs(vaultId);
      if (dirty.length > 0) {
        const answer = await ask(
          'Unsaved changes',
          `${dirty.length === 1 ? `"${dirty[0].name}" has` : `${dirty.length} tabs have`} unsaved changes that will not be part of this commit.`,
          [
            { label: 'Commit anyway', value: 'commit' },
            { label: 'Save all and commit', value: 'save', primary: true },
          ],
        );
        if (answer === null) {
          return;
        }
        if (answer === 'save') {
          for (const doc of dirty) {
            await api.documents.save(doc.path);
          }
          await pull('refresh');
        }
      }
      let now = currentOk();
      if (now === null) {
        return;
      }
      if (now.status.staged.length === 0) {
        if (now.status.unstaged.length === 0) {
          await api.ui.showMessage('There is nothing to commit.', 'Commit');
          return;
        }
        const answer = await ask('Nothing is staged', 'Stage all changes of this vault and commit them?', [
          { label: 'Stage all and commit', value: 'stage', primary: true },
        ]);
        if (answer === null || !(await run('Staging…', 'stage', { vaultId, paths: [] }))) {
          return;
        }
        now = currentOk();
      }
      if (now !== null && now.stagedOutside > 0) {
        const answer = await ask(
          'Staged changes outside this vault',
          `${now.stagedOutside} staged ${now.stagedOutside === 1 ? 'file lies' : 'files lie'} outside the vault folder. The commit includes ${now.stagedOutside === 1 ? 'it' : 'them'}.`,
          [{ label: 'Commit', value: 'commit', primary: true }],
        );
        if (answer === null) {
          return;
        }
      }
      if (await run('Committing…', 'commit', { vaultId, message })) {
        state.drafts.delete(vaultId);
        notify();
      }
    };

    const remote = async (label: string, method: 'fetch' | 'pull' | 'push'): Promise<void> => {
      const vault = currentOk();
      if (vault === null) {
        return;
      }
      if (method === 'pull' && !(await cleanTabsOrExplain(vault.vaultId, 'A pull'))) {
        return;
      }
      await run(label, method, { vaultId: vault.vaultId }, true);
    };

    const discard = async (change: GitChange): Promise<void> => {
      const vault = currentOk();
      if (vault === null) {
        return;
      }
      if (dirtyDocs(vault.vaultId).some((d) => d.path === change.path)) {
        await api.ui.showMessage(`"${change.path}" has unsaved changes. Save or close the tab first.`, 'Discard');
        return;
      }
      const untracked = change.kind === 'untracked';
      const answer = await ask(
        'Discard changes',
        untracked
          ? `"${change.path}" is not in the repository yet. It will be moved to the recycle bin.`
          : `Your changes to "${change.path}" will be lost.`,
        [{ label: untracked ? 'Delete file' : 'Discard', value: 'discard', danger: true }],
      );
      if (answer !== null) {
        await run('Discarding…', 'discard', { vaultId: vault.vaultId, paths: [change.path] });
      }
    };

    const showDiff = async (change: GitChange, group: Group): Promise<void> => {
      const vault = currentOk();
      if (vault === null) {
        return;
      }
      const vaultId = vault.vaultId;
      if (group === 'conflicts') {
        await api.documents.open(change.path, undefined, { vaultId });
        return;
      }
      const side = async (path: string, rev: 'head' | 'index' | 'worktree') =>
        (await api.backend.invoke('fileAt', { vaultId, path, rev })) as { content: string | null; binary: boolean };
      try {
        const before = await side(
          group === 'staged' ? (change.origPath ?? change.path) : change.path,
          group === 'staged' ? 'head' : 'index',
        );
        let after = await side(change.path, group === 'staged' ? 'index' : 'worktree');
        if (group === 'changes') {
          // An open tab is newer than the file: compare what is on screen.
          const open = api.documents.list().find((d) => d.vaultId === vaultId && d.path === change.path);
          if (open !== undefined && open.kind === 'text') {
            after = { content: open.buffer, binary: false };
          }
        }
        if (before.binary || after.binary) {
          await api.ui.showMessage(`"${change.path}" is not a text file, so there is nothing to compare.`, 'Git');
          return;
        }
        await api.ui.showDiff({
          title: group === 'staged' ? 'Staged changes' : 'Changes',
          path: change.path,
          before: before.content ?? '',
          after: after.content ?? '',
          beforeLabel: group === 'staged' ? 'Last commit' : 'Before',
          afterLabel: group === 'staged' ? 'Staged' : 'Working copy',
        });
      } catch (error) {
        await api.ui.showMessage(messageOf(error), 'Git');
      }
    };

    const pickBranch = async (): Promise<void> => {
      const vault = currentOk();
      if (vault === null || state.busy !== null) {
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

      const choose = async (branch: GitBranch | { create: string }): Promise<void> => {
        close();
        if ('create' in branch) {
          await run('Creating branch…', 'createBranch', { vaultId, name: branch.create });
          return;
        }
        if (branch.current || !(await cleanTabsOrExplain(vaultId, 'Switching the branch'))) {
          return;
        }
        await run('Switching branch…', 'checkout', { vaultId, name: branch.name, remote: branch.remote });
      };

      const close = api.ui.showModal((box) => {
        box.classList.add('git-branches');
        const input = el('input', 'git-branch-filter');
        input.type = 'text';
        input.setAttribute('aria-label', 'Filter or name a branch');
        const list = el('div', 'git-branch-list');
        list.setAttribute('role', 'listbox');
        box.append(input, list);

        let options: Array<GitBranch | { create: string }> = [];
        let cursor = 0;
        const render = (): void => {
          const query = input.value.trim();
          const needle = query.toLowerCase();
          options = branches.filter((b) => b.name.toLowerCase().includes(needle));
          if (query !== '' && isPlausibleBranchName(query) && !branches.some((b) => b.name === query)) {
            options.push({ create: query });
          }
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
              row.append(
                api.ui.icon(option.current ? 'check' : 'git-branch', 14),
                el('span', 'name', option.name),
              );
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
    };

    // -- wiring ------------------------------------------------------------

    api.backend.on('status-updated', (data) => {
      if (Array.isArray(data)) {
        void loadNames().then(() => applyStates(data as VaultGitState[]));
      }
    });

    api.documents.onChange((event) => {
      if (event.type === 'active-changed') {
        const before = state.current;
        pickCurrent();
        if (state.current !== before) {
          notify();
          void loadLog();
        }
      } else if (event.type === 'dirty-changed' && !event.dirty) {
        // A save of any file kind (the note pipeline only reports notes).
        void pull('refresh');
      }
    });

    // Somebody may have committed, pulled or edited outside the app.
    const onFocus = (): void => void pull('relocate');
    window.addEventListener('focus', onFocus);
    cleanup = () => window.removeEventListener('focus', onFocus);

    api.commands.register({ id: 'git.commit', label: 'Git: Commit', run: () => void commit() });
    api.commands.register({ id: 'git.push', label: 'Git: Push', run: () => void remote('Pushing…', 'push') });
    api.commands.register({ id: 'git.pull', label: 'Git: Pull', run: () => void remote('Pulling…', 'pull') });
    api.commands.register({ id: 'git.refresh', label: 'Git: Refresh status', run: () => void pull('relocate') });

    const iconButton = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const button = el('button', 'icon-btn');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.appendChild(api.ui.icon(icon, 14));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
      return button;
    };

    api.ui.registerWidget({
      id: 'git',
      title: 'Source control',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 260,
      flush: true,
      status: () => {
        const vault = currentOk();
        const count = vault === null ? 0 : changeCount(vault.status);
        return count > 0 ? String(count) : null;
      },
      headerActions: (host) => {
        const buttons = [
          iconButton('download', 'Fetch from the remote', () => void remote('Fetching…', 'fetch')),
          iconButton('arrow-down', 'Pull', () => void remote('Pulling…', 'pull')),
          iconButton('arrow-up', 'Push', () => void remote('Pushing…', 'push')),
        ];
        const refresh = iconButton('refresh-cw', 'Refresh the status', () => void pull('relocate'));
        const render = (): void => {
          const off = currentOk() === null || state.busy !== null;
          for (const button of buttons) {
            button.disabled = off;
          }
        };
        host.append(...buttons, refresh);
        render();
        listeners.add(render);
        return () => {
          listeners.delete(render);
        };
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
        const commitButton = iconButton('check', 'Commit staged changes (Ctrl+Enter)', () => void commit());
        compose.append(message, commitButton);
        const list = el('div', 'git-list');
        body.append(head, busy, compose, list);

        message.addEventListener('input', () => {
          if (state.current !== null) {
            state.drafts.set(state.current, message.value);
          }
        });
        message.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit();
          }
        });

        const changeRow = (change: GitChange, group: Group, vaultId: string): HTMLElement => {
          const { badge, tone, label } = describeKind(change.kind);
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
              iconButton('file-text', 'Open file', () => void api.documents.open(change.path, undefined, { vaultId })),
            );
          }
          if (group === 'changes') {
            actions.appendChild(iconButton('rotate-ccw', 'Discard changes', () => void discard(change)));
          }
          if (group === 'staged') {
            actions.appendChild(
              iconButton('minus', 'Unstage', () => void run('Unstaging…', 'unstage', { vaultId, paths: [change.path] })),
            );
          } else {
            actions.appendChild(
              iconButton(
                'plus',
                group === 'conflicts' ? 'Mark as resolved (stage)' : 'Stage',
                () => void run('Staging…', 'stage', { vaultId, paths: [change.path] }),
              ),
            );
          }
          row.append(actions, el('span', 'badge', badge));
          const open = (): void => void showDiff(change, group);
          row.addEventListener('click', open);
          row.addEventListener('keydown', (event) => {
            if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              open();
            }
          });
          return row;
        };

        const groupNode = (
          title: string,
          changes: readonly GitChange[],
          group: Group,
          vaultId: string,
          action?: HTMLButtonElement,
        ): void => {
          if (changes.length === 0) {
            return;
          }
          const header = el('div', 'git-group');
          header.append(el('span', 'title', title), el('span', 'count', String(changes.length)));
          if (action !== undefined) {
            header.appendChild(action);
          }
          list.appendChild(header);
          for (const change of changes) {
            list.appendChild(changeRow(change, group, vaultId));
          }
        };

        const render = (): void => {
          const found = currentState();
          const vault = currentOk();
          const repos = okVaults();

          // Repository line: which vault (a select once there are several
          // repositories) and its branch.
          head.textContent = '';
          if (repos.length > 1 && vault !== null) {
            const select = el('select', 'git-repo');
            select.setAttribute('aria-label', 'Repository');
            for (const repo of repos) {
              const option = el('option', undefined, state.names.get(repo.vaultId) ?? repo.vaultId);
              option.value = repo.vaultId;
              option.selected = repo.vaultId === vault.vaultId;
              select.appendChild(option);
            }
            select.addEventListener('change', () => {
              state.current = select.value;
              notify();
              void loadLog();
            });
            head.appendChild(select);
          }
          if (vault !== null) {
            const { branch, head: commitId, ahead, behind, upstream } = vault.status;
            const button = el('button', 'git-branch-btn');
            button.type = 'button';
            button.title = upstream === null ? 'Switch branch (not published yet)' : `Switch branch (tracks ${upstream})`;
            button.setAttribute('aria-label', 'Switch branch');
            button.disabled = state.busy !== null;
            button.append(
              api.ui.icon('git-branch', 14),
              el('span', 'name', branch ?? (commitId === null ? 'No commits yet' : `Detached at ${commitId}`)),
            );
            if (ahead > 0 || behind > 0) {
              button.appendChild(
                el('span', 'sync', [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].join(' ').trim()),
              );
            }
            button.addEventListener('click', () => void pickBranch());
            head.appendChild(button);
          }

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

          compose.hidden = vault === null;
          const draft = vault === null ? '' : (state.drafts.get(vault.vaultId) ?? '');
          if (message.value !== draft) {
            message.value = draft;
          }
          commitButton.disabled = state.busy !== null;

          list.textContent = '';
          if (vault === null) {
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
          groupNode('Merge conflicts', conflicts, 'conflicts', vaultId);
          groupNode(
            'Staged changes',
            staged,
            'staged',
            vaultId,
            iconButton('minus', 'Unstage all', () => void run('Unstaging…', 'unstage', { vaultId, paths: [] })),
          );
          groupNode(
            'Changes',
            unstaged,
            'changes',
            vaultId,
            iconButton('plus', 'Stage all changes', () => void run('Staging…', 'stage', { vaultId, paths: [] })),
          );
          if (staged.length + unstaged.length + conflicts.length === 0) {
            list.appendChild(el('p', 'git-empty', 'No changes.'));
          }

          const history = el('button', 'git-group git-history');
          history.type = 'button';
          history.setAttribute('aria-expanded', String(state.historyOpen));
          const twist = api.ui.icon('chevron-right', 14);
          twist.classList.add('twist');
          history.append(twist, el('span', 'title', 'History'));
          history.addEventListener('click', () => {
            state.historyOpen = !state.historyOpen;
            notify();
            void loadLog();
          });
          list.appendChild(history);
          if (state.historyOpen) {
            if (state.log.length === 0) {
              list.appendChild(el('p', 'git-empty', 'No commits yet.'));
            }
            for (const entry of state.log) {
              const row = el('div', 'git-commit');
              const when = new Date(entry.date);
              row.title = `${entry.hash} — ${entry.subject}`;
              row.append(
                el('span', 'subject', entry.subject),
                el(
                  'span',
                  'meta',
                  `${entry.author} · ${Number.isNaN(when.getTime()) ? entry.date : WHEN.format(when)} · ${entry.hash}`,
                ),
              );
              list.appendChild(row);
            }
          }
        };

        render();
        listeners.add(render);
        return () => {
          listeners.delete(render);
        };
      },
    });

    api.ui.registerSettingsPage({
      id: 'git',
      label: 'Git',
      hint: 'Git executable',
      mount: (body) => {
        const section = el('section');
        section.appendChild(el('h3', undefined, 'Git'));
        const field = el('div', 'field');
        const label = el('label', undefined, 'Git executable');
        const input = el('input');
        input.type = 'text';
        input.id = 'git-settings-path';
        label.htmlFor = input.id;
        field.append(
          label,
          input,
          el(
            'p',
            'field-hint',
            'Leave empty to use the git found on PATH. Set the full path to git.exe when it is installed elsewhere.',
          ),
        );
        section.appendChild(field);
        body.appendChild(section);

        void api.settings.get<string>('gitPath').then((value) => {
          input.value = value ?? '';
        });
        const save = async (): Promise<void> => {
          await api.settings.set('gitPath', input.value.trim());
          applyStates((await api.backend.invoke('configChanged')) as VaultGitState[]);
        };
        input.addEventListener('change', () => void save().catch(() => undefined));
        return () => undefined;
      },
    });

    void pull('cached');
  },

  deactivate() {
    cleanup?.();
    cleanup = null;
  },
};

export default plugin;
