import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { MenuService } from '../titlebar';
import { EditorService } from '../services/editor.service';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { EditorContextMenuRegistry } from '../plugin-host';
import { EditorContextMenuService } from './editor-context-menu.service';

/**
 * The editor's right-click menu (ADR-0030), rendered at App level: standard
 * clipboard rows (routed through `MenuService.execEdit`, so they behave
 * exactly like the titlebar Edit menu), then plugin-contributed rows
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

  /** Plugin-contributed rows, evaluated fresh on every menu open. */
  protected readonly pluginItems = computed(() =>
    this.svc.anchor() === null
      ? []
      : this.contributions.items().filter((item) => item.run !== undefined),
  );

  // Close the menu (and its full-screen backdrop) FIRST, then run the
  // action -- if the action throws, the backdrop must not be left covering
  // the app with a dead click handler.
  protected cut(): void {
    this.svc.close();
    this.menu.execEdit('cut');
  }

  protected copy(): void {
    this.svc.close();
    this.menu.execEdit('copy');
  }

  protected paste(): void {
    this.svc.close();
    this.menu.execEdit('paste');
  }

  protected selectAll(): void {
    this.svc.close();
    this.menu.execEdit('selectAll');
  }

  protected runPluginItem(index: number): void {
    const item = this.pluginItems()[index];
    this.svc.close();
    if (item?.run !== undefined) {
      item.run();
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.svc.close();
  }
}
