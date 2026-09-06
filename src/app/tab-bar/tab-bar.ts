import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { EditorService } from '../services/editor.service';
import { Icon } from '../icons/icon';

interface TabMenu {
  x: number;
  y: number;
  path: string;
}

/**
 * The row of document tabs above the editor. Pure view over
 * `EditorService.openDocs` / `activePath`: click activates, the X closes
 * (a dirty tab confirms first, in the service). Right-click opens a small
 * menu with "Close all" / "Close others", both routed through the same
 * `closeTab` so the dirty-tab confirmation still applies. The "+" button is
 * a deliberate placeholder until there's a "new note" flow to hang on it.
 */
@Component({
  selector: 'app-tab-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.css',
})
export class TabBar {
  protected readonly editor = inject(EditorService);

  protected readonly menu = signal<TabMenu | null>(null);

  protected onClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    this.editor.closeTab(path);
  }

  protected openMenu(event: MouseEvent, path: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({
      x: Math.min(event.clientX, window.innerWidth - 168),
      y: Math.min(event.clientY, window.innerHeight - 80),
      path,
    });
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeMenu();
  }

  protected closeOthers(path: string): void {
    this.closeMenu();
    this.editor.closeOthers(path);
  }

  protected closeAll(): void {
    this.closeMenu();
    this.editor.closeAll();
  }
}
