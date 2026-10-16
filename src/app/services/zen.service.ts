import { Injectable, signal } from '@angular/core';

/**
 * Zen mode: a chrome-free writing/reading view. While it is on, the
 * titlebar (menu bar and window controls with it), the three docks and
 * the status bar are out of the layout; the centre column -- tab bar,
 * meta bar, editor -- stays. OS fullscreen (F11) is orthogonal and
 * composes with it.
 *
 * A session-transient focus mode, deliberately not persisted (unlike the
 * dock layout): the app always starts in the full shell. It is a pure
 * render gate in `App` -- it never mutates `DockService` state -- so
 * leaving zen restores the layout exactly as it was entered.
 *
 * Toggled by the command `view.toggleZen` (View menu row, default chord
 * `Mod+Alt+Z`; with the menu bar hidden the chord is the one
 * always-visible exit, beside the command palette).
 */
@Injectable({ providedIn: 'root' })
export class ZenService {
  /** True while the chrome is hidden. */
  readonly active = signal(false);

  toggle(): void {
    this.active.update((on) => !on);
  }
}
