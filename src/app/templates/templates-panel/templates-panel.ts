import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Icon } from '../../icons/icon';
import { PanelHeaderActions } from '../../dock/panel-header-actions';
import { EditorService } from '../../services/editor.service';
import { SettingsService } from '../../services/settings.service';
import { VaultService } from '../../vault';
import { TEMPLATE_DT_TYPE } from '../../editor/image-paste';
import { TemplateCategory, TemplateEntry, TemplateLibraryService } from '../template-library.service';

/** Anchor + target for a template row's right-click menu. */
interface RowMenu {
  x: number;
  y: number;
  entry: TemplateEntry;
}

/**
 * "Templates" dock panel: the configured vault folder rendered as
 * collapsible categories (sub-folders) and sub-categories, each `.md` a
 * row. Click inserts it into the active note; drag drops it into the
 * editor; right-click offers Insert / Edit template.
 */
@Component({
  selector: 'app-templates-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, Icon, PanelHeaderActions],
  templateUrl: './templates-panel.html',
  styleUrl: './templates-panel.css',
})
export class TemplatesPanel {
  protected readonly library = inject(TemplateLibraryService);
  protected readonly vault = inject(VaultService);
  protected readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);

  protected readonly categories = this.library.categories;
  protected readonly settingsDir = this.settings.templatesDir;
  protected readonly isEmpty = computed(() => this.library.all().length === 0);

  /** Category paths the user has collapsed. Categories start expanded. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly menu = signal<RowMenu | null>(null);

  protected isCollapsed(path: string): boolean {
    return this.collapsed().has(path);
  }

  protected toggle(path: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  protected onRefresh(): void {
    void this.vault.refresh();
  }

  protected onRowClick(entry: TemplateEntry): void {
    void this.library.insert(entry.relativePath);
  }

  protected onRowDragStart(event: DragEvent, entry: TemplateEntry): void {
    if (!event.dataTransfer) {
      return;
    }
    event.dataTransfer.setData(TEMPLATE_DT_TYPE, entry.relativePath);
    event.dataTransfer.setData('text/plain', entry.relativePath);
    event.dataTransfer.effectAllowed = 'copy';
  }

  protected openMenu(event: MouseEvent, entry: TemplateEntry): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 100),
      entry,
    });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected insertFromMenu(): void {
    const entry = this.menu()?.entry;
    this.menu.set(null);
    if (entry) {
      void this.library.insert(entry.relativePath);
    }
  }

  protected editFromMenu(): void {
    const entry = this.menu()?.entry;
    this.menu.set(null);
    if (entry) {
      void this.editor.openFile(entry.relativePath);
    }
  }

  protected trackCat(_: number, cat: TemplateCategory): string {
    return cat.path;
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.menu.set(null);
  }
}
