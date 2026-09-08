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

  /** Folder paths the user has collapsed. Folders start expanded. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly vaultMenuOpen = signal(false);
  protected readonly menu = signal<TreeMenu | null>(null);
  protected readonly creating = signal<PendingCreate | null>(null);

  private readonly createInput = viewChild<ElementRef<HTMLInputElement>>('createInput');

  constructor() {
    effect(() => {
      if (this.creating()) {
        setTimeout(() => this.createInput()?.nativeElement.focus(), 0);
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
      x: Math.min(event.clientX, window.innerWidth - 168),
      y: Math.min(event.clientY, window.innerHeight - 120),
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
  }
}

function parentDir(relativePath: string): string {
  const i = relativePath.lastIndexOf('/');
  return i === -1 ? '' : relativePath.slice(0, i);
}
