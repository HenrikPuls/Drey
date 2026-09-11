import { Directive, OnDestroy, inject } from '@angular/core';
import { OverlayGuardService } from './overlay-guard.service';

/**
 * Put `appOverlayGuard` on the root element of any overlay that must sit
 * above a browser tab's page -- a modal, a menu popover, a full-surface
 * screen, a drag ghost (ADR-0042). The element is expected to be
 * `@if`-gated already, so its lifetime *is* "the overlay is open": the
 * directive takes an `OverlayGuardService` guard on construct and releases
 * it on destroy, and every native surface (the browser plugin's
 * `WebContentsView`s) hides while any guard is held (ADR-0044's
 * `env.onNativeSurfaceVisibility` push).
 */
@Directive({ selector: '[appOverlayGuard]' })
export class OverlayGuardDirective implements OnDestroy {
  private readonly release = inject(OverlayGuardService).acquire();

  ngOnDestroy(): void {
    this.release();
  }
}
