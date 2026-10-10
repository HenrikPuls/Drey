import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';

/**
 * The Backlinks plugin's dock panel (milestone 54, req-39): follows the
 * focused vault note like Outline and lists every note whose
 * `[[wikilink]]` resolves to it — file, section heading, the linking line
 * — one click opens the linking note at the line. The rows come from the
 * plugin's main-side outlink index (backend `backlinks`), refreshed via
 * the `links-updated` push after every index mutation.
 */

interface BacklinkRow {
  path: string;
  heading: string;
  line: number;
  snippet: string;
}

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

const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    const state = {
      isVaultText: false,
      activePath: null as string | null,
      activeVault: null as string | null,
      rows: [] as BacklinkRow[],
      error: null as string | null,
      querySeq: 0,
    };

    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const listener of [...listeners]) {
        listener();
      }
    };

    const pullActive = (): void => {
      const active = api.documents.active();
      const isVaultText = active !== null && active.kind === 'text' && active.vaultId !== null;
      state.isVaultText = isVaultText;
      state.activePath = isVaultText ? active.path : null;
      state.activeVault = isVaultText ? active.vaultId : null;
    };

    const query = async (): Promise<void> => {
      const seq = ++state.querySeq;
      state.error = null;
      if (!state.isVaultText || state.activePath === null || state.activeVault === null) {
        state.rows = [];
        notify();
        return;
      }
      try {
        const reply = (await api.backend.invoke('backlinks', {
          path: state.activePath,
          vaultId: state.activeVault,
        })) as { rows?: BacklinkRow[]; error?: string };
        if (seq !== state.querySeq) {
          return; // A newer focus switch already re-queried.
        }
        state.rows = Array.isArray(reply?.rows) ? reply.rows : [];
        state.error = typeof reply?.error === 'string' ? reply.error : null;
      } catch (error) {
        if (seq !== state.querySeq) {
          return;
        }
        state.rows = [];
        state.error = error instanceof Error ? error.message : String(error);
      }
      notify();
    };

    pullActive();
    void query();
    api.documents.onChange((event) => {
      if (event.type === 'active-changed' || event.type === 'docs-changed') {
        pullActive();
        notify();
        void query();
      }
    });
    // A save in ANOTHER file (or any index round) can change this note's
    // backlinks; the push says "re-query", the main side scopes it.
    api.backend.on('links-updated', () => {
      void query();
    });

    api.ui.registerWidget({
      id: 'backlinks',
      title: 'Backlinks',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 200,
      flush: true,
      status: () => (state.rows.length > 0 ? `${state.rows.length}` : null),
      mount: (body) => {
        body.classList.add('backlinks-panel');
        const list = el('div', 'list');
        body.append(list);

        const render = (): void => {
          list.textContent = '';
          if (state.error !== null) {
            list.append(el('p', 'empty', state.error));
            return;
          }
          if (!state.isVaultText) {
            list.append(el('p', 'empty', 'Open a note to see its backlinks.'));
            return;
          }
          if (state.rows.length === 0) {
            list.append(el('p', 'empty', 'No backlinks.'));
            return;
          }
          for (const row of state.rows) {
            const card = el('button', 'row') as HTMLButtonElement;
            card.type = 'button';
            const file = row.path.slice(row.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
            const dir = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : '';
            const head = el('span', 'file', file);
            card.title = `${row.path}:${row.line}`;
            card.appendChild(head);
            if (row.heading !== '') {
              card.appendChild(el('span', 'heading', row.heading));
            } else if (dir !== '') {
              card.appendChild(el('span', 'heading', dir));
            }
            card.appendChild(el('span', 'snippet', row.snippet));
            card.addEventListener('click', () => {
              if (state.activeVault !== null) {
                void api.documents.open(row.path, row.line, { vaultId: state.activeVault });
              }
            });
            list.appendChild(card);
          }
        };

        render();
        listeners.add(render);
        return () => {
          listeners.delete(render);
        };
      },
    });
  },
};

export default plugin;
