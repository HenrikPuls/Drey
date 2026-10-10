import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { MenuService } from '../titlebar';
import { EditorService } from '../services/editor.service';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { EditorContextMenuRegistry } from '../plugin-host';
import { EditorContextMenuService } from './editor-context-menu.service';

/**
 * The editor's right-click menu (ADR-0030), rendered at App level: standard
 * clipboard rows -- routed through `MenuService.execEdit` with the view of
 * the clicked surface, so they act right there (like Ctrl+V would) instead
 * of on the last-focused pane editor -- then plugin-contributed rows
 * (ADR-0044) — the template recents that used to live here are the
 * Templates plugin's context-menu contribution now.
 */
@Component({
  selector: 'app-editor-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './editor-context-menu.html',
  styleUrl: './editor-context-menu.css',
})
export class EditorContextMenu {
  protected readonly svc = inject(EditorContextMenuService);
  protected readonly menu = inject(MenuService);
  protected readonly editor = inject(EditorService);
  private readonly contributions = inject(EditorContextMenuRegistry);

  /** Base rows (head group) and plugin rows (tail group), per menu open. */
  protected readonly baseItems = computed(() => this.group('head').filter((item) => item.run !== undefined));

  protected readonly pluginItems = computed(() => this.group('tail').filter((item) => item.run !== undefined));

  private group(kind: 'head' | 'tail'): readonly { label: string; disabled?: boolean; run(): void }[] {
    const target = this.svc.menuTarget();
    if (this.svc.anchor() === null || target === null) {
      return [];
    }
    const grouped = this.contributions.groupedItems(target);
    return kind === 'head' ? grouped.head : grouped.tail;
  }

  // Close the menu (and its full-screen backdrop) FIRST, then run the
  // action -- if the action throws, the backdrop must not be left covering
  // the app with a dead click handler. The clipboard rows resolve the view
  // of the clicked surface BEFORE closing (close() drops the target), so
  // they land on the right-clicked editor, not the last-focused pane.
  protected cut(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('cut', view);
  }

  protected copy(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('copy', view);
  }

  protected paste(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('paste', view);
  }

  protected selectAll(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('selectAll', view);
  }

  protected runBaseItem(index: number): void {
    const item = this.baseItems()[index];
    this.svc.close();
    if (item?.run !== undefined && item.disabled !== true) {
      item.run();
    }
  }

  protected runPluginItem(index: number): void {
    const item = this.pluginItems()[index];
    this.svc.close();
    if (item?.run !== undefined && item.disabled !== true) {
      item.run();
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.svc.close();
  }
}
