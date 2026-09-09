import { Injectable, computed, signal } from '@angular/core';
import { leafIds, moveWithinArray, PaneNode, removeLeaf, replaceLeaf } from './pane-tree';

/** One editor pane's tab strip: an ordered subset of `EditorService`'s open paths, plus which is active. */
export interface PaneRecord {
  readonly id: string;
  readonly tabs: readonly string[];
  readonly active: string | null;
}

const FIRST_PANE_ID = 'p1';

/**
 * Owns the editor pane layout: an arbitrary tree of row/column splits down
 * to leaves, each leaf a pane with its own tab strip (`PaneRecord`).
 *
 * `EditorService` stays the single registry of open documents (buffer,
 * dirty state, kind, eol -- unchanged); this service only decides *which*
 * pane's tab strip a given open path currently belongs to, and which pane
 * has focus. That split keeps every existing single-document consumer
 * (Assistant, Tasks, Actions/Save, the status bar, MCP tools, keybindings,
 * tag search, the calendar, ~20 files in all) working unmodified: they all
 * read `EditorService`'s "active document", which is now simply "the
 * focused pane's active path" (see `EditorService.activePath`).
 *
 * Deliberate scope for this first pass (see ADR-0037):
 * - **One pane per path.** A note open in pane A is not also open in B --
 *   opening it while B is focused just focuses A. Avoids two independent
 *   CodeMirror views racing over one shared buffer's cursor/scroll/undo.
 * - **Split, not drag-to-edge.** New panes come from an explicit "Split
 *   right" / "Split down" command on a tab; a tab *can* be dragged from one
 *   existing pane's strip into another's to move it. Dragging to an edge to
 *   auto-split is a documented follow-up, not built here.
 * - **Docking a pane into the left/right/bottom dock is a separate, later
 *   piece of work** (ADR-0037's Phase 2) -- this service only knows about
 *   the centre-column split tree.
 */
@Injectable({ providedIn: 'root' })
export class PaneService {
  // Not session-persisted, same as `EditorService.docs` -- there is no
  // open-tab restore across a restart today, so a restored *layout* with no
  // tabs in it would just be empty panes cluttering the screen. Always
  // starts as one pane, exactly like the single-pane tab bar did before.
  private readonly _root = signal<PaneNode>({ kind: 'leaf', paneId: FIRST_PANE_ID });
  private readonly _panes = signal<Record<string, PaneRecord>>({
    [FIRST_PANE_ID]: { id: FIRST_PANE_ID, tabs: [], active: null },
  });
  private readonly _focusedId = signal<string>(FIRST_PANE_ID);
  private nextPaneNum = 2;
  private nextSplitNum = 1;

  /** The split-tree layout (row/column splits down to leaf panes). */
  readonly root = this._root.asReadonly();
  /** Every leaf pane, in document (reading) order. */
  readonly paneIds = computed(() => leafIds(this._root()));
  readonly focusedId = this._focusedId.asReadonly();
  readonly focusedPane = computed<PaneRecord | null>(() => this._panes()[this._focusedId()] ?? null);

  pane(id: string): PaneRecord | null {
    return this._panes()[id] ?? null;
  }

  /** The pane (if any) already showing `path` as a tab -- the focused pane wins if it qualifies. */
  paneIdFor(path: string): string | null {
    const panes = this._panes();
    const focused = panes[this._focusedId()];
    if (focused?.tabs.includes(path)) {
      return focused.id;
    }
    for (const id of this.paneIds()) {
      if (panes[id]?.tabs.includes(path)) {
        return id;
      }
    }
    return null;
  }

  /** Sets which pane has focus (a click or keystroke landing in its editor). No-op for an unknown id. */
  focus(paneId: string): void {
    if (this._panes()[paneId]) {
      this._focusedId.set(paneId);
    }
  }

  /**
   * Opens `path` in the focused pane, or -- since a path lives in one pane
   * at a time -- focuses and activates the pane that already has it.
   */
  open(path: string): void {
    const existing = this.paneIdFor(path);
    if (existing) {
      this.activate(existing, path);
      return;
    }
    this.mutatePanes((panes) => {
      const id = this._focusedId();
      const pane = panes[id];
      panes[id] = { ...pane, tabs: [...pane.tabs, path], active: path };
    });
  }

  /** Activates `path` in `paneId` and focuses that pane. No-op if it isn't a tab there. */
  activate(paneId: string, path: string): void {
    const pane = this._panes()[paneId];
    if (!pane || !pane.tabs.includes(path)) {
      return;
    }
    this.mutatePanes((panes) => {
      panes[paneId] = { ...panes[paneId], active: path };
    });
    this._focusedId.set(paneId);
  }

  /** Reorders `path` within its own pane's tab strip (the tab-bar drag). */
  reorder(paneId: string, path: string, toIndex: number): void {
    const pane = this._panes()[paneId];
    if (!pane) {
      return;
    }
    this.mutatePanes((panes) => {
      panes[paneId] = { ...pane, tabs: moveWithinArray(pane.tabs, path, toIndex) };
    });
  }

  /**
   * Closes `path` in `paneId` only. If that empties the pane, the pane is
   * removed from the layout (or -- if it's the tree's only pane -- just left
   * empty; `EditorService`'s "no docs open" empty state covers that).
   */
  closeInPane(paneId: string, path: string): void {
    const pane = this._panes()[paneId];
    if (!pane || !pane.tabs.includes(path)) {
      return;
    }
    const idx = pane.tabs.indexOf(path);
    const tabs = pane.tabs.filter((p) => p !== path);
    const active = pane.active === path ? (tabs[idx] ?? tabs[idx - 1] ?? null) : pane.active;
    this.mutatePanes((panes) => {
      panes[paneId] = { ...pane, tabs, active };
    });
    if (tabs.length === 0) {
      this.collapse(paneId);
    }
  }

  /** Closes `path` wherever it is open (the "Open windows" list / File menu close). */
  closeEverywhere(path: string): void {
    for (const id of this.paneIds()) {
      this.closeInPane(id, path);
    }
  }

  closeAllInPane(paneId: string): void {
    for (const path of [...(this._panes()[paneId]?.tabs ?? [])]) {
      this.closeInPane(paneId, path);
    }
  }

  closeOthersInPane(paneId: string, keep: string): void {
    for (const path of [...(this._panes()[paneId]?.tabs ?? [])]) {
      if (path !== keep) {
        this.closeInPane(paneId, path);
      }
    }
  }

  /**
   * Moves `path` to `toPaneId` at `toIndex` (cross-pane tab-bar drag). A
   * same-pane move is just a reorder. Focuses the destination pane; if the
   * source pane empties, it collapses out of the layout.
   */
  moveToPane(path: string, toPaneId: string, toIndex: number): void {
    const fromId = this.paneIdFor(path);
    if (!fromId || !this._panes()[toPaneId]) {
      return;
    }
    if (fromId === toPaneId) {
      this.reorder(toPaneId, path, toIndex);
      return;
    }
    let emptied = false;
    this.mutatePanes((panes) => {
      const from = panes[fromId];
      const idx = from.tabs.indexOf(path);
      const tabs = from.tabs.filter((p) => p !== path);
      const active = from.active === path ? (tabs[idx] ?? tabs[idx - 1] ?? null) : from.active;
      panes[fromId] = { ...from, tabs, active };
      emptied = tabs.length === 0;

      const to = panes[toPaneId];
      const targetTabs = to.tabs.slice();
      targetTabs.splice(Math.max(0, Math.min(targetTabs.length, toIndex)), 0, path);
      panes[toPaneId] = { ...to, tabs: targetTabs, active: path };
    });
    this._focusedId.set(toPaneId);
    if (emptied) {
      this.collapse(fromId);
    }
  }

  /**
   * Splits `paneId` in `direction`. `path` (if it's a tab there) moves into
   * the brand-new sibling pane, which becomes focused; otherwise the new
   * pane opens empty (an internal building block -- the UI always passes a
   * tab to split off).
   */
  splitPane(paneId: string, direction: 'row' | 'column', path?: string): string | null {
    const pane = this._panes()[paneId];
    if (!pane) {
      return null;
    }
    const newId = `p${this.nextPaneNum++}`;
    const moving = path !== undefined && pane.tabs.includes(path);

    this.mutatePanes((panes) => {
      if (moving) {
        const tabs = pane.tabs.filter((p) => p !== path);
        const active = pane.active === path ? (tabs[0] ?? null) : pane.active;
        panes[paneId] = { ...pane, tabs, active };
      }
      panes[newId] = { id: newId, tabs: moving ? [path!] : [], active: moving ? path! : null };
    });

    this._root.update((root) =>
      replaceLeaf(root, paneId, {
        kind: 'split',
        id: `s${this.nextSplitNum++}`,
        direction,
        children: [
          { kind: 'leaf', paneId },
          { kind: 'leaf', paneId: newId },
        ],
        sizes: [1, 1],
      }),
    );
    this._focusedId.set(newId);
    return newId;
  }

  /** Splitter drag: new `flex-grow` weights for a split's children, by its id. */
  resizeSplit(splitId: string, sizes: readonly number[]): void {
    this._root.update((root) => resizeSplitNode(root, splitId, sizes));
  }

  /**
   * A file/folder rename or `EditorService.saveAs()` fork: re-points every
   * pane's reference to `oldPath` at `newPath`, keeping tab position and
   * active state. `EditorService.retargetTabs` calls this once per affected
   * document; it is the pane-layout half of that rename.
   */
  renamePath(oldPath: string, newPath: string): void {
    this.mutatePanes((panes) => {
      for (const id of Object.keys(panes)) {
        const pane = panes[id];
        if (!pane.tabs.includes(oldPath)) {
          continue;
        }
        panes[id] = {
          ...pane,
          tabs: pane.tabs.map((t) => (t === oldPath ? newPath : t)),
          active: pane.active === oldPath ? newPath : pane.active,
        };
      }
    });
  }

  /** Removes `paneId` from the tree (or empties it, if it's the tree's only pane). */
  private collapse(paneId: string): void {
    const root = this._root();
    if (root.kind === 'leaf' && root.paneId === paneId) {
      // The last pane never disappears -- it just has no tabs.
      return;
    }
    const next = removeLeaf(root, paneId);
    if (next !== root) {
      this._root.set(next);
      this.mutatePanes((panes) => {
        delete panes[paneId];
      });
      if (this._focusedId() === paneId) {
        this._focusedId.set(leafIds(next)[0] ?? FIRST_PANE_ID);
      }
    }
  }

  private mutatePanes(fn: (panes: Record<string, PaneRecord>) => void): void {
    this._panes.update((current) => {
      const next = { ...current };
      fn(next);
      return next;
    });
  }
}

function resizeSplitNode(node: PaneNode, splitId: string, sizes: readonly number[]): PaneNode {
  if (node.kind === 'leaf') {
    return node;
  }
  if (node.id === splitId) {
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => resizeSplitNode(c, splitId, sizes)) };
}
