/**
 * What the user can do to the shown repository: each command checks its
 * preconditions, asks before anything that can lose text, and then runs
 * one backend call through the session.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { GitChange } from '../shared/status.js';
import { ask } from './dialogs.js';
import { messageOf } from './dom.js';
import { keyOf, type Group, type OkVault } from './repo-model.js';
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

  const busyLabelOf = (merging: boolean, amend: boolean, push: boolean): string => {
    if (merging) {
      return push ? api.i18n.t('git.busy.completing_merge_push') : api.i18n.t('git.busy.completing_merge');
    }
    if (amend) {
      return push ? api.i18n.t('git.busy.amending_push') : api.i18n.t('git.busy.amending');
    }
    return push ? api.i18n.t('git.busy.committing_push') : api.i18n.t('git.busy.committing');
  };

  const managedMessage = (vault: OkVault): Promise<void> =>
    api.ui.showMessage(
      api.i18n.t('git.cmd.managed_by', { plugin: vault.managedBy ?? '' }),
      api.i18n.t('git.dialog.source_control'),
    );

  /**
   * A repository found by the scan (T-0045) is read-only; the UI hides
   * the paths in, this guard answers the ones that still fire (a
   * keyboard shortcut, a stale panel) with the same sentence main uses.
   */
  const refuseFound = async (vault: OkVault): Promise<boolean> => {
    if (!vault.discovered) {
      return false;
    }
    await api.ui.showMessage(
      api.i18n.t('git.cmd.found_read_only', { name: state.names.get(vault.vaultId) ?? vault.vaultId }),
      api.i18n.t('git.dialog.source_control'),
    );
    return true;
  };

  const commit = async (push = false): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || state.busy !== null || (await refuseFound(vault))) {
      return;
    }
    if (vault.managedBy !== null) {
      await managedMessage(vault);
      return;
    }
    const vaultId = vault.vaultId;
    const subPath = vault.subPath;
    const merging = vault.operation !== null;
    const amend = state.amend && !merging;
    if (merging && vault.status.conflicts.length > 0) {
      await api.ui.showMessage(api.i18n.t('git.cmd.resolve_first'), api.i18n.t('git.cmd.merge.message_title'));
      return;
    }
    const message = (state.drafts.get(vaultId) ?? '').trim();
    if (message === '' && !merging && !amend) {
      await api.ui.showMessage(api.i18n.t('git.cmd.commit.message_needed'), api.i18n.t('git.cmd.commit.title'));
      return;
    }
    const dirty = session.dirtyDocs(vaultId);
    if (dirty.length > 0) {
      const answer = await ask(
        api,
        api.i18n.t('git.dialog.unsaved_title'),
        api.i18n.t('git.cmd.commit.unsaved_text', { count: dirty.length, name: dirty[0].name }),
        [
          { label: api.i18n.t('git.cmd.commit.anyway'), value: 'commit' },
          { label: api.i18n.t('git.cmd.commit.save_all'), value: 'save', primary: true },
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
        await api.ui.showMessage(api.i18n.t('git.cmd.commit.nothing'), api.i18n.t('git.cmd.commit.title'));
        return;
      }
      const answer = await ask(
        api,
        api.i18n.t('git.cmd.commit.nothing_staged_title'),
        api.i18n.t('git.cmd.commit.nothing_staged_text'),
        [{ label: api.i18n.t('git.cmd.commit.stage_all'), value: 'stage', primary: true }],
      );
      if (
        answer === null ||
        !(await session.run(api.i18n.t('git.busy.staging'), 'stage', { vaultId, subPath, paths: [] }))
      ) {
        return;
      }
      now = session.currentOk();
    }
    if (now !== null && now.stagedOutside > 0) {
      const answer = await ask(
        api,
        api.i18n.t('git.cmd.commit.outside_title'),
        api.i18n.t('git.cmd.commit.outside_text', { count: now.stagedOutside }),
        [{ label: api.i18n.t('git.cmd.commit.title'), value: 'commit', primary: true }],
      );
      if (answer === null) {
        return;
      }
    }
    const label = busyLabelOf(merging, amend, push);
    if (await session.run(label, 'commit', { vaultId, subPath, message, amend, push }, push)) {
      state.drafts.delete(keyOf(vault));
      state.amend = false;
      session.notify();
    }
  };

  const mergeBranch = async (name: string): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || (await refuseFound(vault))) {
      return;
    }
    const branch = vault.status.branch;
    const answer = await ask(
      api,
      api.i18n.t('git.cmd.merge.title'),
      api.i18n.t('git.cmd.merge.text', { name, hasBranch: branch === null ? 'no' : 'yes', branch: branch ?? '' }),
      [{ label: api.i18n.t('git.cmd.merge.confirm'), value: 'merge', primary: true }],
    );
    if (answer === null || !(await session.cleanTabsOrExplain(vault.vaultId, 'merge'))) {
      return;
    }
    await session.run(api.i18n.t('git.busy.merging'), 'merge', {
      vaultId: vault.vaultId,
      subPath: vault.subPath,
      name,
    });
  };

  const abortMerge = async (): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || vault.operation === null || (await refuseFound(vault))) {
      return;
    }
    const answer = await ask(
      api,
      api.i18n.t('git.cmd.abort.title'),
      api.i18n.t('git.cmd.abort.text'),
      [{ label: api.i18n.t('git.cmd.abort.confirm'), value: 'abort', danger: true }],
    );
    if (answer === null || !(await session.cleanTabsOrExplain(vault.vaultId, 'abort_merge'))) {
      return;
    }
    await session.run(api.i18n.t('git.busy.aborting_merge'), 'mergeAbort', {
      vaultId: vault.vaultId,
      subPath: vault.subPath,
    });
  };

  const resolveConflict = async (change: GitChange, side: 'ours' | 'theirs'): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || (await refuseFound(vault))) {
      return;
    }
    if (session.dirtyDocs(vault.vaultId).some((d) => d.path === change.path)) {
      await api.ui.showMessage(
        api.i18n.t('git.cmd.path_unsaved', { path: change.path }),
        api.i18n.t('git.cmd.merge.message_title'),
      );
      return;
    }
    const keepLabel = side === 'ours' ? api.i18n.t('git.cmd.keep_mine') : api.i18n.t('git.cmd.keep_theirs');
    const answer = await ask(
      api,
      keepLabel,
      side === 'ours'
        ? api.i18n.t('git.cmd.keep_mine_text', { path: change.path })
        : api.i18n.t('git.cmd.keep_theirs_text', { path: change.path }),
      [{ label: keepLabel, value: 'resolve', primary: true }],
    );
    if (answer !== null) {
      await session.run(api.i18n.t('git.busy.resolving'), 'resolve', {
        vaultId: vault.vaultId,
        subPath: vault.subPath,
        path: change.path,
        side,
      });
    }
  };

  const toggleAmend = async (): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || state.busy !== null || (await refuseFound(vault))) {
      return;
    }
    if (state.amend) {
      state.amend = false;
      session.notify();
      return;
    }
    if (vault.operation !== null) {
      await api.ui.showMessage(api.i18n.t('git.cmd.amend.merge_first'), api.i18n.t('git.cmd.amend.title'));
      return;
    }
    const { upstream, ahead, head: commitId } = vault.status;
    if (commitId === null) {
      await api.ui.showMessage(api.i18n.t('git.cmd.amend.no_commit'), api.i18n.t('git.cmd.amend.title'));
      return;
    }
    if (upstream !== null && ahead === 0) {
      await api.ui.showMessage(
        api.i18n.t('git.cmd.amend.published', { upstream }),
        api.i18n.t('git.cmd.amend.title'),
      );
      return;
    }
    state.amend = true;
    if ((state.drafts.get(keyOf(vault)) ?? '').trim() === '') {
      try {
        const text = (await api.backend.invoke('headMessage', {
          vaultId: vault.vaultId,
          subPath: vault.subPath,
        })) as string;
        state.drafts.set(keyOf(vault), text);
      } catch {
        // The box stays empty: the commit keeps its message.
      }
    }
    session.notify();
  };

  const stashChanges = async (): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || (await refuseFound(vault))) {
      return;
    }
    if (vault.status.staged.length + vault.status.unstaged.length === 0) {
      await api.ui.showMessage(api.i18n.t('git.cmd.stash.nothing'), api.i18n.t('git.cmd.stash.message_title'));
      return;
    }
    const answer = await ask(api, api.i18n.t('git.cmd.stash.title'), api.i18n.t('git.cmd.stash.text'), [
      { label: api.i18n.t('git.cmd.stash.message_title'), value: 'stash', primary: true },
    ]);
    if (answer === null || !(await session.cleanTabsOrExplain(vault.vaultId, 'stash'))) {
      return;
    }
    await session.run(api.i18n.t('git.busy.stashing'), 'stashPush', { vaultId: vault.vaultId, subPath: vault.subPath });
  };

  const remote = async (label: string, method: 'fetch' | 'pull' | 'push'): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || (await refuseFound(vault))) {
      return;
    }
    if (method !== 'fetch' && vault.managedBy !== null) {
      await managedMessage(vault);
      return;
    }
    if (method === 'pull' && !(await session.cleanTabsOrExplain(vault.vaultId, 'pull'))) {
      return;
    }
    await session.run(label, method, { vaultId: vault.vaultId, subPath: vault.subPath }, true);
  };

  const discard = async (change: GitChange): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null || (await refuseFound(vault))) {
      return;
    }
    if (vault.managedBy !== null) {
      await managedMessage(vault);
      return;
    }
    if (session.dirtyDocs(vault.vaultId).some((d) => d.path === change.path)) {
      await api.ui.showMessage(
        api.i18n.t('git.cmd.path_unsaved', { path: change.path }),
        api.i18n.t('git.cmd.discard.confirm'),
      );
      return;
    }
    const untracked = change.kind === 'untracked';
    const answer = await ask(
      api,
      api.i18n.t('git.cmd.discard.title'),
      untracked
        ? api.i18n.t('git.cmd.discard.text_untracked', { path: change.path })
        : api.i18n.t('git.cmd.discard.text_tracked', { path: change.path }),
      [
        {
          label: untracked ? api.i18n.t('git.cmd.discard.delete_file') : api.i18n.t('git.cmd.discard.confirm'),
          value: 'discard',
          danger: true,
        },
      ],
    );
    if (answer !== null) {
      await session.run(api.i18n.t('git.busy.discarding'), 'discard', {
        vaultId: vault.vaultId,
        subPath: vault.subPath,
        paths: [change.path],
      });
    }
  };

  const showDiff = async (change: GitChange, group: Group): Promise<void> => {
    const vault = session.currentOk();
    if (vault === null) {
      return;
    }
    const vaultId = vault.vaultId;
    const subPath = vault.subPath;
    if (group === 'conflicts') {
      await api.documents.open(change.path, undefined, { vaultId });
      return;
    }
    const side = async (path: string, rev: 'head' | 'index' | 'worktree') =>
      (await api.backend.invoke('fileAt', { vaultId, subPath, path, rev })) as { content: string | null; binary: boolean };
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
        await api.ui.showMessage(
          api.i18n.t('git.cmd.diff.not_text', { path: change.path }),
          api.i18n.t('git.dialog.git'),
        );
        return;
      }
      const staged = group === 'staged';
      await api.ui.showDiff({
        title: staged ? api.i18n.t('git.cmd.diff.title_staged') : api.i18n.t('git.cmd.diff.title_changes'),
        path: change.path,
        before: before.content ?? '',
        after: after.content ?? '',
        beforeLabel: staged ? api.i18n.t('git.cmd.diff.last_commit') : api.i18n.t('git.cmd.diff.before'),
        afterLabel: staged ? api.i18n.t('git.cmd.diff.staged') : api.i18n.t('git.cmd.diff.working_copy'),
      });
    } catch (error) {
      await api.ui.showMessage(messageOf(error), api.i18n.t('git.dialog.git'));
    }
  };

  return { commit, mergeBranch, abortMerge, resolveConflict, toggleAmend, stashChanges, remote, discard, showDiff };
}
