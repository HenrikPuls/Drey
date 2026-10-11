import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';
import { openFileHistory } from './dialog-file-history.js';
import { openStashList } from './dialog-stashes.js';
import { createSourceControlWidget } from './panel.js';
import { openBranchPicker } from './picker-branch.js';
import { createRepoCommands } from './repo-commands.js';
import { createRepoSession } from './repo-session.js';
import { createGitSettingsPage } from './settings-page.js';

/**
 * The Git plugin's renderer (milestone 65, ADR-0065): the "Source control"
 * dock panel and the Files-panel decorations. All git work happens in the
 * plugin's main entry; this side shows the pushed state, asks before
 * anything that can lose text, and hands the status to the Files panel
 * (`api.ui.setFileDecorations`).
 *
 * The panel shows ONE repository: the vault of the focused document when
 * that vault is a Git repository, otherwise the last one shown.
 *
 * This file only wires the parts: the state (`repo-session.ts`), the
 * commands (`repo-commands.ts`), the widget (`panel.ts`) and the dialogs.
 */

/** Removes the listeners `activate` installed. */
let cleanup: (() => void) | null = null;

const plugin: PluginRendererModule = {
  async activate(api: DreyPluginApi) {
    const session = createRepoSession(api);
    const commands = createRepoCommands(api, session);
    cleanup = session.watch();

    api.commands.register({ id: 'git.commit', label: 'Git: Commit', run: () => void commands.commit() });
    api.commands.register({
      id: 'git.commitAndPush',
      label: 'Git: Commit and push',
      run: () => void commands.commit(true),
    });
    api.commands.register({
      id: 'git.merge',
      label: 'Git: Merge a branch…',
      run: () => void openBranchPicker(api, session, commands, 'merge'),
    });
    api.commands.register({ id: 'git.stash', label: 'Git: Stash changes', run: () => void commands.stashChanges() });
    api.commands.register({ id: 'git.stashes', label: 'Git: Stashes…', run: () => void openStashList(api, session) });
    api.commands.register({
      id: 'git.fileHistory',
      label: 'Git: History of this file…',
      run: () => void openFileHistory(api, session),
    });
    api.editor.registerContextMenuItems((target) => {
      const vault = session.currentOk();
      const active = api.documents.active();
      if (target.surface !== 'editor' || target.docPath === null || vault === null || active === null) {
        return [];
      }
      if (active.vaultId !== vault.vaultId) {
        return [];
      }
      const path = target.docPath;
      return [{ label: 'Git history…', run: () => void openFileHistory(api, session, path) }];
    });
    api.commands.register({ id: 'git.push', label: 'Git: Push', run: () => void commands.remote('Pushing…', 'push') });
    api.commands.register({ id: 'git.pull', label: 'Git: Pull', run: () => void commands.remote('Pulling…', 'pull') });
    api.commands.register({ id: 'git.refresh', label: 'Git: Refresh status', run: () => void session.pull('relocate') });

    api.ui.registerWidget(createSourceControlWidget(api, session, commands));
    api.ui.registerSettingsPage(createGitSettingsPage(api, session));

    void session.pull('cached');
  },

  deactivate() {
    cleanup?.();
    cleanup = null;
  },
};

export default plugin;
