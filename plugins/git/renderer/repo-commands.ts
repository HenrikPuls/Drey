/**
 * What the user can do to the shown repository: each command checks its
 * preconditions, asks before anything that can lose text, and then runs
 * one backend call through the session.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { GitChange } from '../shared/status.js';
import { ask } from './dialogs.js';
import { messageOf } from './dom.js';
import { commitBusyLabel, unsavedSubject, type Group } from './repo-model.js';
import type { RepoSession } from './repo-session.js';

export interface RepoCommands {
  /**
   * Commits the staged changes. `push` sends the branch right after.
   * During a merge an empty message keeps git's own and the commit
   * completes the merge; in amend mode it rewrites the last commit.
   */
  commit(push?: boolean): Promise<void>;
  mergeBranch(name: string): Promise<void>;
  abortMerge(): Promise<void>;
  resolveConflict(change: GitChange, side: 'ours' | 'theirs'): Promise<void>;
  toggleAmend(): Promise<void>;
  stashChanges(): Promise<void>;
  remote(label: string, method: 'fetch' | 'pull' | 'push'): Promise<void>;
  discard(change: GitChange): Promise<void>;
  /** A row click: compares the change, or opens a conflicted file. */
  showDiff(change: GitChange, group: Group): Promise<void>;
}

export function createRepoCommands(api: DreyPluginApi, session: RepoSession): RepoCommands {
  const { state } = session;

  const commit = async (push = false): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || state.busy !== null) {
      return;
    }
    if (vault.managedBy !== null) {
      await api.ui.showMessage(
        `Managed by ${vault.managedBy} — this repository's history is written by the plugin.`,
        'Source control',
      );
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
    const dirty = session.dirtyDocs(vaultId);
    if (dirty.length > 0) {
      const answer = await ask(
        api,
        'Unsaved changes',
        `${unsavedSubject(dirty)} unsaved changes that will not be part of this commit.`,
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
        await session.pull('refresh');
      }
    }
    let now = session.currentOk();
    if (now === null) {
      return;
    }
    if (!merging && !amend && now.status.staged.length === 0) {
      if (now.status.unstaged.length === 0) {
        await api.ui.showMessage('There is nothing to commit.', 'Commit');
        return;
      }
      const answer = await ask(api, 'Nothing is staged', 'Stage all changes of this vault and commit them?', [
        { label: 'Stage all and commit', value: 'stage', primary: true },
      ]);
      if (answer === null || !(await session.run('Staging…', 'stage', { vaultId, paths: [] }))) {
        return;
      }
      now = session.currentOk();
    }
    if (now !== null && now.stagedOutside > 0) {
      const answer = await ask(
        api,
        'Staged changes outside this vault',
        `${now.stagedOutside} staged ${now.stagedOutside === 1 ? 'file lies' : 'files lie'} outside the vault folder. The commit includes ${now.stagedOutside === 1 ? 'it' : 'them'}.`,
        [{ label: 'Commit', value: 'commit', primary: true }],
      );
      if (answer === null) {
        return;
      }
    }
    const label = commitBusyLabel(merging, amend, push);
    if (await session.run(label, 'commit', { vaultId, message, amend, push }, push)) {
      state.drafts.delete(vaultId);
      state.amend = false;
      session.notify();
    }
  };

  const mergeBranch = async (name: string): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null) {
      return;
    }
    const into = vault.status.branch ?? 'the detached HEAD';
    const answer = await ask(
      api,
      'Merge branch',
      `Merge "${name}" into "${into}"? If both sides changed the same lines the merge stops, and you settle each conflicted file here.`,
      [{ label: 'Merge', value: 'merge', primary: true }],
    );
    if (answer === null || !(await session.cleanTabsOrExplain(vault.vaultId, 'A merge'))) {
      return;
    }
    await session.run('Merging…', 'merge', { vaultId: vault.vaultId, name });
  };

  const abortMerge = async (): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || vault.operation === null) {
      return;
    }
    const answer = await ask(
      api,
      'Abort the merge',
      'The merge is cancelled and the files return to how they were before it started. What you settled so far is lost.',
      [{ label: 'Abort merge', value: 'abort', danger: true }],
    );
    if (answer === null || !(await session.cleanTabsOrExplain(vault.vaultId, 'Aborting the merge'))) {
      return;
    }
    await session.run('Aborting the merge…', 'mergeAbort', { vaultId: vault.vaultId });
  };

  const resolveConflict = async (change: GitChange, side: 'ours' | 'theirs'): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null) {
      return;
    }
    if (session.dirtyDocs(vault.vaultId).some((d) => d.path === change.path)) {
      await api.ui.showMessage(`"${change.path}" has unsaved changes. Save or close the tab first.`, 'Merge');
      return;
    }
    const answer = await ask(
      api,
      side === 'ours' ? 'Keep mine' : 'Keep theirs',
      side === 'ours'
        ? `"${change.path}" takes the version of the current branch. The incoming changes to this file are dropped.`
        : `"${change.path}" takes the incoming version. Your branch's changes to this file are dropped.`,
      [{ label: side === 'ours' ? 'Keep mine' : 'Keep theirs', value: 'resolve', primary: true }],
    );
    if (answer !== null) {
      await session.run('Resolving…', 'resolve', { vaultId: vault.vaultId, path: change.path, side });
    }
  };

  const toggleAmend = async (): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || state.busy !== null) {
      return;
    }
    if (state.amend) {
      state.amend = false;
      session.notify();
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
    session.notify();
  };

  const stashChanges = async (): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null) {
      return;
    }
    if (vault.status.staged.length + vault.status.unstaged.length === 0) {
      await api.ui.showMessage('There is nothing to stash.', 'Stash');
      return;
    }
    const answer = await ask(
      api,
      'Stash changes',
      'The changes of this vault, new files included, are put away and the files return to the last commit. Apply them again from the stash list.',
      [{ label: 'Stash', value: 'stash', primary: true }],
    );
    if (answer === null || !(await session.cleanTabsOrExplain(vault.vaultId, 'Stashing'))) {
      return;
    }
    await session.run('Stashing…', 'stashPush', { vaultId: vault.vaultId });
  };

  const remote = async (label: string, method: 'fetch' | 'pull' | 'push'): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null) {
      return;
    }
    if (method !== 'fetch' && vault.managedBy !== null) {
      await api.ui.showMessage(
        `Managed by ${vault.managedBy} — this repository's history is written by the plugin.`,
        'Source control',
      );
      return;
    }
    if (method === 'pull' && !(await session.cleanTabsOrExplain(vault.vaultId, 'A pull'))) {
      return;
    }
    await session.run(label, method, { vaultId: vault.vaultId }, true);
  };

  const discard = async (change: GitChange): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null) {
      return;
    }
    if (vault.managedBy !== null) {
      await api.ui.showMessage(
        `Managed by ${vault.managedBy} — this repository's history is written by the plugin.`,
        'Source control',
      );
      return;
    }
    if (session.dirtyDocs(vault.vaultId).some((d) => d.path === change.path)) {
      await api.ui.showMessage(`"${change.path}" has unsaved changes. Save or close the tab first.`, 'Discard');
      return;
    }
    const untracked = change.kind === 'untracked';
    const answer = await ask(
      api,
      'Discard changes',
      untracked
        ? `"${change.path}" is not in the repository yet. It will be moved to the recycle bin.`
        : `Your changes to "${change.path}" will be lost.`,
      [{ label: untracked ? 'Delete file' : 'Discard', value: 'discard', danger: true }],
    );
    if (answer !== null) {
      await session.run('Discarding…', 'discard', { vaultId: vault.vaultId, paths: [change.path] });
    }
  };

  const showDiff = async (change: GitChange, group: Group): Promise<void> => {
    const vault = session.currentOk();
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

  return { commit, mergeBranch, abortMerge, resolveConflict, toggleAmend, stashChanges, remote, discard, showDiff };
}
