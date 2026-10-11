import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { parsePatch, type GitLogEntry } from '../shared/status.js';
import { el, formatWhen, messageOf, textButton } from './dom.js';
import { counted, patchLineText } from './repo-model.js';
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
  const metaOf = (entry: GitLogEntry): string => `${entry.author} · ${formatWhen(entry.date)} · ${entry.hash}`;

  const close = api.ui.showModal((box) => {
    box.classList.add('git-dialog', 'wide');
    box.append(
      el('h2', 'git-dialog-title', 'Git history'),
      el('p', 'git-dialog-sub', `${path} · ${counted(entries.length, 'commit')}`),
    );
    const body = el('div', 'git-history-body');
    const listNode = el('div', 'git-history-list');
    listNode.setAttribute('role', 'listbox');
    listNode.setAttribute('aria-label', 'Commits that changed this file');
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
      diff.setAttribute('aria-label', 'Changes in this commit');
      detail.append(head, diff);
      diff.appendChild(el('div', 'hunk', 'Loading…'));
      try {
        const patch = (await api.backend.invoke('filePatch', { vaultId, path, hash: entry.hash })) as string;
        if (mine !== token) {
          return;
        }
        diff.textContent = '';
        const lines = parsePatch(patch);
        if (lines.length === 0) {
          diff.appendChild(el('div', 'hunk', 'No text changes to show (binary file or a rename).'));
        }
        for (const line of lines.slice(0, MAX_LINES)) {
          diff.appendChild(el('div', line.kind === 'context' ? undefined : line.kind, patchLineText(line)));
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

    const restoreSelected = async (): Promise<void> => {
      const entry = entries[selected];
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
    };

    const actions = el('div', 'git-dialog-actions');
    const restore = textButton('git-btn', 'Restore this version', () => void restoreSelected());
    restore.title = 'Puts this version into the editor. Save to keep it.';
    actions.append(
      restore,
      textButton('git-btn primary', 'Close', () => close()),
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
