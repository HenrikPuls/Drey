import { Injectable } from '@angular/core';

/**
 * The seam between opening a document and the view it belongs in (ADR-0089
 * decision 7, SDK 1.39). A doc kind or file opener may name a `homeView`;
 * opening such a document asks this router to bring that view up first, so
 * the tab lands there.
 *
 * It is a seam, not a feature: `ViewService` (which depends on the editor
 * service) attaches the handler, and `DocOpenService` (which the editor
 * service is built on) only calls `enter` -- neither imports the other.
 * `suspend` mutes the routing while a saved session is restored: the
 * snapshot already knows which view holds which tab.
 */
@Injectable({ providedIn: 'root' })
export class HomeViewRouter {
  private handler: ((viewId: string) => void) | null = null;
  private suspended = 0;

  attach(handler: (viewId: string) => void): void {
    this.handler = handler;
  }

  /** Mutes `enter` until the returned function is called (nestable). */
  suspend(): () => void {
    this.suspended++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.suspended--;
      }
    };
  }

  /** Brings `viewId` up; nothing for an undefined id, while suspended, or without a handler. */
  enter(viewId: string | undefined): void {
    if (viewId !== undefined && this.suspended === 0 && this.handler !== null) {
      this.handler(viewId);
    }
  }
}
