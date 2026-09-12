import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { EditorService } from '../../services/editor.service';
import { VaultService } from '../../vault';
import { VaultFileEntry } from '../../../../shared/ipc-api';
import { Icon } from '../../icons/icon';
import { PanelHeaderActions } from '../panel-header-actions';

/** Anchor + target for the file-tree right-click menu. */
interface TreeMenu {
  x: number;
  y: number;
  /** Vault-relative folder a new entry lands in; '' means the vault root. */
  dir: string;
  /** The entry the menu was opened on, if any -- the "Delete" target. */
  entry: VaultFileEntry | null;
}

/** An in-progress "new file" / "new folder" with its inline name input showing. */
interface PendingCreate {
  kind: 'file' | 'directory';
  dir: string;
}

/** An in-progress rename: the entry and the name currently in the inline input. */
interface PendingRename {
  entry: VaultFileEntry;
}

/**
 * "Files" dock panel: the vault switcher row plus the vault file tree.
 * Lifted out of the old `Sidebar` component unchanged in behaviour --
 * folder collapse state and the right-click new/delete flow are local view
 * state; the create call and the tree reload live in `VaultService`. Step 4
 * restyles the switcher and tree to the v3 spec.
 */
@Component({
  selector: 'app-files-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, Icon, PanelHeaderActions],
  templateUrl: './files-panel.html',
  styleUrl: './files-panel.css',
})
export class FilesPanel {
  protected readonly vault = inject(VaultService);
  protected readonly editor = inject(EditorService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** Folder paths the user has collapsed. Folders start expanded. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  /**
   * The tree entry the keyboard cursor sits on (a `relativePath`). Distinct
   * from `editor.openPath()` (the open file) -- this is a roving selection
   * for Up/Down/Left/Right navigation, like a file explorer. The selected
   * row also holds DOM focus (roving `tabindex`, see `select()`), which is
   * what makes Enter/Space activate the highlighted row.
   */
  protected readonly selected = signal<string | null>(null);

  /**
   * The multi-selection (bug-8): every highlighted `relativePath`, cursor
   * row included. A plain click / plain arrow key collapses it back to
   * `{selected}`; Ctrl+click toggles rows and Shift+click / Shift+arrow
   * extend a range over the visible rows (the anchor is where the range
   * grows from).
   */
  protected readonly selection = signal<ReadonlySet<string>>(new Set());

  /** The row a Shift-range extends from (the last plain-selected row). */
  private readonly anchor = signal<string | null>(null);

  /**
   * `vault.fileTree()` flattened to the rows that are actually visible
   * (a folder's children are dropped while it is collapsed), in display
   * order -- the model the arrow keys step through.
   */
  protected readonly visibleNodes = computed<{ entry: VaultFileEntry; depth: number }[]>(() => {
    const out: { entry: VaultFileEntry; depth: number }[] = [];
    const walk = (entries: readonly VaultFileEntry[], depth: number): void => {
      for (const entry of entries) {
        out.push({ entry, depth });
        if (
          entry.type === 'directory' &&
          entry.children?.length &&
          !this.collapsed().has(entry.relativePath)
        ) {
          walk(entry.children, depth + 1);
        }
      }
    };
    walk(this.vault.fileTree(), 0);
    return out;
  });

  protected readonly vaultMenuOpen = signal(false);
  protected readonly menu = signal<TreeMenu | null>(null);
  protected readonly creating = signal<PendingCreate | null>(null);
  protected readonly renaming = signal<PendingRename | null>(null);

  /**
   * The tree entry being dragged inside the panel (req-23): folders cannot
   * carry the editor-drop's `application/x-drey-vault-path` (a pane would
   * try to open a folder as a tab), so the drop target reads the dragged
   * entry from here instead of `dataTransfer`. Files set it too -- the same
   * gesture still drags into the editor via the dataTransfer types.
   */
  protected readonly dragEntry = signal<VaultFileEntry | null>(null);

  /** The row currently showing the drop highlight (its `relativePath`). */
  protected readonly dropHover = signal<string | null>(null);

  private readonly createInput = viewChild<ElementRef<HTMLInputElement>>('createInput');
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  constructor() {
    effect(() => {
      if (this.creating()) {
        setTimeout(() => this.createInput()?.nativeElement.focus(), 0);
      }
    });
    effect(() => {
      if (this.renaming()) {
        setTimeout(() => {
          const el = this.renameInput()?.nativeElement;
          el?.focus();
          // Pre-select the name stem so a full retype is one keystroke, but
          // the extension stays put for a quick tweak.
          const dot = el?.value.lastIndexOf('.') ?? -1;
          el?.setSelectionRange(0, dot > 0 ? dot : (el?.value.length ?? 0));
        }, 0);
      }
    });
  }

  protected vaultName(): string {
    const path = this.vault.activeVaultPath();
    if (!path) {
      return 'No vault';
    }
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }

  protected isCollapsed(path: string): boolean {
    return this.collapsed().has(path);
  }

  protected toggleFolder(path: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  /** Header "collapse all folders" button: fold every directory in the tree. */
  protected collapseAll(): void {
    const paths = new Set<string>();
    const walk = (entries: readonly VaultFileEntry[]): void => {
      for (const entry of entries) {
        if (entry.type === 'directory') {
          paths.add(entry.relativePath);
          if (entry.children?.length) {
            walk(entry.children);
          }
        }
      }
    };
    walk(this.vault.fileTree());
    this.collapsed.set(paths);
  }

  protected onFolderClick(entry: VaultFileEntry, event?: MouseEvent): void {
    const mod = pointerModifiers(event);
    this.applyPointerSelection(entry, mod);
    // Ctrl/Shift clicks adjust the selection only -- they must not fold the
    // folder out from under the user.
    if (!mod?.shiftKey && !mod?.ctrlKey) {
      this.toggleFolder(entry.relativePath);
    }
  }

  /**
   * File-explorer keyboard navigation on the tree container: Up/Down move
   * the cursor one visible row (Shift extends the selection's range, Ctrl
   * moves the cursor alone), Right/Left expand/collapse a folder (or step
   * in/out), Enter opens the cursor file -- every selected file, when the
   * selection is multi-row -- and Space toggles a folder, Delete deletes the
   * selection. Every handled key calls `preventDefault()` so the container
   * does not also scroll.
   */
  protected onTreeKeydown(event: KeyboardEvent): void {
    const nodes = this.visibleNodes();
    if (nodes.length === 0) {
      return;
    }
    const idx = nodes.findIndex((n) => n.entry.relativePath === this.selected());
    const current = idx >= 0 ? nodes[idx].entry : null;
    const mod = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey || event.metaKey };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectAt(nodes, idx < 0 ? 0 : Math.min(idx + 1, nodes.length - 1), mod);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selectAt(nodes, idx < 0 ? nodes.length - 1 : Math.max(idx - 1, 0), mod);
        break;
      case 'ArrowRight': {
        event.preventDefault();
        if (!current) {
          this.selectAt(nodes, 0);
          break;
        }
        if (current.type === 'directory') {
          if (this.collapsed().has(current.relativePath)) {
            this.toggleFolder(current.relativePath);
          } else {
            const child = nodes[idx + 1];
            if (child && child.entry.relativePath.startsWith(`${current.relativePath}/`)) {
              this.selectAt(nodes, idx + 1, mod);
            }
          }
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (!current) {
          this.selectAt(nodes, 0);
          break;
        }
        if (current.type === 'directory' && !this.collapsed().has(current.relativePath)) {
          this.toggleFolder(current.relativePath);
        } else {
          const parent = parentDir(current.relativePath);
          if (parent) {
            this.select(parent);
          }
        }
        break;
      }
      case 'Enter':
      case ' ': {
        const multi = this.selection().size > 1;
        // A focused node <button> activates itself -- only act here when the
        // scroll container itself has focus, or when the selection is
        // multi-row (native activation would open just the focused row).
        if (!current || (event.target !== event.currentTarget && !multi)) {
          break;
        }
        event.preventDefault();
        if (multi && event.key === 'Enter') {
          this.openSelection(nodes);
          break;
        }
        if (current.type === 'directory') {
          this.toggleFolder(current.relativePath);
        } else {
          this.onFileClick(current);
        }
        break;
      }
      case 'Delete': {
        event.preventDefault();
        const targets = this.selectedEntries(nodes);
        if (targets.length > 0) {
          void this.deleteEntries(targets);
        }
        break;
      }
    }
  }

  private selectAt(
    nodes: { entry: VaultFileEntry }[],
    i: number,
    mod?: { shiftKey: boolean; ctrlKey: boolean },
  ): void {
    const entry = nodes[i]?.entry;
    if (!entry) {
      return;
    }
    if (mod?.ctrlKey) {
      // Ctrl+Arrow: move the keyboard cursor; the selection set stays put.
      this.selected.set(entry.relativePath);
      this.followFocus();
    } else if (mod?.shiftKey && this.anchor()) {
      this.selected.set(entry.relativePath);
      this.selection.set(this.rangeOver(nodes, this.anchor()!, entry.relativePath));
      this.followFocus();
    } else {
      this.select(entry.relativePath);
    }
  }

  private select(path: string): void {
    this.selected.set(path);
    this.selection.set(new Set([path]));
    this.anchor.set(path);
    this.followFocus();
  }

  /**
   * Ctrl+click toggles a row in the set; Shift+click extends the range from
   * the anchor; anything plain collapses back to the single clicked row.
   */
  private applyPointerSelection(
    entry: VaultFileEntry,
    mod?: { shiftKey: boolean; ctrlKey: boolean },
  ): void {
    if (mod?.ctrlKey) {
      const next = new Set(this.selection());
      if (next.has(entry.relativePath)) {
        next.delete(entry.relativePath);
      } else {
        next.add(entry.relativePath);
      }
      this.selection.set(next);
      this.selected.set(entry.relativePath);
      this.anchor.set(entry.relativePath);
      return;
    }
    if (mod?.shiftKey) {
      const anchor = this.anchor() ?? entry.relativePath;
      this.selected.set(entry.relativePath);
      this.selection.set(this.rangeOver(this.visibleNodes(), anchor, entry.relativePath));
      return;
    }
    this.select(entry.relativePath);
  }

  /** The paths from `from` to `to`, both included, over the visible rows. */
  private rangeOver(
    nodes: { entry: VaultFileEntry }[],
    from: string,
    to: string,
  ): ReadonlySet<string> {
    const i = nodes.findIndex((n) => n.entry.relativePath === from);
    const j = nodes.findIndex((n) => n.entry.relativePath === to);
    if (i < 0 || j < 0) {
      return new Set([to]);
    }
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    return new Set(nodes.slice(lo, hi + 1).map((n) => n.entry.relativePath));
  }

  /** The visible entries currently in the multi-selection (cursor row only when single). */
  private selectedEntries(nodes: { entry: VaultFileEntry }[]): VaultFileEntry[] {
    const selection = this.selection();
    if (selection.size <= 1) {
      return nodes.filter((n) => n.entry.relativePath === this.selected()).map((n) => n.entry);
    }
    return nodes.filter((n) => selection.has(n.entry.relativePath)).map((n) => n.entry);
  }

  /** Opens every selected *file*; folders in the selection are skipped. */
  private openSelection(nodes: { entry: VaultFileEntry }[]): void {
    for (const entry of this.selectedEntries(nodes)) {
      if (entry.type === 'file') {
        void this.editor.openFile(entry.relativePath);
      }
    }
  }

  /**
   * Wait for the `.selected` class to land, then keep the cursor row in view
   * and move DOM focus onto it (bug-7): rows are `<button>`s, so Enter/Space
   * activate whatever row holds focus -- without this, focus stayed on the
   * originally-clicked row and Enter re-activated *that* instead of the
   * highlighted one. Roving tabindex keeps the tree at one tab stop.
   */
  private followFocus(): void {
    setTimeout(() => {
      const row = this.host.querySelector<HTMLElement>('.node.selected[tabindex="0"]');
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
    }, 0);
  }

  protected toggleVaultMenu(): void {
    this.vaultMenuOpen.update((v) => !v);
  }

  protected onOpenOtherVault(): void {
    this.vaultMenuOpen.set(false);
    void this.vault.selectVault();
  }

  /** Manual "re-read the vault from disk" (a full round in main, ADR-0045). */
  protected onRefresh(): void {
    void this.vault.refresh();
  }

  protected onFileClick(entry: VaultFileEntry, event?: MouseEvent): void {
    if (entry.type !== 'file') {
      return;
    }
    const mod = pointerModifiers(event);
    this.applyPointerSelection(entry, mod);
    if (!mod?.shiftKey && !mod?.ctrlKey) {
      void this.editor.openFile(entry.relativePath);
    }
  }

  /**
   * Drag a file onto the editor to insert it (ADR-0028): carry the vault
   * path on a private type the editor's drop handler reads (an image gets
   * linked in place, a text file's contents inlined). Set for any file;
   * the editor decides what to do from the extension. The same gesture is
   * also an intra-panel move candidate -- `dragEntry` arms that half.
   */
  protected onFileDragStart(event: DragEvent, entry: VaultFileEntry): void {
    if (entry.type !== 'file' || !event.dataTransfer) {
      return;
    }
    event.dataTransfer.setData('application/x-drey-vault-path', entry.relativePath);
    event.dataTransfer.setData('text/plain', entry.relativePath);
    event.dataTransfer.effectAllowed = 'copyLink';
    this.dragEntry.set(entry);
  }

  /**
   * A folder drag is intra-panel only: no dataTransfer types at all (with
   * none, nothing outside this panel reacts; `effectAllowed: 'move'` shows
   * the move cursor), the dragged entry lives in `dragEntry`.
   */
  protected onFolderDragStart(event: DragEvent, entry: VaultFileEntry): void {
    if (!event.dataTransfer) {
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    this.dragEntry.set(entry);
  }

  /** Fires after a completed *or* cancelled drag -- always clears the state. */
  protected onDragEnd(): void {
    this.dragEntry.set(null);
    this.dropHover.set(null);
  }

  /** Where a drop on `entry` lands: a folder takes the entry in, a file's row means its parent folder. */
  private destinationDir(entry: VaultFileEntry): string {
    return entry.type === 'directory' ? entry.relativePath : parentDir(entry.relativePath);
  }

  /** False for a no-op (same folder) and for a folder dropped into itself / its own subtree. */
  private canDropOnto(entry: VaultFileEntry): boolean {
    const dragged = this.dragEntry();
    if (!dragged) {
      return false;
    }
    const dest = this.destinationDir(entry);
    if (dest === parentDir(dragged.relativePath)) {
      return false;
    }
    return dest !== dragged.relativePath && !dest.startsWith(`${dragged.relativePath}/`);
  }

  protected onRowDragOver(event: DragEvent, entry: VaultFileEntry): void {
    if (!this.canDropOnto(entry)) {
      return; // no preventDefault -> the browser shows no-drop, drop won't fire
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dropHover.set(entry.relativePath);
  }

  protected onRowDragLeave(event: DragEvent, entry: VaultFileEntry): void {
    if (this.dropHover() === entry.relativePath) {
      this.dropHover.set(null);
    }
  }

  protected onRowDrop(event: DragEvent, entry: VaultFileEntry): void {
    event.stopPropagation(); // the tree container's root drop must not double-handle
    this.dropHover.set(null);
    // Validate BEFORE clearing the armed drag -- `canDropOnto` reads it.
    const dragged = this.dragEntry();
    const valid = dragged !== null && this.canDropOnto(entry);
    this.dragEntry.set(null);
    if (!valid) {
      return;
    }
    event.preventDefault();
    void this.commitMove(dragged!.relativePath, this.destinationDir(entry));
  }

  /** The `.tree-scroll` background: a drop target for the vault root. */
  protected onRootDragOver(event: DragEvent): void {
    if ((event.target as HTMLElement | null)?.closest('.node')) {
      return; // a row handles (and stops) its own dragover
    }
    const dragged = this.dragEntry();
    if (!dragged || parentDir(dragged.relativePath) === '') {
      return; // already at the root -- no preventDefault, no-drop cursor
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  protected onRootDrop(event: DragEvent): void {
    if ((event.target as HTMLElement | null)?.closest('.node')) {
      return;
    }
    const dragged = this.dragEntry();
    this.dragEntry.set(null);
    this.dropHover.set(null);
    if (!dragged || parentDir(dragged.relativePath) === '') {
      return;
    }
    event.preventDefault();
    void this.commitMove(dragged.relativePath, '');
  }

  /**
   * The move half of `commitRename` (req-23): rename to the new folder,
   * re-point open tabs (keeping unsaved buffers), follow the clipboard,
   * reveal the destination. `VaultService.renameEntry` reloads the tree;
   * the main process moves the assistant sidecar along.
   */
  private async commitMove(fromRel: string, destDir: string): Promise<void> {
    const name = fromRel.slice(fromRel.lastIndexOf('/') + 1);
    const toRel = destDir ? `${destDir}/${name}` : name;
    try {
      await this.vault.renameEntry(fromRel, toRel);
      this.editor.retargetTabs(fromRel, toRel);
      if (this.vault.clipboard()?.path === fromRel) {
        this.vault.clipboard.set({ path: toRel, name });
      }
      this.expand(destDir);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  protected openMenu(event: MouseEvent, entry?: VaultFileEntry): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Right-clicking outside a multi-selection collapses it onto that row,
    // so "Delete" can't surprise-delete rows the user doesn't see. Inside a
    // multi-selection the menu acts on all of it (see `onDelete`).
    if (entry && this.selection().size > 1 && !this.selection().has(entry.relativePath)) {
      this.select(entry.relativePath);
    }
    const dir = !entry
      ? ''
      : entry.type === 'directory'
        ? entry.relativePath
        : parentDir(entry.relativePath);
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 260),
      dir,
      entry: entry ?? null,
    });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected startCreate(kind: 'file' | 'directory'): void {
    const menu = this.menu();
    if (!menu) {
      return;
    }
    this.creating.set({ kind, dir: menu.dir });
    this.menu.set(null);
    if (menu.dir) {
      this.collapsed.update((set) => {
        const next = new Set(set);
        next.delete(menu.dir);
        return next;
      });
    }
  }

  protected cancelCreate(): void {
    this.creating.set(null);
  }

  /** Mark the right-clicked entry for a later "Paste". */
  protected onCopy(): void {
    const entry = this.menu()?.entry;
    this.menu.set(null);
    if (entry) {
      this.vault.clipboard.set({ path: entry.relativePath, name: entry.name });
    }
  }

  /** Paste the clipboard entry into the right-clicked folder (or vault root). */
  protected async onPaste(): Promise<void> {
    const menu = this.menu();
    const clip = this.vault.clipboard();
    this.menu.set(null);
    if (!menu || !clip) {
      return;
    }
    try {
      await this.vault.copyEntry(clip.path, menu.dir);
      this.expand(menu.dir);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  protected async onDuplicate(): Promise<void> {
    const entry = this.menu()?.entry;
    this.menu.set(null);
    if (!entry) {
      return;
    }
    try {
      await this.vault.duplicateEntry(entry.relativePath);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  protected startRename(): void {
    const entry = this.menu()?.entry;
    this.menu.set(null);
    if (entry) {
      this.renaming.set({ entry });
    }
  }

  protected cancelRename(): void {
    this.renaming.set(null);
  }

  protected async commitRename(rawName: string): Promise<void> {
    const pending = this.renaming();
    this.renaming.set(null);
    if (!pending) {
      return;
    }
    const entry = pending.entry;
    const nextName = rawName.trim();
    if (!nextName || nextName === entry.name) {
      return;
    }
    if (
      nextName.includes('/') ||
      nextName.includes('\\') ||
      nextName === '.' ||
      nextName === '..'
    ) {
      alert(`Invalid name: ${nextName}`);
      return;
    }
    const parent = parentDir(entry.relativePath);
    const toPath = parent ? `${parent}/${nextName}` : nextName;
    try {
      await this.vault.renameEntry(entry.relativePath, toPath);
      this.editor.retargetTabs(entry.relativePath, toPath);
      if (this.vault.clipboard()?.path === entry.relativePath) {
        this.vault.clipboard.set({ path: toPath, name: nextName });
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  private expand(dir: string): void {
    if (!dir) {
      return;
    }
    this.collapsed.update((set) => {
      const next = new Set(set);
      next.delete(dir);
      return next;
    });
  }

  protected async onDelete(): Promise<void> {
    const entry = this.menu()?.entry;
    this.menu.set(null);
    if (!entry) {
      return;
    }
    // Right-clicking inside a multi-selection deletes the whole selection;
    // anywhere else it stays a single-entry delete.
    const selection = this.selection();
    const targets =
      selection.size > 1 && selection.has(entry.relativePath)
        ? this.selectedEntries(this.visibleNodes())
        : [entry];
    await this.deleteEntries(targets);
  }

  /** One `confirm`, per-path tab/clipboard cleanup, one batched IPC delete. */
  private async deleteEntries(entries: VaultFileEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const what =
      entries.length === 1
        ? entries[0].type === 'directory'
          ? 'folder'
          : 'file'
        : `${entries.length} items`;
    const names = entries.map((entry) => `"${entry.relativePath}"`).join(', ');
    if (!confirm(`Delete ${what} ${names}? This cannot be undone.`)) {
      return;
    }
    for (const entry of entries) {
      this.editor.closeTabsUnder(entry.relativePath);
      const clip = this.vault.clipboard()?.path;
      if (clip && (clip === entry.relativePath || clip.startsWith(`${entry.relativePath}/`))) {
        this.vault.clipboard.set(null);
      }
    }
    try {
      await this.vault.deleteEntries(entries.map((entry) => entry.relativePath));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
    // Deselect whatever lived under a deleted path (the tree reloads without
    // it; a stale cursor would point at a ghost row).
    const selected = this.selected();
    if (
      selected &&
      entries.some((entry) => selected === entry.relativePath || selected.startsWith(`${entry.relativePath}/`))
    ) {
      this.selected.set(null);
      this.anchor.set(null);
    }
    this.selection.set(new Set());
  }

  protected async commitCreate(rawName: string): Promise<void> {
    const pending = this.creating();
    this.creating.set(null);
    if (!pending) {
      return;
    }

    const name = rawName.trim();
    if (!name) {
      return;
    }
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      alert(`Invalid name: ${name}`);
      return;
    }

    const finalName = pending.kind === 'file' && !name.includes('.') ? `${name}.md` : name;
    const relativePath = pending.dir ? `${pending.dir}/${finalName}` : finalName;

    try {
      await this.vault.createEntry(pending.kind, relativePath);
      if (pending.kind === 'file') {
        await this.editor.openFile(relativePath);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.menu.set(null);
    this.vaultMenuOpen.set(false);
    this.renaming.set(null);
    // A second Escape (or one with no menu open) collapses a multi-selection
    // back to the cursor row.
    const selected = this.selected();
    if (this.selection().size > 1 && selected) {
      this.selection.set(new Set([selected]));
      this.anchor.set(selected);
    }
  }
}

function parentDir(relativePath: string): string {
  const i = relativePath.lastIndexOf('/');
  return i === -1 ? '' : relativePath.slice(0, i);
}

/** The modifier half of a pointer event that adjusts the selection. */
function pointerModifiers(event?: MouseEvent): { shiftKey: boolean; ctrlKey: boolean } | undefined {
  if (!event) {
    return undefined;
  }
  return { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey || event.metaKey };
}
