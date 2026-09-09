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
import { VaultService } from '../../services/vault.service';
import { VaultFileEntry } from '../../../../shared/ipc-api';
import { Icon } from '../../icons/icon';

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
  imports: [NgTemplateOutlet, Icon],
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
   * for Up/Down/Left/Right navigation, like a file explorer.
   */
  protected readonly selected = signal<string | null>(null);

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

  protected onFolderClick(entry: VaultFileEntry): void {
    this.selected.set(entry.relativePath);
    this.toggleFolder(entry.relativePath);
  }

  /**
   * File-explorer keyboard navigation on the tree container: Up/Down move
   * the selection one visible row, Right/Left expand/collapse a folder (or
   * step in/out), Enter/Space open a file or toggle a folder. Every handled
   * key calls `preventDefault()` so the container does not also scroll.
   */
  protected onTreeKeydown(event: KeyboardEvent): void {
    const nodes = this.visibleNodes();
    if (nodes.length === 0) {
      return;
    }
    const idx = nodes.findIndex((n) => n.entry.relativePath === this.selected());
    const current = idx >= 0 ? nodes[idx].entry : null;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectAt(nodes, idx < 0 ? 0 : Math.min(idx + 1, nodes.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selectAt(nodes, idx < 0 ? nodes.length - 1 : Math.max(idx - 1, 0));
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
              this.selectAt(nodes, idx + 1);
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
      case ' ':
        // A focused node <button> activates itself -- only act here when the
        // scroll container itself has focus, to avoid a double toggle.
        if (!current || event.target !== event.currentTarget) {
          break;
        }
        event.preventDefault();
        if (current.type === 'directory') {
          this.toggleFolder(current.relativePath);
        } else {
          this.onFileClick(current);
        }
        break;
    }
  }

  private selectAt(nodes: { entry: VaultFileEntry }[], i: number): void {
    const entry = nodes[i]?.entry;
    if (entry) {
      this.select(entry.relativePath);
    }
  }

  private select(path: string): void {
    this.selected.set(path);
    // Wait for the `.selected` class to land, then keep the row in view.
    setTimeout(() => {
      this.host.querySelector('.node.selected')?.scrollIntoView({ block: 'nearest' });
    }, 0);
  }

  protected toggleVaultMenu(): void {
    this.vaultMenuOpen.update((v) => !v);
  }

  protected onOpenOtherVault(): void {
    this.vaultMenuOpen.set(false);
    void this.vault.selectVault();
  }

  /** Manual "re-read the vault from disk" -- there is no file watcher. */
  protected onRefresh(): void {
    void this.vault.refresh();
  }

  protected onFileClick(entry: VaultFileEntry): void {
    if (entry.type === 'file') {
      this.selected.set(entry.relativePath);
      void this.editor.openFile(entry.relativePath);
    }
  }

  /**
   * Drag a file onto the editor to insert it (ADR-0028): carry the vault
   * path on a private type the editor's drop handler reads (an image gets
   * linked in place, a text file's contents inlined). Set for any file;
   * the editor decides what to do from the extension.
   */
  protected onFileDragStart(event: DragEvent, entry: VaultFileEntry): void {
    if (entry.type !== 'file' || !event.dataTransfer) {
      return;
    }
    event.dataTransfer.setData('application/x-drey-vault-path', entry.relativePath);
    event.dataTransfer.setData('text/plain', entry.relativePath);
    event.dataTransfer.effectAllowed = 'copyLink';
  }

  protected openMenu(event: MouseEvent, entry?: VaultFileEntry): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
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
    const what = entry.type === 'directory' ? 'folder' : 'file';
    if (!confirm(`Delete ${what} "${entry.relativePath}"? This cannot be undone.`)) {
      return;
    }
    this.editor.closeTabsUnder(entry.relativePath);
    const clip = this.vault.clipboard()?.path;
    if (clip && (clip === entry.relativePath || clip.startsWith(`${entry.relativePath}/`))) {
      this.vault.clipboard.set(null);
    }
    try {
      await this.vault.deleteEntry(entry.relativePath);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
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
  }
}

function parentDir(relativePath: string): string {
  const i = relativePath.lastIndexOf('/');
  return i === -1 ? '' : relativePath.slice(0, i);
}
