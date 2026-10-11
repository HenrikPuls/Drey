import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';
import {
  changeCount,
  decorationsFor,
  describeKind,
  isPlausibleBranchName,
  parsePatch,
  type GitBranch,
  type GitChange,
  type GitLogEntry,
  type GitStash,
  type PatchLine,
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
      /** Amend mode: the next commit rewrites the last one. */
      amend: false,
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

    /**
     * Commits the staged changes. `push` sends the branch right after.
     * During a merge an empty message keeps git's own and the commit
     * completes the merge; in amend mode it rewrites the last commit.
     */
    const commit = async (push = false): Promise<void> => {
      const vault = currentOk();
      if (vault === null || state.busy !== null) {
        return;
      }
      const vaultId = vault.vaultId;
      const merging = vault.operation !== null;
      const amend = state.amend && !merging;
      if (merging && vault.status.conflicts.length > 0) {
        await api.ui.showMessage('Resolve all merge conflicts first.', 'Merge');
        return;
      }
      const message = (state.drafts.get(vaultId) ?? '').trim();
      if (message === '' && !merging && !amend) {
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
      if (!merging && !amend && now.status.staged.length === 0) {
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
      const label = merging
        ? push ? 'Completing the merge and pushing…' : 'Completing the merge…'
        : amend
          ? push ? 'Amending and pushing…' : 'Amending…'
          : push ? 'Committing and pushing…' : 'Committing…';
      if (await run(label, 'commit', { vaultId, message, amend, push }, push)) {
        state.drafts.delete(vaultId);
        state.amend = false;
        notify();
      }
    };

    // -- merge, conflicts, amend, stash -----------------------------------------

    const mergeBranch = async (name: string): Promise<void> => {
      const vault = currentOk();
      if (vault === null) {
        return;
      }
      const into = vault.status.branch ?? 'the detached HEAD';
      const answer = await ask(
        'Merge branch',
        `Merge "${name}" into "${into}"? If both sides changed the same lines the merge stops, and you settle each conflicted file here.`,
        [{ label: 'Merge', value: 'merge', primary: true }],
      );
      if (answer === null || !(await cleanTabsOrExplain(vault.vaultId, 'A merge'))) {
        return;
      }
      await run('Merging…', 'merge', { vaultId: vault.vaultId, name });
    };

    const abortMerge = async (): Promise<void> => {
      const vault = currentOk();
      if (vault === null || vault.operation === null) {
        return;
      }
      const answer = await ask(
        'Abort the merge',
        'The merge is cancelled and the files return to how they were before it started. What you settled so far is lost.',
        [{ label: 'Abort merge', value: 'abort', danger: true }],
      );
      if (answer === null || !(await cleanTabsOrExplain(vault.vaultId, 'Aborting the merge'))) {
        return;
      }
      await run('Aborting the merge…', 'mergeAbort', { vaultId: vault.vaultId });
    };

    const resolveConflict = async (change: GitChange, side: 'ours' | 'theirs'): Promise<void> => {
      const vault = currentOk();
      if (vault === null) {
        return;
      }
      if (dirtyDocs(vault.vaultId).some((d) => d.path === change.path)) {
        await api.ui.showMessage(`"${change.path}" has unsaved changes. Save or close the tab first.`, 'Merge');
        return;
      }
      const answer = await ask(
        side === 'ours' ? 'Keep mine' : 'Keep theirs',
        side === 'ours'
          ? `"${change.path}" takes the version of the current branch. The incoming changes to this file are dropped.`
          : `"${change.path}" takes the incoming version. Your branch's changes to this file are dropped.`,
        [{ label: side === 'ours' ? 'Keep mine' : 'Keep theirs', value: 'resolve', primary: true }],
      );
      if (answer !== null) {
        await run('Resolving…', 'resolve', { vaultId: vault.vaultId, path: change.path, side });
      }
    };

    const toggleAmend = async (): Promise<void> => {
      const vault = currentOk();
      if (vault === null || state.busy !== null) {
        return;
      }
      if (state.amend) {
        state.amend = false;
        notify();
        return;
      }
      if (vault.operation !== null) {
        await api.ui.showMessage('Complete or abort the merge first.', 'Amend');
        return;
      }
      const { upstream, ahead, head: commitId } = vault.status;
      if (commitId === null) {
        await api.ui.showMessage('There is no commit to amend yet.', 'Amend');
        return;
      }
      if (upstream !== null && ahead === 0) {
        await api.ui.showMessage(
          `The last commit is already on ${upstream}. Amending it would rewrite published history, and Drey never force-pushes.`,
          'Amend',
        );
        return;
      }
      state.amend = true;
      if ((state.drafts.get(vault.vaultId) ?? '').trim() === '') {
        try {
          const text = (await api.backend.invoke('headMessage', { vaultId: vault.vaultId })) as string;
          state.drafts.set(vault.vaultId, text);
        } catch {
          // The box stays empty: the commit keeps its message.
        }
      }
      notify();
    };

    const stashChanges = async (): Promise<void> => {
      const vault = currentOk();
      if (vault === null) {
        return;
      }
      if (vault.status.staged.length + vault.status.unstaged.length === 0) {
        await api.ui.showMessage('There is nothing to stash.', 'Stash');
        return;
      }
      const answer = await ask(
        'Stash changes',
        'The changes of this vault, new files included, are put away and the files return to the last commit. Apply them again from the stash list.',
        [{ label: 'Stash', value: 'stash', primary: true }],
      );
      if (answer === null || !(await cleanTabsOrExplain(vault.vaultId, 'Stashing'))) {
        return;
      }
      await run('Stashing…', 'stashPush', { vaultId: vault.vaultId });
    };

    const stashList = async (): Promise<void> => {
      const vault = currentOk();
      if (vault === null || state.busy !== null) {
        return;
      }
      const vaultId = vault.vaultId;
      let stashes: GitStash[];
      try {
        stashes = (await api.backend.invoke('stashList', { vaultId })) as GitStash[];
      } catch (error) {
        await api.ui.showMessage(messageOf(error), 'Git');
        return;
      }
      if (stashes.length === 0) {
        await api.ui.showMessage('There are no stashes.', 'Stashes');
        return;
      }
      const close = api.ui.showModal((box) => {
        box.classList.add('git-dialog', 'wide');
        box.append(el('h2', 'git-dialog-title', 'Stashes'));
        const list = el('div', 'git-stash-list');
        for (const stash of stashes) {
          const row = el('div', 'git-stash');
          const when = new Date(stash.date);
          const text = el('span', 'text');
          text.append(
            el('span', 'subject', stash.message),
            el('span', 'meta', Number.isNaN(when.getTime()) ? stash.date : WHEN.format(when)),
          );
          const apply = iconButton('rotate-ccw', 'Apply and remove this stash', () => {
            close();
            void (async () => {
              if (await cleanTabsOrExplain(vaultId, 'Applying a stash')) {
                await run('Applying the stash…', 'stashPop', { vaultId, index: stash.index });
              }
            })();
          });
          const drop = iconButton('trash', 'Delete this stash', () => {
            close();
            void (async () => {
              const answer = await ask('Delete stash', `"${stash.message}" is deleted for good.`, [
                { label: 'Delete', value: 'drop', danger: true },
              ]);
              if (answer !== null) {
                await run('Deleting the stash…', 'stashDrop', { vaultId, index: stash.index });
              }
            })();
          });
          row.append(text, apply, drop);
          list.appendChild(row);
        }
        const actions = el('div', 'git-dialog-actions');
        const done = el('button', 'git-btn primary', 'Close');
        done.type = 'button';
        done.addEventListener('click', () => close());
        actions.appendChild(done);
        box.append(list, actions);
        box.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            close();
          }
        });
      });
    };

    const fileHistory = async (requested?: string): Promise<void> => {
      const vault = currentOk();
      const active = api.documents.active();
      const path = requested ?? active?.path ?? '';
      if (vault === null || active === null || path === '' || active.vaultId !== vault.vaultId) {
        await api.ui.showMessage('Open a file of a Git vault first.', 'Git history');
        return;
      }
      const vaultId = vault.vaultId;
      let entries: GitLogEntry[];
      try {
        entries = (await api.backend.invoke('fileLog', { vaultId, path })) as GitLogEntry[];
      } catch (error) {
        await api.ui.showMessage(messageOf(error), 'Git history');
        return;
      }
      if (entries.length === 0) {
        await api.ui.showMessage(`"${path}" is not in any commit yet.`, 'Git history');
        return;
      }
      const stamp = (iso: string): string => {
        const when = new Date(iso);
        return Number.isNaN(when.getTime()) ? iso : WHEN.format(when);
      };
      const close = api.ui.showModal((box) => {
        box.classList.add('git-dialog', 'wide');
        box.append(
          el('h2', 'git-dialog-title', 'Git history'),
          el('p', 'git-dialog-sub', `${path} · ${entries.length} ${entries.length === 1 ? 'commit' : 'commits'}`),
        );
        const body = el('div', 'git-history-body');
        const listNode = el('div', 'git-history-list');
        listNode.setAttribute('role', 'listbox');
        listNode.setAttribute('aria-label', 'Commits that changed this file');
        const detail = el('div', 'git-history-detail');
        body.append(listNode, detail);

        const actions = el('div', 'git-dialog-actions');
        const restore = el('button', 'git-btn', 'Restore this version');
        restore.type = 'button';
        restore.title = 'Puts this version into the editor. Save to keep it.';
        const done = el('button', 'git-btn primary', 'Close');
        done.type = 'button';
        actions.append(restore, done);
        box.append(body, actions);

        let selected = 0;
        let token = 0;
        const MAX_LINES = 400;

        const select = async (index: number): Promise<void> => {
          selected = index;
          const mine = ++token;
          const entry = entries[index];
          listNode.querySelectorAll('.git-commit').forEach((node, i) => {
            node.classList.toggle('on', i === index);
            node.setAttribute('aria-selected', String(i === index));
          });
          detail.textContent = '';
          const head = el('div', 'head');
          head.append(
            el('div', 'subject', entry.subject),
            el('div', 'meta', `${entry.author} · ${stamp(entry.date)} · ${entry.hash}`),
          );
          const diff = el('div', 'git-diff');
          diff.setAttribute('aria-label', 'Changes in this commit');
          detail.append(head, diff);
          diff.appendChild(el('div', 'hunk', 'Loading…'));
          try {
            const patch = (await api.backend.invoke('filePatch', { vaultId, path, hash: entry.hash })) as string;
            if (mine !== token) {
              return;
            }
            diff.textContent = '';
            const lines: PatchLine[] = parsePatch(patch);
            if (lines.length === 0) {
              diff.appendChild(el('div', 'hunk', 'No text changes to show (binary file or a rename).'));
            }
            for (const line of lines.slice(0, MAX_LINES)) {
              const prefix = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : line.kind === 'hunk' ? '' : '  ';
              diff.appendChild(el('div', line.kind === 'context' ? undefined : line.kind, `${prefix}${line.text}`));
            }
            if (lines.length > MAX_LINES) {
              diff.appendChild(el('div', 'hunk', `… ${lines.length - MAX_LINES} more lines`));
            }
          } catch (error) {
            if (mine === token) {
              diff.textContent = '';
              diff.appendChild(el('div', 'hunk', messageOf(error)));
            }
          }
        };

        entries.forEach((entry, i) => {
          const row = el('div', 'git-commit');
          row.setAttribute('role', 'option');
          row.tabIndex = 0;
          row.append(el('span', 'subject', entry.subject), el('span', 'meta', `${entry.author} · ${stamp(entry.date)} · ${entry.hash}`));
          row.addEventListener('click', () => void select(i));
          listNode.appendChild(row);
        });

        done.addEventListener('click', () => close());
        restore.addEventListener('click', () => {
          const entry = entries[selected];
          void (async () => {
            try {
              const side = (await api.backend.invoke('fileAt', { vaultId, path, rev: entry.hash })) as {
                content: string | null;
                binary: boolean;
              };
              if (side.binary || side.content === null) {
                await api.ui.showMessage(
                  side.binary ? `"${path}" is not a text file.` : `"${path}" does not exist in that commit.`,
                  'Git history',
                );
                return;
              }
              close();
              await api.documents.open(path, undefined, { vaultId });
              if (!api.documents.setBuffer(path, side.content)) {
                await api.ui.showMessage('The version could not be put into the editor.', 'Git history');
              }
            } catch (error) {
              await api.ui.showMessage(messageOf(error), 'Git history');
            }
          })();
        });
        box.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            close();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = Math.max(0, Math.min(entries.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
            if (next !== selected) {
              void select(next);
            }
          }
        });
        void select(0);
      });
    };

    const repoActions = async (): Promise<void> => {
      const vault = currentOk();
      if (vault === null || state.busy !== null) {
        return;
      }
      const merging = vault.operation !== null;
      const dirtyTree = vault.status.staged.length + vault.status.unstaged.length > 0;
      const rows: Array<{ icon: string; label: string; hint?: string; disabled?: boolean; run: () => void }> = [
        { icon: 'git-merge', label: 'Merge a branch…', disabled: merging, run: () => void pickBranch('merge') },
        { icon: 'archive', label: 'Stash changes', disabled: merging || !dirtyTree, run: () => void stashChanges() },
        {
          icon: 'archive',
          label: 'Stashes…',
          hint: vault.stashCount > 0 ? String(vault.stashCount) : undefined,
          disabled: vault.stashCount === 0,
          run: () => void stashList(),
        },
        {
          icon: 'pencil',
          label: state.amend ? 'Stop amending' : 'Amend the last commit',
          disabled: merging,
          run: () => void toggleAmend(),
        },
        { icon: 'history', label: 'Git history of this file…', run: () => void fileHistory() },
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

    const pickBranch = async (mode: 'switch' | 'merge' = 'switch'): Promise<void> => {
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
        if (mode === 'merge') {
          await mergeBranch(branch.name);
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
        input.setAttribute('aria-label', mode === 'merge' ? 'Filter branches to merge' : 'Filter or name a branch');
        const list = el('div', 'git-branch-list');
        list.setAttribute('role', 'listbox');
        box.append(input, list);

        let options: Array<GitBranch | { create: string }> = [];
        let cursor = 0;
        const render = (): void => {
          const query = input.value.trim();
          const needle = query.toLowerCase();
          options = branches.filter((b) => b.name.toLowerCase().includes(needle) && !(mode === 'merge' && b.current));
          if (mode === 'switch' && query !== '' && isPlausibleBranchName(query) && !branches.some((b) => b.name === query)) {
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
    api.commands.register({ id: 'git.commitAndPush', label: 'Git: Commit and push', run: () => void commit(true) });
    api.commands.register({ id: 'git.merge', label: 'Git: Merge a branch…', run: () => void pickBranch('merge') });
    api.commands.register({ id: 'git.stash', label: 'Git: Stash changes', run: () => void stashChanges() });
    api.commands.register({ id: 'git.stashes', label: 'Git: Stashes…', run: () => void stashList() });
    api.commands.register({ id: 'git.fileHistory', label: 'Git: History of this file…', run: () => void fileHistory() });
    api.editor.registerContextMenuItems((target) => {
      const vault = currentOk();
      const active = api.documents.active();
      if (target.surface !== 'editor' || target.docPath === null || vault === null || active === null) {
        return [];
      }
      if (active.vaultId !== vault.vaultId) {
        return [];
      }
      const path = target.docPath;
      return [{ label: 'Git history…', run: () => void fileHistory(path) }];
    });
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
      icon: 'git-branch',
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
        const fetchButton = iconButton('download', 'Fetch from the remote', () => void remote('Fetching…', 'fetch'));
        const pullButton = iconButton('arrow-down', 'Pull', () => void remote('Pulling…', 'pull'));
        const pushButton = iconButton('arrow-up', 'Push', () => void remote('Pushing…', 'push'));
        const moreButton = iconButton('more-horizontal', 'More Git actions', () => void repoActions());
        const buttons = [fetchButton, pullButton, pushButton, moreButton];
        const refresh = iconButton('refresh-cw', 'Refresh the status', () => void pull('relocate'));
        const label = (button: HTMLButtonElement, text: string): void => {
          button.title = text;
          button.setAttribute('aria-label', text);
        };
        const render = (): void => {
          const vault = currentOk();
          const off = vault === null || state.busy !== null;
          for (const button of buttons) {
            button.disabled = off;
          }
          const ahead = vault?.status.ahead ?? 0;
          const behind = vault?.status.behind ?? 0;
          label(pullButton, behind > 0 ? `Pull (${behind} ${behind === 1 ? 'commit' : 'commits'} to pull)` : 'Pull');
          label(pushButton, ahead > 0 ? `Push (${ahead} ${ahead === 1 ? 'commit' : 'commits'} not pushed)` : 'Push');
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
        const pushCommitButton = iconButton('upload', 'Commit and push (Ctrl+Shift+Enter)', () => void commit(true));
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
            void commit(event.shiftKey);
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
          if (group === 'conflicts') {
            actions.append(
              iconButton('arrow-left', 'Keep mine (current branch)', () => void resolveConflict(change, 'ours')),
              iconButton('arrow-right', 'Keep theirs (incoming)', () => void resolveConflict(change, 'theirs')),
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
            const lines = [vault.operation !== null ? 'Switch branch (disabled while merging)' : 'Switch branch'];
            lines.push(upstream === null ? 'Not published yet' : `Tracks ${upstream}`);
            if (ahead > 0 || behind > 0) {
              lines.push(
                [
                  ahead > 0 ? `${ahead} ${ahead === 1 ? 'commit' : 'commits'} not pushed` : '',
                  behind > 0 ? `${behind} to pull` : '',
                ]
                  .filter((part) => part !== '')
                  .join(', '),
              );
            }
            if (vault.fetchedAt !== null) {
              const fetched = new Date(vault.fetchedAt);
              lines.push(`Last fetch ${Number.isNaN(fetched.getTime()) ? vault.fetchedAt : WHEN.format(fetched)}`);
            }
            button.title = lines.join('\n');
            button.setAttribute('aria-label', 'Switch branch');
            button.disabled = state.busy !== null || vault.operation !== null;
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

          // A banner above the commit box: the merge in progress, or amend mode.
          banner.textContent = '';
          banner.hidden = true;
          const merging = vault !== null && vault.operation !== null;
          const amending = vault !== null && state.amend && !merging;
          const conflictsLeft = vault === null ? 0 : vault.status.conflicts.length;
          if (vault !== null && vault.operation !== null) {
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
                  ? `${conflictsLeft} ${conflictsLeft === 1 ? 'conflict' : 'conflicts'} left`
                  : 'No conflicts left. Commit to complete the merge.',
              ),
            );
            banner.append(alert, text, iconButton('x', 'Abort the merge', () => void abortMerge()));
          } else if (amending) {
            banner.hidden = false;
            banner.className = 'git-banner git-amend';
            const text = el('span', 'text');
            text.append(
              el('span', undefined, 'Amending the last commit'),
              el('span', 'sub', 'Staged changes and this message replace it.'),
            );
            banner.append(api.ui.icon('pencil', 14), text, iconButton('x', 'Stop amending', () => void toggleAmend()));
          }

          compose.hidden = vault === null;
          const draft = vault === null ? '' : (state.drafts.get(vault.vaultId) ?? '');
          if (message.value !== draft) {
            message.value = draft;
          }
          const blocked = state.busy !== null || (merging && conflictsLeft > 0);
          commitButton.disabled = blocked;
          pushCommitButton.disabled = blocked;
          const commitLabel = merging
            ? conflictsLeft > 0
              ? 'Resolve all conflicts to complete the merge'
              : 'Complete the merge (Ctrl+Enter)'
            : amending
              ? 'Amend the last commit (Ctrl+Enter)'
              : 'Commit staged changes (Ctrl+Enter)';
          commitButton.title = commitLabel;
          commitButton.setAttribute('aria-label', commitLabel);
          const pushLabel = merging
            ? 'Complete the merge and push (Ctrl+Shift+Enter)'
            : amending
              ? 'Amend and push (Ctrl+Shift+Enter)'
              : 'Commit and push (Ctrl+Shift+Enter)';
          pushCommitButton.title = pushLabel;
          pushCommitButton.setAttribute('aria-label', pushLabel);

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
              const meta = el(
                'span',
                'meta',
                `${entry.author} · ${Number.isNaN(when.getTime()) ? entry.date : WHEN.format(when)} · ${entry.hash}`,
              );
              if (entry.unpushed === true) {
                meta.append(' · ', el('span', 'unpushed', '↑ not pushed'));
              }
              row.append(el('span', 'subject', entry.subject), meta);
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
