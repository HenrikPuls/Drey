import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DockService, type SideDock } from '../dock';
import { DocHistoryService } from '../services/doc-history.service';
import { ThemeService } from '../services/theme.service';
import { Icon } from '../icons/icon';
import { MenuBar } from './menu-bar';
import { WindowChromeService } from './window-chrome.service';

/**
 * The 34px custom titlebar (the window is frameless, ADR-0019): accent
 * square, the left dock toggle, the HTML menu bar, then the right dock
 * toggle and the window controls. The bar
 * itself is a drag region; interactive children opt out with `no-drag`.
 * On macOS the controls are hidden -- the system traffic lights sit there.
 */
@Component({
  selector: 'app-titlebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MenuBar, NgTemplateOutlet],
  templateUrl: './titlebar.html',
  styleUrl: './titlebar.css',
})
export class Titlebar {
  protected readonly chrome = inject(WindowChromeService);
  protected readonly dock = inject(DockService);
  protected readonly history = inject(DocHistoryService);
  protected readonly theme = inject(ThemeService);

  /** An empty dock has nothing to fold; its toggle is disabled. */
  protected hasPanels(side: SideDock): boolean {
    return side === 'left' ? this.dock.hasLeft() : this.dock.hasRight();
  }

  protected toggleLabel(side: SideDock): string {
    return `${this.dock.sideFolded(side) ? 'Show' : 'Hide'} ${side} dock`;
  }
}
