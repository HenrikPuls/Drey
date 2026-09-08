import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { MenuService } from '../../titlebar';
import { EditorService } from '../../services/editor.service';
import { TemplateLibraryService } from '../template-library.service';
import { EditorContextMenuService } from './editor-context-menu.service';

/**
 * The editor's right-click menu (ADR-0030), rendered at App level. Standard
 * clipboard rows (routed through `MenuService.execEdit`, so they behave
 * exactly like the titlebar Edit menu) plus an "Insert template" section:
 * the recently used templates inline, then "All templates…" which opens the
 * picker. The template section is hidden when no note is open.
 */
@Component({
  selector: 'app-editor-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './editor-context-menu.html',
  styleUrl: './editor-context-menu.css',
})
export class EditorContextMenu {
  protected readonly svc = inject(EditorContextMenuService);
  protected readonly menu = inject(MenuService);
  protected readonly editor = inject(EditorService);
  protected readonly library = inject(TemplateLibraryService);

  protected readonly hasNote = computed(() => this.editor.activePath() !== null);

  protected cut(): void {
    this.menu.execEdit('cut');
    this.svc.close();
  }

  protected copy(): void {
    this.menu.execEdit('copy');
    this.svc.close();
  }

  protected paste(): void {
    this.menu.execEdit('paste');
    this.svc.close();
  }

  protected selectAll(): void {
    this.menu.execEdit('selectAll');
    this.svc.close();
  }

  protected insert(relativePath: string): void {
    void this.library.insert(relativePath);
    this.svc.close();
  }

  protected openPicker(): void {
    this.library.openPicker();
    this.svc.close();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.svc.close();
  }
}
