import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Icon } from '../icons/icon';
import { MenuBar } from './menu-bar';
import { WindowChromeService } from './window-chrome.service';

/**
 * The 34px custom titlebar (the window is frameless, ADR-0019): accent
 * square, the HTML menu bar, then the window controls. The bar
 * itself is a drag region; interactive children opt out with `no-drag`.
 * On macOS the controls are hidden -- the system traffic lights sit there.
 */
@Component({
  selector: 'app-titlebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MenuBar],
  templateUrl: './titlebar.html',
  styleUrl: './titlebar.css',
})
export class Titlebar {
  protected readonly chrome = inject(WindowChromeService);
}
