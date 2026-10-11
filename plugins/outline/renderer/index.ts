import type {
  CodeMirrorModules,
  DreyPluginApi,
  EditorSurfaceContext,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import {
  buildOutlineTree,
  parentKeys,
  scanOutline,
  type OutlineNode,
} from '../shared/outline.js';

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

/**
 * The document-slot surface the user interacted with last (caret moved,
 * typed, focused). The outline targets the ACTIVE document only, so a
 * record is used solely while its path matches `state.activePath`.
 * `path` comes from the surface context's live getter at update time.
 */
interface TrackedSurface {
  readonly path: string | null;
  readonly view: EditorView;
}

/**
 * The Outline plugin (req-28): the open note's heading tree as a dock
 * panel — collapsible levels, click an entry to jump to the heading,
 * the row at the caret highlighted. Renderer-only: it scans the live
 * buffer of the focused pane's document (doc scope), so every line it
 * shows is fresh — no disk index, no stale-line resolution needed for
 * the tree itself.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    // -- state ---------------------------------------------------------------
    const state = {
      isText: false,
      activePath: null as string | null,
      activeVault: null as string | null,
      buffer: '',
      /** 1-based caret line in the active document, for the row highlight. */
      caretLine: null as number | null,
      /** The header's collapse-all toggle (session-only). */
      allCollapsed: false,
    };
    /** Per-document expand/collapse state: doc key -> node key -> collapsed. */
    const collapsedByDoc = new Map<string, Map<string, boolean>>();
    const docKey = (): string => `${state.activeVault ?? ''}\u0000${state.activePath ?? ''}`;
    const collapsedFor = (): Map<string, boolean> => {
      let map = collapsedByDoc.get(docKey());
      if (map === undefined) {
        map = new Map();
        collapsedByDoc.set(docKey(), map);
      }
      return map;
    };

    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const listener of [...listeners]) {
        listener();
      }
    };
    /** Fine-grained: only the caret highlight moves (fires per keystroke). */
    let applyHighlight: (() => void) | null = null;

    const entriesNow = (): ReturnType<typeof scanOutline> =>
      state.isText ? scanOutline(state.buffer) : [];

    // -- active document: the focused pane's live buffer ---------------------
    const offsetToLine = (buffer: string, offset: number): number => {
      let line = 1;
      const end = Math.min(offset, buffer.length);
      for (let i = 0; i < end; i++) {
        if (buffer.charCodeAt(i) === 10) {
          line++;
        }
      }
      return line;
    };
    const pullActive = (): void => {
      const active = api.documents.active();
      const isText = active !== null && active.kind === 'text';
      state.isText = isText;
      state.activePath = isText ? active.path : null;
      state.activeVault = isText ? active.vaultId : null;
      state.buffer = isText ? active.buffer : '';
      state.caretLine =
        isText && active.selection !== null
          ? offsetToLine(active.buffer, active.selection.from)
          : null;
    };
    pullActive();
    api.documents.onChange((event) => {
      if (event.type === 'active-changed' || event.type === 'docs-changed') {
        pullActive();
        notify();
        return;
      }
      if (event.type === 'buffer-changed' && event.path === state.activePath) {
        state.buffer = event.content;
        notify();
      }
    });

    // -- editor extension: track the focused surface's caret ------------------
    // There is no selection event in the document API, so the caret line
    // (for the highlight) and the reveal target (for clicks) come from an
    // `updateListener` on the document-slot surfaces, built from the HOST's
    // CodeMirror modules (ADR-0044 rule 1).
    let tracked: TrackedSurface | null = null;
    const onCaretMoved = (surface: TrackedSurface, line: number): void => {
      tracked = surface;
      if (surface.path === state.activePath) {
        state.caretLine = line;
        applyHighlight?.();
      }
    };
    api.editor.registerExtension('document', (context: EditorSurfaceContext) => {
      const cm: CodeMirrorModules = api.editor.cm;
      return cm.view.EditorView.updateListener.of((update: ViewUpdate) => {
        if (!(update.selectionSet || update.docChanged || update.focusChanged)) {
          return;
        }
        const view = update.view;
        const head = view.state.selection.main.head;
        onCaretMoved({ path: context.path(), view }, view.state.doc.lineAt(head).number);
      });
    });

    // -- navigation ------------------------------------------------------------
    /**
     * Jumps to a heading of the ACTIVE document. Preferred path: dispatch
     * the caret move straight into the tracked editor view — that works
     * for every doc shape (vault note, scratch tab, pinned external tab)
     * and can never open a duplicate tab. `documents.open` is only the
     * fallback for vault docs when no view was tracked yet (it resolves
     * non-vault paths against the active vault and would only raise an
     * error banner for them).
     */
    const reveal = async (line: number): Promise<void> => {
      const surface = tracked !== null && tracked.path === state.activePath ? tracked : null;
      if (surface !== null) {
        try {
          const doc = surface.view.state.doc;
          const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
          surface.view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
          surface.view.focus();
          return;
        } catch {
          // The view died since (tab closed / pane switch) — fall through.
        }
      }
      if (state.activeVault !== null && state.activePath !== null) {
        await api.documents.open(state.activePath, line, { vaultId: state.activeVault });
      }
    };
    /**
     * The line a rendered row should jump to, resolved against the CURRENT
     * buffer via the node's stable key — the row's line was scanned at
     * render time and a keystroke inside the ~150 ms event debounce can
     * shift it (same fold as the tasks panel's `resolveTaskLine`).
     */
    const resolveLine = (key: string, fallbackLine: number): number => {
      const find = (nodes: readonly OutlineNode[]): number | null => {
        for (const node of nodes) {
          if (node.key === key) {
            return node.entry.line;
          }
          const inChildren = find(node.children);
          if (inChildren !== null) {
            return inChildren;
          }
        }
        return null;
      };
      return find(buildOutlineTree(scanOutline(state.buffer))) ?? fallbackLine;
    };

    // -- the Outline dock panel -------------------------------------------------
    api.ui.registerWidget({
      id: 'outline',
      title: 'Outline',
      icon: 'list',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 220,
      flush: true,
      status: () => {
        const count = entriesNow().length;
        return count > 0 ? `${count}` : null;
      },
      headerActions: (host) => {
        const row = el('div', 'outline-hdr');
        const fold = el('button', 'icon-btn') as HTMLButtonElement;
        fold.type = 'button';
        fold.appendChild(api.ui.icon('chevrons-down-up', 14));
        const renderFold = (): void => {
          const label = state.allCollapsed ? 'Expand all levels' : 'Collapse all levels';
          fold.classList.toggle('on', state.allCollapsed);
          fold.setAttribute('aria-pressed', String(state.allCollapsed));
          fold.setAttribute('aria-label', label);
          fold.title = label;
        };
        fold.addEventListener('click', () => {
          state.allCollapsed = !state.allCollapsed;
          const collapsed = collapsedFor();
          if (state.allCollapsed) {
            for (const key of parentKeys(buildOutlineTree(entriesNow()))) {
              collapsed.set(key, true);
            }
          } else {
            collapsed.clear();
          }
          notify();
        });
        renderFold();
        listeners.add(renderFold);
        row.appendChild(fold);
        host.appendChild(row);
        return () => {
          listeners.delete(renderFold);
        };
      },
      mount: (body) => {
        body.classList.add('outline-panel');
        const tree = el('div', 'tree');
        body.append(tree);

        /** The visible rows in document order, for the caret highlight. */
        let visibleRows: { line: number; el: HTMLElement }[] = [];

        const applyHighlightNow = (): void => {
          let current: HTMLElement | null = null;
          if (state.caretLine !== null) {
            // The last visible row at or above the caret: the entry itself,
            // or — when its own subtree is collapsed — the nearest visible
            // ancestor (entries precede their subtree in document order).
            for (const row of visibleRows) {
              if (row.line <= state.caretLine) {
                current = row.el;
              } else {
                break;
              }
            }
          }
          for (const row of visibleRows) {
            row.el.classList.toggle('current', row.el === current);
          }
        };

        const render = (): void => {
          tree.textContent = '';
          visibleRows = [];
          if (!state.isText) {
            tree.append(el('p', 'empty', 'Open a note to see its outline.'));
            return;
          }
          const entries = scanOutline(state.buffer);
          if (entries.length === 0) {
            tree.append(el('p', 'empty', 'No headings in this document.'));
            return;
          }
          const collapsed = collapsedFor();

          const renderNodes = (nodes: readonly OutlineNode[], depth: number): void => {
            for (const node of nodes) {
              const hasChildren = node.children.length > 0;
              const isCollapsed =
                hasChildren && (state.allCollapsed || collapsed.get(node.key) === true);

              const row = el('div', 'row');
              row.style.paddingLeft = `${(depth - 1) * 12 + 2}px`;

              if (hasChildren) {
                const twist = el('button', 'twist', '▸') as HTMLButtonElement;
                twist.type = 'button';
                twist.title = isCollapsed ? 'Expand' : 'Collapse';
                twist.setAttribute('aria-expanded', String(!isCollapsed));
                if (!isCollapsed) {
                  twist.classList.add('open');
                }
                twist.addEventListener('click', () => {
                  const expanding = collapsed.get(node.key) === true;
                  if (expanding) {
                    state.allCollapsed = false;
                    collapsed.delete(node.key);
                  } else {
                    collapsed.set(node.key, true);
                  }
                  notify();
                });
                row.appendChild(twist);
              } else {
                row.appendChild(el('span', 'twist-sp'));
              }

              const label = el('button', `label h${node.entry.level}`, node.entry.title);
              label.type = 'button';
              label.title = node.entry.title;
              label.addEventListener('click', () => {
                void reveal(resolveLine(node.key, node.entry.line));
              });
              row.appendChild(label);

              visibleRows.push({ line: node.entry.line, el: row });
              tree.appendChild(row);
              if (!isCollapsed) {
                renderNodes(node.children, depth + 1);
              }
            }
          };
          renderNodes(buildOutlineTree(entries), 1);
          applyHighlightNow();
        };

        render();
        listeners.add(render);
        applyHighlight = applyHighlightNow;
        return () => {
          listeners.delete(render);
          applyHighlight = null;
        };
      },
    });
  },
};

export default plugin;
