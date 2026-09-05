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
import { EditorService } from '../services/editor.service';
import { VaultService } from '../services/vault.service';
import { VaultFileEntry } from '../../../shared/ipc-api';
import { Calendar } from './calendar/calendar';
import { OpenWindows } from './open-windows/open-windows';
import { Icon } from '../icons/icon';

/** Anchor + target folder for the file-tree right-click menu. */
interface TreeMenu {
  x: number;
  y: number;
  /** Vault-relative folder the new entry lands in; '' means the vault root. */
  dir: string;
}

/** An in-progress "new file" / "new folder" with its inline name input showing. */
interface PendingCreate {
  kind: 'file' | 'directory';
  dir: string;
}

/**
 * Left column: mini-calendar, the vault file tree ("Files"), the
 * open-windows list, and a settings entry pinned at the bottom (CLAUDE.md,
 * "UI/UX Design"). Folder collapse state and the right-click "new file /
 * new folder" flow are local view state; the actual create call and the
 * tree reload live in `VaultService`.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, Calendar, OpenWindows, Icon],
  styleUrl: './sidebar.css',
  templateUrl: './sidebar.html',
})
export class Sidebar {
  protected readonly vault = inject(VaultService);
  protected readonly editor = inject(EditorService);

  /** Folder paths the user has collapsed. Folders start expanded. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly menu = signal<TreeMenu | null>(null);
  protected readonly creating = signal<PendingCreate | null>(null);

  private readonly createInput = viewChild<ElementRef<HTMLInputElement>>('createInput');

  constructor() {
    effect(() => {
      if (this.creating()) {
        // Wait for the @if branch to render before reaching for the input.
        setTimeout(() => this.createInput()?.nativeElement.focus(), 0);
      }
    });
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

  protected onSelectVault(): void {
    void this.vault.selectVault();
  }

  protected onFileClick(entry: VaultFileEntry): void {
    if (entry.type === 'file') {
      void this.editor.openFile(entry.relativePath);
    }
  }

  /**
   * Right-click on the file panel. With no `entry` (empty area) the target
   * is the vault root; on a folder it's that folder; on a file it's the
   * file's parent folder.
   */
  protected openMenu(event: MouseEvent, entry?: VaultFileEntry): void {
    // Let the native editable menu (cut/copy/paste) win inside the name input.
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
      y: Math.min(event.clientY, window.innerHeight - 96),
      dir,
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

  /**
   * Confirms the inline input. Runs on both Enter and blur, so it's guarded
   * to be a no-op the second time. A file name with no dot gets `.md`
   * appended -- these notes are Markdown, and typing the extension every
   * time is friction (flagged as an assumption, not spec'd).
   */
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
  }
}

function parentDir(relativePath: string): string {
  const i = relativePath.lastIndexOf('/');
  return i === -1 ? '' : relativePath.slice(0, i);
}
