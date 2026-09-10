import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { MenuService } from './menu.service';

/**
 * The File / Edit / Selection / View menu bar. Click toggles a menu;
 * hovering a sibling while one is open switches to it; a full-viewport
 * transparent overlay under the popover closes on an outside click
 * (DESIGN.md "Titlebar").
 */
@Component({
  selector: 'app-menu-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './menu-bar.html',
  styleUrl: './menu-bar.css',
})
export class MenuBar {
  protected readonly menu = inject(MenuService);
}
