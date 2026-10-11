import { Injectable, computed, inject, signal } from '@angular/core';
import { docKey } from '../../services/editor.service';
import { VaultService } from '../../vault';
import {
  SelectionModifiers,
  TreeTarget,
  VisibleNode,
  ancestorKeys,
  directoryKeys,
  everyFolderExpanded,
  flattenVisible,
  keyOf,
  rangeOver,
} from './files-tree';

/**
 * The Files panel's view state: which folders and vault sections are open,
 * where the keyboard cursor sits and what is selected. One instance per
 * panel (provided by `FilesPanel`), nothing persisted -- a restart
 * collapses the tree again.
 */
@Injectable()
export class FilesTreeState {
  private readonly vault = inject(VaultService);

  /**
   * Folder paths the user has EXPANDED, per vault (composite keys). Folders
   * start COLLAPSED each session (the beta feedback: a big vault opened as
   * one wall of expanded trees) -- an empty set is the resting state.
   * Tab activation auto-expands the active file's ancestors (`revealDoc`).
   */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Vault ids whose whole section the user collapsed. */
  readonly collapsedVaults = signal<ReadonlySet<string>>(new Set());

  /**
   * The tree row the keyboard cursor sits on (a composite key). Distinct
   * from the open file -- this is a roving selection for Up/Down/Left/Right
   * navigation, like a file explorer. The panel moves DOM focus onto it
   * whenever it changes through `select()` / `selectAt()` (`onCursorMoved`).
   */
  readonly selected = signal<string | null>(null);

  /**
   * The multi-selection (bug-8): every highlighted composite key, cursor
   * row included. A plain click / plain arrow key collapses it back to
   * `{selected}`; Ctrl+click toggles rows and Shift+click / Shift+arrow
   * extend a range over the visible rows (the anchor is where the range
   * grows from). A selection never spans vaults silently -- ranges walk the
   * visible rows whatever vault they belong to, and a delete acts per vault.
   */
  readonly selection = signal<ReadonlySet<string>>(new Set());

  /** The row a Shift-range extends from (the last plain-selected row). */
  private readonly anchor = signal<string | null>(null);

  /** The rows the tree shows right now, in display order. */
  readonly visibleNodes = computed<VisibleNode[]>(() =>
    flattenVisible(this.vault.vaults(), this.vault.trees(), this.collapsedVaults(), this.expanded()),
  );

  /** Drives the header toggle: "Expand all" while any folder is still collapsed. */
  readonly allFoldersExpanded = computed<boolean>(() =>
    everyFolderExpanded(this.vault.trees(), this.expanded()),
  );

  private cursorMoved: () => void = () => undefined;

  /** The panel registers what happens after the cursor row moved (scroll into view + focus). */
  onCursorMoved(follow: () => void): void {
    this.cursorMoved = follow;
  }

  isExpanded(key: string): boolean {
    return this.expanded().has(key);
  }

  toggleFolder(key: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  toggleVaultSection(vaultId: string): void {
    this.collapsedVaults.update((set) => {
      const next = new Set(set);
      if (next.has(vaultId)) {
        next.delete(vaultId);
      } else {
        next.add(vaultId);
      }
      return next;
    });
  }

  /** Expands every folder when one is still collapsed, else collapses them all. */
  toggleAllFolders(): void {
    this.expanded.set(this.allFoldersExpanded() ? new Set() : directoryKeys(this.vault.trees()));
  }

  /**
   * Expands `dir` AND every ancestor above it, so a reveal inside a
   * collapsed tree actually shows the row (a single-folder flip would open
   * a folder whose parents are still shut).
   */
  expandAncestors(vaultId: string | null, dir: string): void {
    const keys = ancestorKeys(vaultId, dir);
    if (keys.length === 0) {
      return;
    }
    this.expanded.update((set) => new Set([...set, ...keys]));
  }

  unfoldVault(vaultId: string): void {
    this.collapsedVaults.update((set) => {
      if (!set.has(vaultId)) {
        return set;
      }
      const next = new Set(set);
      next.delete(vaultId);
      return next;
    });
  }

  /**
   * Makes the row of an open document (`vaultId::path`) visible: its
   * ancestor folders expand and its vault section unfolds. A document in
   * the vault root needs neither.
   */
  revealDoc(key: string): void {
    const sep = key.indexOf('::');
    const vaultId = sep > 0 ? key.slice(0, sep) : null;
    const path = sep > 0 ? key.slice(sep + 2) : key;
    const slash = path.lastIndexOf('/');
    if (slash === -1) {
      return;
    }
    this.expandAncestors(vaultId, path.slice(0, slash));
    if (vaultId !== null) {
      this.unfoldVault(vaultId);
    }
  }

  /** Plain selection: the cursor, the selection and the range anchor all become `key`. */
  select(key: string): void {
    this.selected.set(key);
    this.selection.set(new Set([key]));
    this.anchor.set(key);
    this.cursorMoved();
  }

  /** Keyboard step onto row `i`: Ctrl moves the cursor alone, Shift extends the range. */
  selectAt(nodes: readonly VisibleNode[], i: number, mod?: SelectionModifiers): void {
    const node = nodes[i];
    if (!node) {
      return;
    }
    const key = keyOf(node);
    const anchor = this.anchor();
    if (mod?.ctrlKey) {
      // Ctrl+Arrow: move the keyboard cursor; the selection set stays put.
      this.selected.set(key);
      this.cursorMoved();
    } else if (mod?.shiftKey && anchor) {
      this.selected.set(key);
      this.selection.set(rangeOver(nodes, anchor, key));
      this.cursorMoved();
    } else {
      this.select(key);
    }
  }

  /**
   * Ctrl+click toggles a row in the set; Shift+click extends the range from
   * the anchor; anything plain collapses back to the single clicked row.
   */
  applyPointerSelection(key: string, mod?: SelectionModifiers): void {
    if (mod?.ctrlKey) {
      const next = new Set(this.selection());
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      this.selection.set(next);
      this.selected.set(key);
      this.anchor.set(key);
      return;
    }
    if (mod?.shiftKey) {
      const anchor = this.anchor() ?? key;
      this.selected.set(key);
      this.selection.set(rangeOver(this.visibleNodes(), anchor, key));
      return;
    }
    this.select(key);
  }

  /** The visible entries currently in the multi-selection (cursor row only when single). */
  selectedEntries(): TreeTarget[] {
    const nodes = this.visibleNodes();
    const selection = this.selection();
    const pick = (n: VisibleNode): TreeTarget | null =>
      n.kind === 'entry' ? { vaultId: n.vaultId, entry: n.entry } : null;
    if (selection.size <= 1) {
      const node = nodes.find((n) => keyOf(n) === this.selected());
      const picked = node ? pick(node) : null;
      return picked ? [picked] : [];
    }
    return nodes
      .filter((n) => selection.has(keyOf(n)))
      .map(pick)
      .filter((v): v is TreeTarget => v !== null);
  }

  /** Escape: a multi-selection falls back to the cursor row. */
  collapseSelectionToCursor(): void {
    const selected = this.selected();
    if (this.selection().size > 1 && selected) {
      this.selection.set(new Set([selected]));
      this.anchor.set(selected);
    }
  }

  /**
   * After a delete: drop the cursor when it sat on or under a deleted path
   * (the tree reloads without it; a stale cursor would point at a ghost
   * row), and clear the selection.
   */
  forgetDeleted(targets: readonly TreeTarget[]): void {
    const selected = this.selected();
    if (
      selected &&
      targets.some((t) => {
        const key = docKey(t.vaultId, t.entry.relativePath);
        return selected === key || selected.startsWith(`${key}/`);
      })
    ) {
      this.selected.set(null);
      this.anchor.set(null);
    }
    this.selection.set(new Set());
  }
}
