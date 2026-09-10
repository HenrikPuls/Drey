import { Directive, OnDestroy, inject } from '@angular/core';
import { OverlayGuardService } from './overlay-guard.service';

/**
 * Put `appOverlayGuard` on the root element of any overlay that must sit
 * above a browser tab's page -- a modal, a menu popover, a full-surface
 * screen, a drag ghost (ADR-0042). The element is expected to be
 * `@if`-gated already, so its lifetime *is* "the overlay is open": the
 * directive takes an `OverlayGuardService` guard on construct and releases
 * it on destroy, and `BrowserViewService` hides every `WebContentsView`
 * while any guard is held.
 */
@Directive({ selector: '[appOverlayGuard]' })
export class OverlayGuardDirective implements OnDestroy {
  private readonly release = inject(OverlayGuardService).acquire();

  ngOnDestroy(): void {
    this.release();
  }
}
