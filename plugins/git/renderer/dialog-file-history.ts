import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { parsePatch, type GitLogEntry } from '../shared/status.js';
import { el, formatWhen, messageOf, textButton } from './dom.js';
import { patchLineText } from './repo-model.js';
import type { RepoSession } from './repo-session.js';

/** Patch lines drawn per commit; the rest is counted in a last line. */
const MAX_LINES = 400;

/**
 * "Git history" of one file (milestone 67): the commits that changed it
 * on the left, the chosen commit's changes on the right, and "Restore
 * this version" into the editor. `requested` is the path from the
 * editor's context menu; without it the focused document is taken.
 */
export async function openFileHistory(api: DreyPluginApi, session: RepoSession, requested?: string): Promise<void> {
  const vault = session.currentOk();
  const active = api.documents.active();
  const path = requested ?? active?.path ?? '';
  if (vault === null || active === null || path === '' || active.vaultId !== vault.vaultId) {
    await api.ui.showMessage(api.i18n.t('git.file_history.open_first'), api.i18n.t('git.file_history.title'));
    return;
  }
  const vaultId = vault.vaultId;
  let entries: GitLogEntry[];
  try {
    entries = (await api.backend.invoke('fileLog', { vaultId, path })) as GitLogEntry[];
  } catch (error) {
    await api.ui.showMessage(messageOf(error), api.i18n.t('git.file_history.title'));
    return;
  }
  if (entries.length === 0) {
    await api.ui.showMessage(api.i18n.t('git.file_history.not_committed', { path }), api.i18n.t('git.file_history.title'));
    return;
  }
  const metaOf = (entry: GitLogEntry): string => `${entry.author} · ${formatWhen(entry.date)} · ${entry.hash}`;

  const close = api.ui.showModal((box) => {
    box.classList.add('git-dialog', 'wide');
    box.append(
      el('h2', 'git-dialog-title', api.i18n.t('git.file_history.title')),
      el('p', 'git-dialog-sub', api.i18n.t('git.file_history.sub', { path, count: entries.length })),
    );
    const body = el('div', 'git-history-body');
    const listNode = el('div', 'git-history-list');
    listNode.setAttribute('role', 'listbox');
    listNode.setAttribute('aria-label', api.i18n.t('git.file_history.commits_label'));
    const detail = el('div', 'git-history-detail');
    body.append(listNode, detail);

    let selected = 0;
    let token = 0;

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
      head.append(el('div', 'subject', entry.subject), el('div', 'meta', metaOf(entry)));
      const diff = el('div', 'git-diff');
      diff.setAttribute('aria-label', api.i18n.t('git.file_history.changes_label'));
      detail.append(head, diff);
      diff.appendChild(el('div', 'hunk', api.i18n.t('git.file_history.loading')));
      try {
        const patch = (await api.backend.invoke('filePatch', { vaultId, path, hash: entry.hash })) as string;
        if (mine !== token) {
          return;
        }
        diff.textContent = '';
        const lines = parsePatch(patch);
        if (lines.length === 0) {
          diff.appendChild(el('div', 'hunk', api.i18n.t('git.file_history.no_changes')));
        }
        for (const line of lines.slice(0, MAX_LINES)) {
          diff.appendChild(el('div', line.kind === 'context' ? undefined : line.kind, patchLineText(line)));
        }
        if (lines.length > MAX_LINES) {
          diff.appendChild(el('div', 'hunk', api.i18n.t('git.file_history.more_lines', { count: lines.length - MAX_LINES })));
        }
      } catch (error) {
        if (mine === token) {
          diff.textContent = '';
          diff.appendChild(el('div', 'hunk', messageOf(error)));
        }
      }
    };

    const restoreSelected = async (): Promise<void> => {
      const entry = entries[selected];
      try {
        const side = (await api.backend.invoke('fileAt', { vaultId, path, rev: entry.hash })) as {
          content: string | null;
          binary: boolean;
        };
        if (side.binary || side.content === null) {
          await api.ui.showMessage(
            side.binary
              ? api.i18n.t('git.file_history.not_text', { path })
              : api.i18n.t('git.file_history.not_in_commit', { path }),
            api.i18n.t('git.file_history.title'),
          );
          return;
        }
        close();
        await api.documents.open(path, undefined, { vaultId });
        if (!api.documents.setBuffer(path, side.content)) {
          await api.ui.showMessage(api.i18n.t('git.file_history.put_failed'), api.i18n.t('git.file_history.title'));
        }
      } catch (error) {
        await api.ui.showMessage(messageOf(error), api.i18n.t('git.file_history.title'));
      }
    };

    const actions = el('div', 'git-dialog-actions');
    const restore = textButton('git-btn', api.i18n.t('git.file_history.restore'), () => void restoreSelected());
    restore.title = api.i18n.t('git.file_history.restore_hint');
    actions.append(
      restore,
      textButton('git-btn primary', api.i18n.t('git.dialog.close'), () => close()),
    );
    box.append(body, actions);

    entries.forEach((entry, i) => {
      const row = el('div', 'git-commit');
      row.setAttribute('role', 'option');
      row.tabIndex = 0;
      row.append(el('span', 'subject', entry.subject), el('span', 'meta', metaOf(entry)));
      row.addEventListener('click', () => void select(i));
      listNode.appendChild(row);
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
}
