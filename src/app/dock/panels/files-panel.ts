import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { EditorService, docKey } from '../../services/editor.service';
import { FileDecorationService, RowDecoration } from '../../services/file-decoration.service';
import { VaultService } from '../../vault';
import { VaultFileEntry, VaultStatus } from '../../../../shared/ipc-api';
import { Icon } from '../../icons/icon';
import { PanelHeaderActions } from '../panel-header-actions';
import { FileOperationsService } from './file-operations.service';
import { FilesTreeState } from './files-tree-state';
import {
  SelectionModifiers,
  TreeTarget,
  VisibleNode,
  absolutePath,
  canDropOnEntry,
  canDropOnVault,
  destinationDir,
  keyOf,
  parentDir,
} from './files-tree';

/** Anchor + target for the file-tree right-click menu. */
interface TreeMenu {
  x: number;
  y: number;
  /** The vault the menu acts in. */
  vaultId: string;
  /** Vault-relative folder a new entry lands in; '' means the vault root. */
  dir: string;
  /** The entry the menu was opened on, if any -- the "Delete" target. */
  entry: VaultFileEntry | null;
}

/** Anchor + target for a vault row's right-click menu. */
interface VaultMenu {
  x: number;
  y: number;
  vault: VaultStatus;
}

/** An in-progress "new file" / "new folder" with its inline name input showing. */
interface PendingCreate {
  kind: 'file' | 'directory';
  vaultId: string;
  dir: string;
}

/** An in-progress rename: the entry and the name currently in the inline input. */
interface PendingRename {
  vaultId: string;
  entry: VaultFileEntry;
}

/** An in-progress vault display-name rename. */
interface PendingVaultRename {
  vaultId: string;
}

/**
 * "Files" dock panel: every registered vault's section stacked in one tree
 * (ADR-0051) -- a vault header row (name, active marker, section chevron)
 * per registration, each expandable into its documents, plus an
 * "Add vault …" affordance. Vault management lives in the vault row's
 * context menu: Set active / Rename / Add vault / Open in File Explorer /
 * Remove.
 *
 * The component is the input half only: pointer, keyboard and drag events,
 * the two context menus and the inline name inputs. What is visible and
 * selected lives in `FilesTreeState` (over the pure `files-tree.ts`), what
 * happens to the files in `FileOperationsService`; the tree reloads come
 * from `VaultService`.
 *
 * Every row identity is the composite `vaultId::relativePath` (the same
 * format as an open tab's key), so the same relative path in two vaults is
 * two independent rows. Drag & drop moves entries within a vault (req-23)
 * and -- since ADR-0051 -- across vaults too: a drop on another vault's
 * rows or header moves the entry there.
 */
@Component({
  selector: 'app-files-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, Icon, PanelHeaderActions],
  providers: [FilesTreeState],
  templateUrl: './files-panel.html',
  styleUrl: './files-panel.css',
})
export class FilesPanel {
  protected readonly vault = inject(VaultService);
  protected readonly editor = inject(EditorService);
  private readonly tree = inject(FilesTreeState);
  private readonly operations = inject(FileOperationsService);
  private readonly decorations = inject(FileDecorationService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly collapsedVaults = this.tree.collapsedVaults;
  protected readonly selected = this.tree.selected;
  protected readonly selection = this.tree.selection;
  protected readonly visibleNodes = this.tree.visibleNodes;
  protected readonly allFoldersExpanded = this.tree.allFoldersExpanded;

  protected readonly vaultMenu = signal<VaultMenu | null>(null);
  protected readonly menu = signal<TreeMenu | null>(null);
  protected readonly creating = signal<PendingCreate | null>(null);
  protected readonly renaming = signal<PendingRename | null>(null);
  protected readonly renamingVault = signal<PendingVaultRename | null>(null);

  /** The display name shown in the inline vault-rename input. */
  protected renamingVaultName(): string {
    const pending = this.renamingVault();
    return pending ? (this.vault.vaults().find((v) => v.id === pending.vaultId)?.name ?? '') : '';
  }

  /**
   * The tree entry being dragged (req-23 + ADR-0051): folders cannot carry
   * the editor-drop's `application/x-drey-vault-path` (a pane would try to
   * open a folder as a tab), so the drop target reads the dragged entry
   * from here instead of `dataTransfer`. Files set it too -- the same
   * gesture still drags into the editor via the dataTransfer types.
   */
  protected readonly dragEntry = signal<TreeTarget | null>(null);

  /** The row currently showing the drop highlight (its composite key). */
  protected readonly dropHover = signal<string | null>(null);

  private readonly createInput = viewChild<ElementRef<HTMLInputElement>>('createInput');
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');
  private readonly vaultRenameInput = viewChild<ElementRef<HTMLInputElement>>('vaultRenameInput');

  constructor() {
    this.tree.onCursorMoved(() => this.followFocus());
    // Reveal the active file: folders start collapsed, so a tab opened from
    // search, a chat link or the calendar must expand its ancestor chain
    // (and unfold the vault section) -- otherwise the row is invisible and
    // the tree looks like it "did nothing".
    effect(() => {
      const key = this.editor.activePath();
      if (key) {
        this.tree.revealDoc(key);
      }
    });
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
    effect(() => {
      if (this.renamingVault()) {
        setTimeout(() => this.vaultRenameInput()?.nativeElement.select(), 0);
      }
    });
  }

  /** True for the row whose name is being edited in place. */
  protected isRenaming(vaultId: string, entry: VaultFileEntry): boolean {
    const pending = this.renaming();
    return (
      pending !== null &&
      pending.vaultId === vaultId &&
      pending.entry.relativePath === entry.relativePath
    );
  }

  /**
   * Where the in-place "new file / new folder" row goes: directly under
   * the row of its target -- the folder it is created in, or the vault
   * header for the vault root. Returns the new row's depth + 1 (so the
   * template's `@if` stays truthy at depth 0), or 0 for every other row.
   */
  protected createDepth(node: VisibleNode): number {
    const pending = this.creating();
    if (pending === null) {
      return 0;
    }
    if (node.kind === 'vault') {
      return pending.dir === '' && node.vault.id === pending.vaultId ? 1 : 0;
    }
    return node.vaultId === pending.vaultId &&
      node.entry.type === 'directory' &&
      node.entry.relativePath === pending.dir
      ? node.depth + 2
      : 0;
  }

  protected keyOf(node: VisibleNode): string {
    return keyOf(node);
  }

  protected isCollapsed(key: string): boolean {
    return !this.tree.isExpanded(key);
  }

  protected toggleFolder(key: string): void {
    this.tree.toggleFolder(key);
  }

  protected toggleVaultSection(vaultId: string): void {
    this.tree.toggleVaultSection(vaultId);
  }

  /**
   * Header toggle: "Expand all" when any folder is still collapsed, else
   * "Collapse all" (which is the default state, so the button usually
   * expands).
   */
  protected toggleAllFolders(): void {
    this.tree.toggleAllFolders();
  }

  /** The row's plugin-contributed decoration (SDK 1.17 -- the git status), or `null`. */
  protected decorationOf(vaultId: string, relativePath: string): RowDecoration | null {
    return this.decorations.decorationFor(vaultId, relativePath);
  }

  /**
   * The row tooltip: the absolute OS path (req: the hover tooltip shows the
   * whole path and name), plus what the decoration says.
   */
  protected titleOf(vaultId: string, relativePath: string): string {
    const root = this.vault.vaults().find((v) => v.id === vaultId)?.path;
    const path = absolutePath(root, relativePath);
    const tooltip = this.decorationOf(vaultId, relativePath)?.tooltip;
    return tooltip ? `${path} — ${tooltip}` : path;
  }

  protected onFolderClick(vaultId: string, entry: VaultFileEntry, event?: MouseEvent): void {
    const mod = pointerModifiers(event);
    this.tree.applyPointerSelection(docKey(vaultId, entry.relativePath), mod);
    // Ctrl/Shift clicks adjust the selection only -- they must not fold the
    // folder out from under the user.
    if (!mod?.shiftKey && !mod?.ctrlKey) {
      this.tree.toggleFolder(docKey(vaultId, entry.relativePath));
    }
  }

  protected onFileClick(vaultId: string, entry: VaultFileEntry, event?: MouseEvent): void {
    if (entry.type !== 'file') {
      return;
    }
    const mod = pointerModifiers(event);
    this.tree.applyPointerSelection(docKey(vaultId, entry.relativePath), mod);
    if (!mod?.shiftKey && !mod?.ctrlKey) {
      this.operations.open(vaultId, entry.relativePath);
    }
  }

  /**
   * File-explorer keyboard navigation on the tree container: Up/Down move
   * the cursor one visible row (Shift extends the selection's range, Ctrl
   * moves the cursor alone), Right/Left expand/collapse a folder or vault
   * section (or step in/out), Enter opens the cursor file -- every selected
   * file, when the selection is multi-row -- and Space toggles a folder or
   * vault section, Delete deletes the selection. Every handled key calls
   * `preventDefault()` so the container does not also scroll.
   */
  protected onTreeKeydown(event: KeyboardEvent): void {
    const nodes = this.tree.visibleNodes();
    if (nodes.length === 0) {
      return;
    }
    const idx = nodes.findIndex((n) => keyOf(n) === this.tree.selected());
    const current = idx >= 0 ? nodes[idx] : null;
    const mod = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey || event.metaKey };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.tree.selectAt(nodes, idx < 0 ? 0 : Math.min(idx + 1, nodes.length - 1), mod);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.tree.selectAt(nodes, idx < 0 ? nodes.length - 1 : Math.max(idx - 1, 0), mod);
        break;
      case 'ArrowRight': {
        event.preventDefault();
        if (!current) {
          this.tree.selectAt(nodes, 0);
          break;
        }
        if (current.kind === 'vault') {
          if (this.tree.collapsedVaults().has(current.vault.id)) {
            this.tree.toggleVaultSection(current.vault.id);
          } else {
            const child = nodes[idx + 1];
            if (child?.kind === 'entry') {
              this.tree.selectAt(nodes, idx + 1, mod);
            }
          }
        } else if (current.entry.type === 'directory') {
          const key = docKey(current.vaultId, current.entry.relativePath);
          if (!this.tree.isExpanded(key)) {
            this.tree.toggleFolder(key);
          } else {
            const child = nodes[idx + 1];
            if (
              child?.kind === 'entry' &&
              child.vaultId === current.vaultId &&
              child.entry.relativePath.startsWith(`${current.entry.relativePath}/`)
            ) {
              this.tree.selectAt(nodes, idx + 1, mod);
            }
          }
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (!current) {
          this.tree.selectAt(nodes, 0);
          break;
        }
        if (current.kind === 'vault') {
          if (!this.tree.collapsedVaults().has(current.vault.id)) {
            this.tree.toggleVaultSection(current.vault.id);
          }
          break;
        }
        const key = docKey(current.vaultId, current.entry.relativePath);
        if (current.entry.type === 'directory' && this.tree.isExpanded(key)) {
          this.tree.toggleFolder(key);
        } else {
          const parent = parentDir(current.entry.relativePath);
          // From a root entry the step goes back up to the vault row.
          this.tree.select(parent ? docKey(current.vaultId, parent) : current.vaultId);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        const multi = this.tree.selection().size > 1;
        // A focused node <button> activates itself -- only act here when the
        // scroll container itself has focus, or when the selection is
        // multi-row (native activation would open just the focused row).
        if (!current || (event.target !== event.currentTarget && !multi)) {
          break;
        }
        event.preventDefault();
        if (multi && event.key === 'Enter') {
          this.operations.openAll(this.tree.selectedEntries());
          break;
        }
        if (current.kind === 'vault') {
          this.tree.toggleVaultSection(current.vault.id);
        } else if (current.entry.type === 'directory') {
          this.tree.toggleFolder(docKey(current.vaultId, current.entry.relativePath));
        } else {
          this.onFileClick(current.vaultId, current.entry);
        }
        break;
      }
      case 'Delete': {
        event.preventDefault();
        if (current?.kind === 'entry') {
          void this.deleteEntries(this.tree.selectedEntries());
        }
        break;
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

  /** Manual "re-read every vault from disk" (a full round in main, ADR-0045). */
  protected onRefresh(): void {
    void this.vault.refresh();
  }

  protected async onAddVault(): Promise<void> {
    this.vaultMenu.set(null);
    await this.operations.addVault();
  }

  protected async onSetActiveVault(vaultId: string): Promise<void> {
    this.vaultMenu.set(null);
    await this.operations.setActiveVault(vaultId);
  }

  protected startVaultRename(): void {
    const menu = this.vaultMenu();
    this.vaultMenu.set(null);
    if (menu) {
      this.renamingVault.set({ vaultId: menu.vault.id });
    }
  }

  protected cancelVaultRename(): void {
    this.renamingVault.set(null);
  }

  protected async commitVaultRename(rawName: string): Promise<void> {
    const pending = this.renamingVault();
    this.renamingVault.set(null);
    if (pending) {
      await this.operations.renameVault(pending.vaultId, rawName);
    }
  }

  protected async onRevealVault(vaultId: string): Promise<void> {
    this.vaultMenu.set(null);
    await this.operations.revealVault(vaultId);
  }

  protected async onRemoveVault(vault: VaultStatus): Promise<void> {
    this.vaultMenu.set(null);
    await this.operations.removeVault(vault);
  }

  /**
   * Drag a file onto the editor to insert it (ADR-0028): carry the doc key
   * (`vaultId::path`, ADR-0051) on a private type the editor's drop handler
   * reads (an image gets linked in place, a text file's contents inlined).
   * Set for any file; the editor decides what to do from the extension. The
   * same gesture is also an intra/inter-panel move candidate -- `dragEntry`
   * arms that half. `text/plain` keeps the bare path for external drops.
   */
  protected onFileDragStart(event: DragEvent, vaultId: string, entry: VaultFileEntry): void {
    if (entry.type !== 'file' || !event.dataTransfer) {
      return;
    }
    event.dataTransfer.setData('application/x-drey-vault-path', docKey(vaultId, entry.relativePath));
    event.dataTransfer.setData('text/plain', entry.relativePath);
    // Both halves of this gesture must be in effectAllowed: the editor's
    // drop handler negotiates `copy`, the tree rows (req-23 moves) `move`.
    // A `copyLink` here made Chromium refuse every tree drop (no-drop
    // cursor, `drop` never fires) -- file drags could not move at all.
    event.dataTransfer.effectAllowed = 'copyMove';
    this.dragEntry.set({ vaultId, entry });
  }

  /**
   * A folder drag is intra-panel only: no dataTransfer types at all (with
   * none, nothing outside this panel reacts; `effectAllowed: 'move'` shows
   * the move cursor), the dragged entry lives in `dragEntry`.
   */
  protected onFolderDragStart(event: DragEvent, vaultId: string, entry: VaultFileEntry): void {
    if (!event.dataTransfer) {
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    this.dragEntry.set({ vaultId, entry });
  }

  /** Fires after a completed *or* cancelled drag -- always clears the state. */
  protected onDragEnd(): void {
    this.dragEntry.set(null);
    this.dropHover.set(null);
  }

  protected onRowDragOver(event: DragEvent, vaultId: string, entry: VaultFileEntry): void {
    if (!canDropOnEntry(this.dragEntry(), vaultId, entry)) {
      return; // no preventDefault -> the browser shows no-drop, drop won't fire
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dropHover.set(docKey(vaultId, entry.relativePath));
  }

  protected onRowDragLeave(event: DragEvent, vaultId: string, entry: VaultFileEntry): void {
    if (this.dropHover() === docKey(vaultId, entry.relativePath)) {
      this.dropHover.set(null);
    }
  }

  protected onRowDrop(event: DragEvent, vaultId: string, entry: VaultFileEntry): void {
    event.stopPropagation();
    this.dropHover.set(null);
    const dragged = this.dragEntry();
    this.dragEntry.set(null);
    if (dragged === null || !canDropOnEntry(dragged, vaultId, entry)) {
      return;
    }
    event.preventDefault();
    void this.moveInto(dragged, vaultId, destinationDir(entry));
  }

  protected onVaultRowDragOver(event: DragEvent, vault: VaultStatus): void {
    if (!canDropOnVault(this.dragEntry(), vault)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dropHover.set(vault.id);
  }

  protected onVaultRowDragLeave(event: DragEvent, vault: VaultStatus): void {
    if (this.dropHover() === vault.id) {
      this.dropHover.set(null);
    }
  }

  protected onVaultRowDrop(event: DragEvent, vault: VaultStatus): void {
    event.stopPropagation();
    this.dropHover.set(null);
    const dragged = this.dragEntry();
    this.dragEntry.set(null);
    if (dragged === null || !canDropOnVault(dragged, vault)) {
      return;
    }
    event.preventDefault();
    void this.moveInto(dragged, vault.id, '');
  }

  /** Moves the dragged entry and reveals where it went. */
  private async moveInto(dragged: TreeTarget, toVaultId: string, destDir: string): Promise<void> {
    if (await this.operations.move(dragged.vaultId, dragged.entry.relativePath, toVaultId, destDir)) {
      this.tree.expandAncestors(toVaultId, destDir);
      this.tree.unfoldVault(toVaultId);
    }
  }

  protected openTreeMenu(event: MouseEvent, vaultId: string, entry?: VaultFileEntry): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Right-clicking outside a multi-selection collapses it onto that row,
    // so "Delete" can't surprise-delete rows the user doesn't see. Inside a
    // multi-selection the menu acts on all of it (see `onDelete`).
    const selection = this.tree.selection();
    if (entry && selection.size > 1 && !selection.has(docKey(vaultId, entry.relativePath))) {
      this.tree.select(docKey(vaultId, entry.relativePath));
    }
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 260),
      vaultId,
      dir: entry ? destinationDir(entry) : '',
      entry: entry ?? null,
    });
  }

  protected openVaultMenu(event: MouseEvent, vault: VaultStatus): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.vaultMenu.set({
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 260),
      vault,
    });
  }

  protected closeMenus(): void {
    this.menu.set(null);
    this.vaultMenu.set(null);
  }

  /** Closes the row menu and hands back what it was opened on. */
  private takeMenu(): TreeMenu | null {
    const menu = this.menu();
    this.closeMenus();
    return menu;
  }

  protected startCreate(kind: 'file' | 'directory'): void {
    const menu = this.takeMenu();
    if (!menu) {
      return;
    }
    this.creating.set({ kind, vaultId: menu.vaultId, dir: menu.dir });
    // The input row renders under its target, so the target must be visible.
    this.tree.unfoldVault(menu.vaultId);
    this.tree.expandAncestors(menu.vaultId, menu.dir);
  }

  protected cancelCreate(): void {
    this.creating.set(null);
  }

  protected async commitCreate(rawName: string): Promise<void> {
    const pending = this.creating();
    this.creating.set(null);
    if (pending) {
      await this.operations.create(pending.kind, pending.vaultId, pending.dir, rawName);
    }
  }

  /** Mark the right-clicked entry for a later "Paste". */
  protected onCopy(): void {
    const menu = this.takeMenu();
    if (menu?.entry) {
      this.operations.copy(menu.vaultId, menu.entry);
    }
  }

  /** Paste the clipboard entry into the right-clicked folder (or vault root). */
  protected async onPaste(): Promise<void> {
    const menu = this.takeMenu();
    if (menu && (await this.operations.paste(menu.vaultId, menu.dir))) {
      this.tree.expandAncestors(menu.vaultId, menu.dir);
    }
  }

  protected async onDuplicate(): Promise<void> {
    const menu = this.takeMenu();
    if (menu?.entry) {
      await this.operations.duplicate(menu.vaultId, menu.entry.relativePath);
    }
  }

  protected async onExportPdf(): Promise<void> {
    const menu = this.takeMenu();
    if (menu?.entry) {
      await this.operations.exportPdf(menu.vaultId, menu.entry.relativePath);
    }
  }

  /**
   * Row menu: opens the file pinned ("Open in new tab") -- a pinned tab is
   * never the tab the next plain open replaces, so it stays; already open,
   * it is revealed and pinned.
   */
  protected onOpenInNewTab(): void {
    const menu = this.takeMenu();
    if (menu?.entry?.type === 'file') {
      this.operations.openPinned(menu.vaultId, menu.entry.relativePath);
    }
  }

  protected async onRevealEntry(): Promise<void> {
    const menu = this.takeMenu();
    if (menu?.entry) {
      await this.operations.reveal(menu.vaultId, menu.entry.relativePath);
    }
  }

  /** Row menu: opens the OS terminal in the entry's folder (a file's parent). */
  protected async onOpenInTerminal(): Promise<void> {
    const menu = this.takeMenu();
    if (menu) {
      await this.operations.openInTerminal(menu.vaultId, menu.dir);
    }
  }

  protected startRename(): void {
    const menu = this.takeMenu();
    if (menu?.entry) {
      this.renaming.set({ vaultId: menu.vaultId, entry: menu.entry });
    }
  }

  protected cancelRename(): void {
    this.renaming.set(null);
  }

  protected async commitRename(rawName: string): Promise<void> {
    const pending = this.renaming();
    this.renaming.set(null);
    if (pending) {
      await this.operations.rename(pending.vaultId, pending.entry, rawName);
    }
  }

  protected async onDelete(): Promise<void> {
    const menu = this.takeMenu();
    const entry = menu?.entry;
    if (!menu || !entry) {
      return;
    }
    // Right-clicking inside a multi-selection deletes the whole selection;
    // anywhere else it stays a single-entry delete.
    const selection = this.tree.selection();
    const inSelection = selection.size > 1 && selection.has(docKey(menu.vaultId, entry.relativePath));
    await this.deleteEntries(inSelection ? this.tree.selectedEntries() : [{ vaultId: menu.vaultId, entry }]);
  }

  private async deleteEntries(targets: TreeTarget[]): Promise<void> {
    if (await this.operations.deleteEntries(targets)) {
      this.tree.forgetDeleted(targets);
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeMenus();
    this.renaming.set(null);
    this.renamingVault.set(null);
    // A second Escape (or one with no menu open) collapses a multi-selection
    // back to the cursor row.
    this.tree.collapseSelectionToCursor();
  }
}

/** The modifier half of a pointer event that adjusts the selection. */
function pointerModifiers(event?: MouseEvent): SelectionModifiers | undefined {
  if (!event) {
    return undefined;
  }
  return { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey || event.metaKey };
}
