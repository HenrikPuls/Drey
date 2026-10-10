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
import { EditorService, docKey } from '../../services/editor.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { FileDecorationService, RowDecoration } from '../../services/file-decoration.service';
import { VaultService } from '../../vault';
import { LinkUpdateService } from '../../link-update';
import { VaultFileEntry, VaultStatus } from '../../../../shared/ipc-api';
import { Icon } from '../../icons/icon';
import { PanelHeaderActions } from '../panel-header-actions';

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

/** One row in the flat, keyboard-walkable model: a vault header or a file entry. */
type VisibleNode =
  | { kind: 'vault'; vault: VaultStatus }
  | { kind: 'entry'; vaultId: string; entry: VaultFileEntry; depth: number };

/**
 * "Files" dock panel: every registered vault's section stacked in one tree
 * (ADR-0051) -- a vault header row (name, active marker, section chevron)
 * per registration, each expandable into its documents, plus an
 * "Add vault …" affordance. Vault management lives in the vault row's
 * context menu: Set active / Rename / Add vault / Open in File Explorer /
 * Remove. Folder collapse and the right-click new/delete flow stay local
 * view state; the operations and tree reloads live in `VaultService`.
 *
 * Every row identity is the composite `vaultId::relativePath` (the same
 * format as an open tab's key), so the same relative path in two vaults is
 * two independent rows. Drag & drop moves entries within a vault exactly
 * as before (req-23) and -- since ADR-0051 -- across vaults too: a drop on
 * another vault's rows or header moves the entry there (copy + delete in
 * main, open tabs re-targeted).
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
  private readonly dialogs = inject(ConfirmDialogService);
  private readonly linkUpdate = inject(LinkUpdateService);
  private readonly decorations = inject(FileDecorationService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /**
   * Folder paths the user has EXPANDED, per vault (composite keys). Folders
   * start COLLAPSED each session (the beta feedback: a big vault opened as
   * one wall of expanded trees) -- an empty set is the resting state, and
   * nothing is persisted, so a restart collapses again. Tab activation
   * auto-expands the active file's ancestors (see the effect below).
   */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Vault ids whose whole section the user collapsed. */
  protected readonly collapsedVaults = signal<ReadonlySet<string>>(new Set());

  /**
   * The tree row the keyboard cursor sits on (a composite key). Distinct
   * from the open file -- this is a roving selection for Up/Down/Left/Right
   * navigation, like a file explorer. The selected row also holds DOM focus
   * (roving `tabindex`, see `select()`), which is what makes Enter/Space
   * activate the highlighted row.
   */
  protected readonly selected = signal<string | null>(null);

  /**
   * The multi-selection (bug-8): every highlighted composite key, cursor
   * row included. A plain click / plain arrow key collapses it back to
   * `{selected}`; Ctrl+click toggles rows and Shift+click / Shift+arrow
   * extend a range over the visible rows (the anchor is where the range
   * grows from). A selection never spans vaults silently -- ranges walk the
   * visible rows whatever vault they belong to, and a delete acts per vault.
   */
  protected readonly selection = signal<ReadonlySet<string>>(new Set());

  /** The row a Shift-range extends from (the last plain-selected row). */
  private readonly anchor = signal<string | null>(null);

  /**
   * All vault sections flattened to the rows that are actually visible (a
   * collapsed vault hides its whole tree; an unexpanded folder drops its
   * children), in display order -- the model the arrow keys step through.
   */
  protected readonly visibleNodes = computed<VisibleNode[]>(() => {
    const out: VisibleNode[] = [];
    const folded = this.collapsedVaults();
    for (const vault of this.vault.vaults()) {
      out.push({ kind: 'vault', vault });
      if (folded.has(vault.id)) {
        continue;
      }
      const walk = (entries: readonly VaultFileEntry[], depth: number): void => {
        for (const entry of entries) {
          out.push({ kind: 'entry', vaultId: vault.id, entry, depth });
          if (
            entry.type === 'directory' &&
            entry.children?.length &&
            this.expanded().has(docKey(vault.id, entry.relativePath))
          ) {
            walk(entry.children, depth + 1);
          }
        }
      };
      walk(this.vault.trees()[vault.id] ?? [], 0);
    }
    return out;
  });

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
  protected readonly dragEntry = signal<{ vaultId: string; entry: VaultFileEntry } | null>(null);

  /** The row currently showing the drop highlight (its composite key). */
  protected readonly dropHover = signal<string | null>(null);

  private readonly createInput = viewChild<ElementRef<HTMLInputElement>>('createInput');
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');
  private readonly vaultRenameInput = viewChild<ElementRef<HTMLInputElement>>('vaultRenameInput');

  constructor() {
    // Reveal the active file: folders start collapsed, so a tab opened from
    // search, a chat link or the calendar must expand its ancestor chain
    // (and unfold the vault section) -- otherwise the row is invisible and
    // the tree looks like it "did nothing".
    effect(() => {
      const key = this.editor.activePath();
      if (!key) {
        return;
      }
      const sep = key.indexOf('::');
      const vaultId = sep > 0 ? key.slice(0, sep) : null;
      const path = sep > 0 ? key.slice(sep + 2) : key;
      const parts = path.split('/');
      if (parts.length < 2) {
        return;
      }
      let revealed = false;
      this.expanded.update((set) => {
        const next = new Set(set);
        for (let i = 1; i < parts.length; i++) {
          next.add(docKey(vaultId, parts.slice(0, i).join('/')));
          revealed = true;
        }
        return next;
      });
      if (revealed && vaultId !== null) {
        this.collapsedVaults.update((set) => {
          if (!set.has(vaultId)) {
            return set;
          }
          const next = new Set(set);
          next.delete(vaultId);
          return next;
        });
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

  protected vaultKey(vaultId: string, relativePath: string): string {
    return docKey(vaultId, relativePath);
  }

  protected isCollapsed(key: string): boolean {
    return !this.expanded().has(key);
  }

  protected toggleFolder(key: string): void {
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

  protected toggleVaultSection(vaultId: string): void {
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

  /**
   * Header toggle: "Expand all" when any folder is still collapsed, else
   * "Collapse all" (which is the default state, so the button usually
   * expands). Expanding collects every directory key; collapsing empties
   * the set.
   */
  protected readonly allFoldersExpanded = computed<boolean>(() => {
    const expanded = this.expanded();
    let every = true;
    for (const [vaultId, tree] of Object.entries(this.vault.trees())) {
      const walk = (entries: readonly VaultFileEntry[]): void => {
        for (const entry of entries) {
          if (entry.type === 'directory') {
            if (!expanded.has(docKey(vaultId, entry.relativePath))) {
              every = false;
              return;
            }
            if (entry.children?.length) {
              walk(entry.children);
            }
          }
        }
      };
      walk(tree);
      if (!every) {
        break;
      }
    }
    return every;
  });

  protected toggleAllFolders(): void {
    if (!this.allFoldersExpanded()) {
      const paths = new Set<string>();
      for (const [vaultId, tree] of Object.entries(this.vault.trees())) {
        const walk = (entries: readonly VaultFileEntry[]): void => {
          for (const entry of entries) {
            if (entry.type === 'directory') {
              paths.add(docKey(vaultId, entry.relativePath));
              if (entry.children?.length) {
                walk(entry.children);
              }
            }
          }
        };
        walk(tree);
      }
      this.expanded.set(paths);
    } else {
      this.expanded.set(new Set());
    }
  }

  protected onFolderClick(vaultId: string, entry: VaultFileEntry, event?: MouseEvent): void {
    const mod = pointerModifiers(event);
    this.applyPointerSelection(vaultId, entry, mod);
    // Ctrl/Shift clicks adjust the selection only -- they must not fold the
    // folder out from under the user.
    if (!mod?.shiftKey && !mod?.ctrlKey) {
      this.toggleFolder(docKey(vaultId, entry.relativePath));
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
    const nodes = this.visibleNodes();
    if (nodes.length === 0) {
      return;
    }
    const idx = nodes.findIndex((n) => this.keyOf(n) === this.selected());
    const current = idx >= 0 ? nodes[idx] : null;
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
        if (current.kind === 'vault') {
          if (this.collapsedVaults().has(current.vault.id)) {
            this.toggleVaultSection(current.vault.id);
          } else {
            const child = nodes[idx + 1];
            if (child?.kind === 'entry') {
              this.selectAt(nodes, idx + 1, mod);
            }
          }
        } else if (current.entry.type === 'directory') {
          const key = docKey(current.vaultId, current.entry.relativePath);
          if (!this.expanded().has(key)) {
            this.toggleFolder(key);
          } else {
            const child = nodes[idx + 1];
            if (
              child?.kind === 'entry' &&
              child.vaultId === current.vaultId &&
              child.entry.relativePath.startsWith(`${current.entry.relativePath}/`)
            ) {
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
        if (current.kind === 'vault') {
          if (!this.collapsedVaults().has(current.vault.id)) {
            this.toggleVaultSection(current.vault.id);
          }
          break;
        }
        if (
          current.entry.type === 'directory' &&
          this.expanded().has(docKey(current.vaultId, current.entry.relativePath))
        ) {
          this.toggleFolder(docKey(current.vaultId, current.entry.relativePath));
        } else {
          const parent = parentDir(current.entry.relativePath);
          if (parent) {
            this.select(docKey(current.vaultId, parent));
          } else {
            this.select(current.vaultId); // back up to the vault row
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
        if (current.kind === 'vault') {
          this.toggleVaultSection(current.vault.id);
        } else if (current.entry.type === 'directory') {
          this.toggleFolder(docKey(current.vaultId, current.entry.relativePath));
        } else {
          this.onFileClick(current.vaultId, current.entry);
        }
        break;
      }
      case 'Delete': {
        event.preventDefault();
        if (current?.kind === 'entry') {
          const targets = this.selectedEntries(nodes);
          if (targets.length > 0) {
            void this.deleteEntries(targets);
          }
        }
        break;
      }
    }
  }

  /** The identity string a visible row is keyed by. */
  protected keyOf(node: VisibleNode): string {
    return node.kind === 'vault' ? node.vault.id : docKey(node.vaultId, node.entry.relativePath);
  }

  /**
   * The absolute OS path of a tree row — the row's native tooltip (req: the
   * hover tooltip shows the whole path and name). Joins the vault root with
   * the entry's vault-relative path (contract: forward slashes) in the
   * root's separator style; a vault that vanished from the registry
   * degrades to the relative path.
   */
  protected absPathOf(vaultId: string, relativePath: string): string {
    const root = this.vault.vaults().find((v) => v.id === vaultId)?.path;
    if (!root) {
      return relativePath;
    }
    const trimmed = root.endsWith('\\') || root.endsWith('/') ? root.slice(0, -1) : root;
    if (root.includes('\\')) {
      return `${trimmed}\\${relativePath.replace(/\//g, '\\')}`;
    }
    return `${trimmed}/${relativePath}`;
  }

  /** The row's plugin-contributed decoration (SDK 1.17 -- the git status), or `null`. */
  protected decorationOf(vaultId: string, relativePath: string): RowDecoration | null {
    return this.decorations.decorationFor(vaultId, relativePath);
  }

  /** The row tooltip: the absolute path, plus what the decoration says. */
  protected titleOf(vaultId: string, relativePath: string): string {
    const path = this.absPathOf(vaultId, relativePath);
    const tooltip = this.decorationOf(vaultId, relativePath)?.tooltip;
    return tooltip ? `${path} — ${tooltip}` : path;
  }

  private selectAt(nodes: VisibleNode[], i: number, mod?: { shiftKey: boolean; ctrlKey: boolean }): void {
    const node = nodes[i];
    if (!node) {
      return;
    }
    const key = this.keyOf(node);
    if (mod?.ctrlKey) {
      // Ctrl+Arrow: move the keyboard cursor; the selection set stays put.
      this.selected.set(key);
      this.followFocus();
    } else if (mod?.shiftKey && this.anchor()) {
      this.selected.set(key);
      this.selection.set(this.rangeOver(nodes, this.anchor()!, key));
      this.followFocus();
    } else {
      this.select(key);
    }
  }

  private select(key: string): void {
    this.selected.set(key);
    this.selection.set(new Set([key]));
    this.anchor.set(key);
    this.followFocus();
  }

  /**
   * Ctrl+click toggles a row in the set; Shift+click extends the range from
   * the anchor; anything plain collapses back to the single clicked row.
   */
  private applyPointerSelection(
    vaultId: string,
    entry: VaultFileEntry,
    mod?: { shiftKey: boolean; ctrlKey: boolean },
  ): void {
    const key = docKey(vaultId, entry.relativePath);
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
      this.selection.set(this.rangeOver(this.visibleNodes(), anchor, key));
      return;
    }
    this.select(key);
  }

  /** The keys from `from` to `to`, both included, over the visible rows. */
  private rangeOver(nodes: VisibleNode[], from: string, to: string): ReadonlySet<string> {
    const i = nodes.findIndex((n) => this.keyOf(n) === from);
    const j = nodes.findIndex((n) => this.keyOf(n) === to);
    if (i < 0 || j < 0) {
      return new Set([to]);
    }
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    return new Set(nodes.slice(lo, hi + 1).map((n) => this.keyOf(n)));
  }

  /** The visible entries currently in the multi-selection (cursor row only when single). */
  private selectedEntries(nodes: VisibleNode[]): Array<{ vaultId: string; entry: VaultFileEntry }> {
    const selection = this.selection();
    const pick = (n: VisibleNode): { vaultId: string; entry: VaultFileEntry } | null =>
      n.kind === 'entry' ? { vaultId: n.vaultId, entry: n.entry } : null;
    if (selection.size <= 1) {
      const node = nodes.find((n) => this.keyOf(n) === this.selected());
      const picked = node ? pick(node) : null;
      return picked ? [picked] : [];
    }
    return nodes
      .filter((n) => selection.has(this.keyOf(n)))
      .map(pick)
      .filter((v): v is { vaultId: string; entry: VaultFileEntry } => v !== null);
  }

  /** Opens every selected *file*; folders in the selection are skipped. */
  private openSelection(nodes: VisibleNode[]): void {
    let first = true;
    for (const target of this.selectedEntries(nodes)) {
      if (target.entry.type === 'file') {
        // Only the first open replaces the focused clean tab (`openFile`'s
        // default); the rest must open alongside it, not close each other.
        void this.editor.openFile(target.entry.relativePath, target.vaultId, {
          keepFocused: !first,
        });
        first = false;
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

  /**
   * Every legacy `alert()` error path funnels through the in-renderer
   * message dialog now -- the native one breaks keyboard focus on
   * Windows (electron#41602).
   */
  private showError(err: unknown): void {
    void this.dialogs.message({ message: err instanceof Error ? err.message : String(err) });
  }

  /** Manual "re-read every vault from disk" (a full round in main, ADR-0045). */
  protected onRefresh(): void {
    void this.vault.refresh();
  }

  /** Registers another vault via the native folder picker. */
  protected async onAddVault(): Promise<void> {
    this.vaultMenu.set(null);
    try {
      await this.vault.addVault();
    } catch (err) {
      this.showError(err);
    }
  }

  /** Makes this vault the target for daily notes, capture, chats, new notes. */
  protected async onSetActiveVault(vaultId: string): Promise<void> {
    this.vaultMenu.set(null);
    try {
      await this.vault.setActiveVault(vaultId);
    } catch (err) {
      this.showError(err);
    }
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
    if (!pending) {
      return;
    }
    const name = rawName.trim();
    if (!name) {
      return;
    }
    try {
      await this.vault.renameVault(pending.vaultId, name);
    } catch (err) {
      this.showError(err);
    }
  }

  protected async onRevealVault(vaultId: string): Promise<void> {
    this.vaultMenu.set(null);
    try {
      await this.vault.revealVaultFolder(vaultId);
    } catch (err) {
      this.showError(err);
    }
  }

  /** Row menu: reveals the file/folder in the OS file manager (selected in its parent). */
  protected async onRevealEntry(): Promise<void> {
    const menu = this.menu();
    const entry = menu?.entry;
    this.closeMenus();
    if (!menu || !entry) {
      return;
    }
    try {
      await this.vault.revealPath(entry.relativePath, menu.vaultId);
    } catch (err) {
      this.showError(err);
    }
  }

  /** Row menu: opens the OS terminal in the entry's folder (a file's parent). */
  protected async onOpenInTerminal(): Promise<void> {
    const menu = this.menu();
    this.closeMenus();
    if (!menu) {
      return;
    }
    const entry = menu.entry;
    const dir = !entry || entry.type !== 'file' ? menu.dir : parentDir(entry.relativePath);
    try {
      await this.vault.openInTerminal(dir, menu.vaultId);
    } catch (err) {
      this.showError(err);
    }
  }

  /**
   * Registry-only removal: the folder and its files stay on disk. Open tabs
   * of this vault close first -- clean ones silently, each dirty one
   * through its own prompt; a cancelled prompt aborts the removal.
   */
  protected async onRemoveVault(vault: VaultStatus): Promise<void> {
    this.vaultMenu.set(null);
    const tabs = this.editor.openDocs().filter((d) => d.vaultId === vault.id);
    const removeConfirmed = await this.dialogs.confirm({
      title: 'Remove vault',
      message:
        `Remove vault "${vault.name}" from the list? The folder and its files stay on disk.` +
        (tabs.length > 0 ? ` ${tabs.length} open tab(s) will be closed.` : ''),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!removeConfirmed) {
      return;
    }
    for (const doc of tabs) {
      if (!(await this.editor.closeTab(doc.key))) {
        return; // a dirty-tab prompt was cancelled -- keep the vault
      }
    }
    try {
      await this.vault.removeVault(vault.id);
    } catch (err) {
      this.showError(err);
    }
  }

  protected onFileClick(vaultId: string, entry: VaultFileEntry, event?: MouseEvent): void {
    if (entry.type !== 'file') {
      return;
    }
    const mod = pointerModifiers(event);
    this.applyPointerSelection(vaultId, entry, mod);
    if (!mod?.shiftKey && !mod?.ctrlKey) {
      void this.editor.openFile(entry.relativePath, vaultId);
    }
  }

  /**
   * Drag a file onto the editor to insert it (ADR-0028): carry the doc key
   * (`vaultId::path`, ADR-0051) on a private type the editor's drop handler
   * reads (an image gets linked in place, a text file's contents inlined).
   * Set for any file; the editor decides what to do from the extension. The
   * same gesture is also an intra/inter-panel move candidate -- `dragEntry`
   * arms that half. `text/plain` keeps the bare path for external drops.
   */
  protected onFileDragStart(
    event: DragEvent,
    vaultId: string,
    entry: VaultFileEntry,
  ): void {
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
  protected onFolderDragStart(
    event: DragEvent,
    vaultId: string,
    entry: VaultFileEntry,
  ): void {
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

  /** Where a drop on `entry` lands: a folder takes the entry in, a file's row means its parent folder. */
  private destinationDir(entry: VaultFileEntry): string {
    return entry.type === 'directory' ? entry.relativePath : parentDir(entry.relativePath);
  }

  /**
   * False for a no-op (same folder, same vault) and for a folder dropped
   * into itself / its own subtree (same vault only -- a cross-vault drop
   * can never nest inside itself). A drop ON a vault header row targets
   * that vault's root and is handled by `canDropOntoVault`.
   */
  private canDropOnto(vaultId: string, entry: VaultFileEntry): boolean {
    const dragged = this.dragEntry();
    if (!dragged) {
      return false;
    }
    if (dragged.vaultId === vaultId) {
      const dest = this.destinationDir(entry);
      if (dest === parentDir(dragged.entry.relativePath)) {
        return false;
      }
      return (
        dest !== dragged.entry.relativePath &&
        !dest.startsWith(`${dragged.entry.relativePath}/`)
      );
    }
    return true; // cross-vault moves are always valid (copy + delete in main)
  }

  /** Whether a drop on the vault header row (that vault's root) is valid. */
  private canDropOntoVault(vault: VaultStatus): boolean {
    const dragged = this.dragEntry();
    if (!dragged || !vault.exists) {
      return false;
    }
    if (dragged.vaultId === vault.id) {
      // Moving to the vault's own root: a no-op only when already there.
      return parentDir(dragged.entry.relativePath) !== '';
    }
    return true; // a cross-vault move to another vault's root
  }

  protected onRowDragOver(event: DragEvent, vaultId: string, entry: VaultFileEntry): void {
    if (!this.canDropOnto(vaultId, entry)) {
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
    // Validate BEFORE clearing the armed drag -- `canDropOnto` reads it.
    const dragged = this.dragEntry();
    const valid = dragged !== null && this.canDropOnto(vaultId, entry);
    this.dragEntry.set(null);
    if (!valid) {
      return;
    }
    event.preventDefault();
    void this.commitMove(dragged!.vaultId, dragged!.entry.relativePath, vaultId, this.destinationDir(entry));
  }

  protected onVaultRowDragOver(event: DragEvent, vault: VaultStatus): void {
    if (!this.canDropOntoVault(vault)) {
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
    const valid = dragged !== null && this.canDropOntoVault(vault);
    this.dragEntry.set(null);
    if (!valid) {
      return;
    }
    event.preventDefault();
    void this.commitMove(dragged!.vaultId, dragged!.entry.relativePath, vault.id, '');
  }

  /**
   * The move half of `commitRename` (req-23), generalized to ADR-0051:
   * rename/move to the destination folder (possibly in ANOTHER vault --
   * copy + delete in main, the assistant sidecar travels along), re-point
   * open tabs (keeping unsaved buffers), follow the clipboard, reveal the
   * destination.
   */
  private async commitMove(
    fromVaultId: string,
    fromRel: string,
    toVaultId: string,
    destDir: string,
  ): Promise<void> {
    const name = fromRel.slice(fromRel.lastIndexOf('/') + 1);
    const toRel = destDir ? `${destDir}/${name}` : name;
    try {
      // Links and attachments follow the move (milestone 59); null = cancelled.
      if ((await this.linkUpdate.rename(fromVaultId, fromRel, toVaultId, toRel)) === null) {
        return;
      }
      const clip = this.vault.clipboard();
      if (clip && clip.vaultId === fromVaultId && clip.path === fromRel) {
        this.vault.clipboard.set({ vaultId: toVaultId, path: toRel, name });
      }
      this.expand(toVaultId, destDir);
      this.collapsedVaults.update((set) => {
        const next = new Set(set);
        next.delete(toVaultId);
        return next;
      });
    } catch (err) {
      this.showError(err);
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
    if (entry && this.selection().size > 1 && !this.selection().has(docKey(vaultId, entry.relativePath))) {
      this.select(docKey(vaultId, entry.relativePath));
    }
    const dir = !entry
      ? ''
      : entry.type === 'directory'
        ? entry.relativePath
        : parentDir(entry.relativePath);
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 260),
      vaultId,
      dir,
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

  protected startCreate(kind: 'file' | 'directory'): void {
    const menu = this.menu();
    if (!menu) {
      return;
    }
    this.creating.set({ kind, vaultId: menu.vaultId, dir: menu.dir });
    this.closeMenus();
    // The input row renders under its target, so the target must be visible.
    this.collapsedVaults.update((set) => {
      if (!set.has(menu.vaultId)) {
        return set;
      }
      const next = new Set(set);
      next.delete(menu.vaultId);
      return next;
    });
    if (menu.dir) {
      this.expandAncestors(menu.vaultId, menu.dir);
    }
  }

  protected cancelCreate(): void {
    this.creating.set(null);
  }

  /** Mark the right-clicked entry for a later "Paste". */
  protected onCopy(): void {
    const menu = this.menu();
    const entry = menu?.entry;
    this.closeMenus();
    if (menu && entry) {
      this.vault.clipboard.set({ vaultId: menu.vaultId, path: entry.relativePath, name: entry.name });
    }
  }

  /** Paste the clipboard entry into the right-clicked folder (or vault root). */
  protected async onPaste(): Promise<void> {
    const menu = this.menu();
    const clip = this.vault.clipboard();
    this.closeMenus();
    if (!menu || !clip) {
      return;
    }
    try {
      await this.vault.copyEntry(clip.path, menu.dir, clip.vaultId, menu.vaultId);
      this.expand(menu.vaultId, menu.dir);
    } catch (err) {
      this.showError(err);
    }
  }

  protected async onDuplicate(): Promise<void> {
    const menu = this.menu();
    const entry = menu?.entry;
    this.closeMenus();
    if (!menu || !entry) {
      return;
    }
    try {
      await this.vault.duplicateEntry(entry.relativePath, menu.vaultId);
    } catch (err) {
      this.showError(err);
    }
  }

  /** "Export as PDF…" on a .md row -- main reads the file straight from disk. */
  protected async onExportPdf(): Promise<void> {
    const menu = this.menu();
    const entry = menu?.entry;
    this.closeMenus();
    if (!menu || !entry) {
      return;
    }
    try {
      await this.vault.exportPdf(entry.relativePath, menu.vaultId);
    } catch (err) {
      this.showError(err);
    }
  }

  /**
   * Row menu: opens the file pinned ("Open in new tab") -- a pinned tab is
   * never the tab the next plain open replaces, so it stays; already open,
   * it is revealed and pinned.
   */
  protected onOpenInNewTab(): void {
    const menu = this.menu();
    const entry = menu?.entry;
    this.closeMenus();
    if (!menu || !entry || entry.type !== 'file') {
      return;
    }
    void this.editor.openFile(entry.relativePath, menu.vaultId, { pinned: true });
  }

  protected startRename(): void {
    const menu = this.menu();
    const entry = menu?.entry;
    if (menu && entry) {
      this.renaming.set({ vaultId: menu.vaultId, entry });
    }
    this.closeMenus();
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
      void this.dialogs.message({ message: `Invalid name: ${nextName}` });
      return;
    }
    const parent = parentDir(entry.relativePath);
    const toPath = parent ? `${parent}/${nextName}` : nextName;
    try {
      const renamed = await this.linkUpdate.rename(
        pending.vaultId,
        entry.relativePath,
        pending.vaultId,
        toPath,
      );
      if (renamed === null) {
        return;
      }
      const clip = this.vault.clipboard();
      if (clip && clip.vaultId === pending.vaultId && clip.path === entry.relativePath) {
        this.vault.clipboard.set({ vaultId: clip.vaultId, path: toPath, name: nextName });
      }
    } catch (err) {
      this.showError(err);
    }
  }

  /**
   * Expands `dir` AND every ancestor above it, so a reveal inside a
   * collapsed tree actually shows the row (folders start collapsed now --
   * a single-folder flip would open a folder whose parents are still
   * shut).
   */
  private expandAncestors(vaultId: string, dir: string): void {
    if (!dir) {
      return;
    }
    this.expanded.update((set) => {
      const next = new Set(set);
      const parts = dir.split('/');
      for (let i = 1; i <= parts.length; i++) {
        next.add(docKey(vaultId, parts.slice(0, i).join('/')));
      }
      return next;
    });
  }

  private expand(vaultId: string, dir: string): void {
    this.expandAncestors(vaultId, dir);
  }

  protected async onDelete(): Promise<void> {
    const menu = this.menu();
    const entry = menu?.entry;
    if (!menu || !entry) {
      this.closeMenus();
      return;
    }
    // Right-clicking inside a multi-selection deletes the whole selection;
    // anywhere else it stays a single-entry delete.
    const selection = this.selection();
    const targets =
      selection.size > 1 && selection.has(docKey(menu.vaultId, entry.relativePath))
        ? this.selectedEntries(this.visibleNodes())
        : [{ vaultId: menu.vaultId, entry }];
    this.closeMenus();
    await this.deleteEntries(targets);
  }

  /**
   * One `confirm`, per-path tab/clipboard cleanup, one batched IPC delete
   * PER VAULT (a selection can span vaults since ADR-0051).
   */
  private async deleteEntries(targets: Array<{ vaultId: string; entry: VaultFileEntry }>): Promise<void> {
    if (targets.length === 0) {
      return;
    }
    const what =
      targets.length === 1
        ? targets[0].entry.type === 'directory'
          ? 'folder'
          : 'file'
        : `${targets.length} items`;
    const names = targets.map((t) => `"${t.entry.relativePath}"`).join(', ');
    const deleteConfirmed = await this.dialogs.confirm({
      title: `Delete ${what}`,
      message: `${names} will be moved to the recycle bin.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!deleteConfirmed) {
      return;
    }
    for (const target of targets) {
      this.editor.closeTabsUnder(target.vaultId, target.entry.relativePath);
      const clip = this.vault.clipboard();
      if (
        clip &&
        clip.vaultId === target.vaultId &&
        (clip.path === target.entry.relativePath ||
          clip.path.startsWith(`${target.entry.relativePath}/`))
      ) {
        this.vault.clipboard.set(null);
      }
    }
    try {
      const byVault = new Map<string, string[]>();
      for (const target of targets) {
        const list = byVault.get(target.vaultId) ?? [];
        list.push(target.entry.relativePath);
        byVault.set(target.vaultId, list);
      }
      const notTrashed: string[] = [];
      for (const [vaultId, paths] of byVault) {
        notTrashed.push(...(await this.vault.deleteEntries(paths, vaultId)));
      }
      if (notTrashed.length > 0) {
        // The volume has no recycle bin (network share, some removable
        // drives): the delete stood, but permanently -- say so.
        await this.dialogs.message({
          title: 'Deleted permanently',
          message:
            notTrashed.length === 1
              ? `"${notTrashed[0]}" could not be moved to the recycle bin and was deleted permanently.`
              : `${notTrashed.length} items could not be moved to the recycle bin and were deleted permanently.`,
        });
      }
    } catch (err) {
      this.showError(err);
    }
    // Deselect whatever lived under a deleted path (the tree reloads without
    // it; a stale cursor would point at a ghost row).
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
      void this.dialogs.message({ message: `Invalid name: ${name}` });
      return;
    }

    const finalName = pending.kind === 'file' && !name.includes('.') ? `${name}.md` : name;
    const relativePath = pending.dir ? `${pending.dir}/${finalName}` : finalName;

    try {
      await this.vault.createEntry(pending.kind, relativePath, pending.vaultId);
      if (pending.kind === 'file') {
        await this.editor.openFile(relativePath, pending.vaultId);
      }
    } catch (err) {
      this.showError(err);
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeMenus();
    this.renaming.set(null);
    this.renamingVault.set(null);
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
