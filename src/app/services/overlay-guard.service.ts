import { Injectable, computed, signal } from '@angular/core';

/**
 * Ref-counts "an Angular overlay is currently on screen" (ADR-0042).
 *
 * A browser tab's page lives in a main-process `WebContentsView` composited
 * *above* the entire renderer DOM, so it would paint over any menu, dialog
 * or drag ghost. While `suppressed()` is true, `BrowserViewService` forces
 * every browser view hidden; each overlay site holds a guard for as long as
 * it is mounted.
 *
 * Two ways to hold a guard:
 *  - the `[appOverlayGuard]` attribute directive on an overlay's (already
 *    `@if`-gated) root element -- acquire on construct, release on destroy;
 *  - `acquire()` directly, for imperative gestures with no element of their
 *    own (a tab / dock-header drag).
 */
@Injectable({ providedIn: 'root' })
export class OverlayGuardService {
  private readonly count = signal(0);

  /** True whenever at least one overlay / gesture holds a guard. */
  readonly suppressed = computed(() => this.count() > 0);

  /** Take a guard; call the returned function once to release it (idempotent). */
  acquire(): () => void {
    this.count.update((n) => n + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.count.update((n) => Math.max(0, n - 1));
    };
  }
}
