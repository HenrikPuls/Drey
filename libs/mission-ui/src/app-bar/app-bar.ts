import {
  ChangeDetectionStrategy,
  Component,
  InjectionToken,
  inject,
  input,
  output,
} from '@angular/core';

/** What the phone's menu control does on a page that does not handle it itself (the shell binds it). */
export interface McAppNav {
  /** The ☰ control: back to the chat with its history and the places open. */
  openMenu(): void;
}

export const MC_APP_NAV = new InjectionToken<McAppNav | null>('mc-app-nav', {
  providedIn: 'root',
  factory: () => null,
});

/**
 * The one app bar (E13-24): a single row at the top of every Mission
 * Control page — the leading control, the title, then the page's own
 * status or action (projected into `bar-end`), all in the same row. The
 * leading control is the ☰ menu on a top-level page and the ‹ back
 * control on a sub-page: setting `back` (the parent page's name) turns it
 * into the back control and emits `backed` on a tap. The row carries the
 * status-bar inset (`env(safe-area-inset-top)`) and sticks to the top of
 * the scroll container it sits in, so only the content below moves.
 * From 768 px the shell's top tab bar replaces the menu control.
 */
@Component({
  selector: 'mc-app-bar',
  templateUrl: './app-bar.html',
  styleUrl: './app-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppBar {
  private readonly nav = inject(MC_APP_NAV);

  /** The page title. */
  readonly title = input('');
  /** An optional mono line under the title (Work: the vault name). */
  readonly sub = input<string | null>(null);
  /** The parent page's name: set = the leading control is the back control. */
  readonly back = input<string | null>(null);
  /** False: from 768 px the back control is hidden (the parent list sits beside the page). */
  readonly backOnWide = input(true);
  /** The page handles the ☰ tap itself (the chat opens its own history). */
  readonly ownMenu = input(false);

  /** The back control was tapped. */
  readonly backed = output<void>();
  /** The menu control was tapped. */
  readonly menu = output<void>();

  protected onMenu(): void {
    if (!this.ownMenu()) {
      this.nav?.openMenu();
    }
    this.menu.emit();
  }

  protected onBack(): void {
    this.backed.emit();
  }
}
