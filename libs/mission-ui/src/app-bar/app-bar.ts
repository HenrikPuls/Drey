import {
  ChangeDetectionStrategy,
  Component,
  InjectionToken,
  inject,
  input,
  output,
} from '@angular/core';
import { McI18nPipe } from '../i18n/i18n.pipe';

/** What the phone's "Menu" back control does on a top-level page (the shell binds it). */
export interface McAppNav {
  /** Back to the phone's root screen, the menu (req-96, canvas decision 17). */
  openMenu(): void;
}

export const MC_APP_NAV = new InjectionToken<McAppNav | null>('mc-app-nav', {
  providedIn: 'root',
  factory: () => null,
});

/**
 * The one app bar (E13-24, phone rule of req-96): a single row at the top
 * of every Mission Control page — the leading control, the title, then
 * the page's own status or action (projected into `bar-end`), all in the
 * same row. The leading control is always a **labelled back control** to
 * the parent page: on a sub-page the parent `back` names (and `backed`
 * fires on a tap); on a top-level page (Work, Crew, Settings, Chat) it
 * reads "Menu" and asks the shell for the phone's root menu — the phone
 * has no hamburger (canvas decision 17). From 768 px the shell's own
 * chrome (the desktop tab bar, the iPad header) takes over: the "Menu"
 * control hides, and a page that handles the ☰ itself (`ownMenu`: the
 * chat opens its history) shows that ☰ instead. The row carries the
 * status-bar inset (`env(safe-area-inset-top)`) and sticks to the top of
 * the scroll container it sits in, so only the content below moves.
 */
@Component({
  selector: 'mc-app-bar',
  imports: [McI18nPipe],
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
  /** The page shows its own ☰ from 768 px (the chat opens its history). */
  readonly ownMenu = input(false);

  /** The back control was tapped. */
  readonly backed = output<void>();
  /** The page's own ☰ was tapped (from 768 px only). */
  readonly menu = output<void>();

  /** The phone's "Menu" back control: the shell's root menu. */
  protected onMenuBack(): void {
    this.nav?.openMenu();
  }

  protected onOwnMenu(): void {
    this.menu.emit();
  }

  protected onBack(): void {
    this.backed.emit();
  }
}
