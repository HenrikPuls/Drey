/**
 * Replace (milestone 33). In file scope the open buffer is patched -- an
 * unsaved, undoable edit. In vault / all scope the backend previews the
 * patch per file and writes only after ONE bundled confirmation.
 */
import type { DreyPluginApi, TagSearchHit } from '../../../shared/plugin-api/renderer';
import { patchContent } from '../shared/search.js';
import { button, el } from './dom.js';
import type { SearchSession } from './search-session.js';

interface ReplaceOp {
  vaultId: string;
  path: string;
  occurrences: number;
  sections: number;
  added: number;
  removed: number;
  diff: Array<{ type: 'context' | 'add' | 'del'; text: string }>;
}

interface ReplacePreview {
  ok: boolean;
  ops?: ReplaceOp[];
  error?: string;
}

export interface SearchReplace {
  /** The replace row's button: every match of the current scope. */
  replaceAll(): void;
  /** A hit's own button: the matches in that hit's file. */
  replaceInFile(hit: TagSearchHit): void;
}

export function createSearchReplace(api: DreyPluginApi, session: SearchSession): SearchReplace {
  const { prefs, state } = session;

  const applyInFileScope = (): void => {
    const doc = session.activeTextDoc();
    if (doc === null) {
      return;
    }
    // The buffer is the working copy: this stays an unsaved, undoable edit.
    const patch = patchContent(doc.buffer, session.currentQuery(), state.replacement);
    if (patch === null || patch.after === patch.before) {
      return;
    }
    api.documents.setBuffer(doc.path, patch.after);
    void session.run();
  };

  const showConfirmation = (ops: ReplaceOp[], onDone: () => void): void => {
    const totalOccurrences = ops.reduce((n, op) => n + op.occurrences, 0);
    // `showModal` returns the programmatic close — the Cancel/Apply
    // closures below close over it.
    let close = (): void => {};
    close = api.ui.showModal((box) => {
      box.classList.add('tag-search-modal');
      box.appendChild(
        el(
          'h3',
          'tag-search-modal-title',
          `Replace ${totalOccurrences} occurrence${totalOccurrences === 1 ? '' : 's'} in ${ops.length} file${ops.length === 1 ? '' : 's'}?`,
        ),
      );
      box.appendChild(
        el(
          'p',
          'tag-search-modal-hint',
          'Only text inside the matching sections changes. Each file is re-checked right before it is written.',
        ),
      );
      for (const op of ops) {
        const details = el('details', 'tag-search-modal-file');
        const summary = el('summary', 'tag-search-modal-file-head');
        const foreign = prefs.scope === 'all' && op.vaultId !== session.activeVaultId();
        summary.appendChild(el('span', 'tag-search-modal-path', op.path));
        if (foreign) {
          summary.appendChild(el('span', 'tag-search-modal-vault', op.vaultId));
        }
        summary.appendChild(el('span', 'tag-search-modal-count', `${op.occurrences} ×`));
        details.appendChild(summary);
        const diff = el('div', 'tag-search-modal-diff');
        for (const row of op.diff) {
          if (row.type === 'context') {
            continue; // collapsed to the changed lines by default
          }
          const line = el(
            'span',
            row.type === 'add' ? 'tag-search-diff-add' : 'tag-search-diff-del',
            `${row.type === 'add' ? '+' : '−'} ${row.text}`,
          );
          diff.appendChild(line);
        }
        if (diff.childElementCount === 0) {
          diff.appendChild(el('span', 'tag-search-modal-empty', '(no line changes)'));
        }
        details.appendChild(diff);
        box.appendChild(details);
      }
      const row = el('div', 'tag-search-modal-actions');
      row.appendChild(
        button('ghost', 'Cancel', () => {
          close();
        }),
      );
      const apply = button('primary', 'Replace all', () => {
        void (async () => {
          apply.disabled = true;
          try {
            const result = (await api.backend.invoke('replace-apply', {
              query: session.currentQuery(),
              replacement: state.replacement,
              scope: prefs.scope === 'all' ? { kind: 'all' } : undefined,
              excludeChats: !prefs.includeChats,
            })) as { error?: string };
            if (result?.error !== undefined) {
              state.error = result.error;
            }
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
          }
          close();
          onDone();
        })();
      });
      row.appendChild(apply);
      box.appendChild(row);
    });
  };

  /**
   * Asks the backend for a fresh patch of `target` (TOCTOU-safe: each
   * file is re-checked right before it is written), then confirms.
   */
  const previewAndConfirm = async (target: Record<string, unknown>): Promise<void> => {
    try {
      const preview = (await api.backend.invoke('replace-preview', {
        query: session.currentQuery(),
        replacement: state.replacement,
        ...target,
      })) as ReplacePreview;
      if (!preview.ok || preview.ops === undefined) {
        state.error = preview.error ?? 'Replace preview failed.';
        session.notify();
        return;
      }
      if (preview.ops.length === 0) {
        return;
      }
      showConfirmation(preview.ops, () => void session.run());
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      session.notify();
    }
  };

  return {
    replaceAll: () => {
      if (prefs.scope === 'file') {
        applyInFileScope();
        return;
      }
      void previewAndConfirm({
        scope: prefs.scope === 'all' ? { kind: 'all' } : undefined,
        excludeChats: !prefs.includeChats,
      });
    },
    replaceInFile: (hit) => {
      if (prefs.scope === 'file') {
        applyInFileScope();
        return;
      }
      // Vault/all: one file's bundled confirmation.
      void previewAndConfirm({ files: [{ vaultId: hit.vaultId, path: hit.path }] });
    },
  };
}
