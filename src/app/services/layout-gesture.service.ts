import { Injectable, computed, signal } from '@angular/core';

/**
 * A single "the user is dragging a layout boundary right now" flag
 * (ADR-0042) -- a pane splitter, a dock edge, or a dock panel
 * header.
 *
 * Its consumer is the plugin host's native-surface visibility synthesis
 * (ADR-0044): an in-editor browser tab's native `WebContentsView` (the
 * browser plugin) trails a fast drag by a frame, so it is hidden for the
 * gesture's duration and re-measured on release. This lives in a
 * dependency-free leaf service (not on `DockService` / `PaneService`) so
 * the synthesis can read it without pulling the dock component tree
 * into an import cycle.
 *
 * Sources are named so two independent gesture owners (the pane layout and
 * the dock) never clobber each other's state.
 */
@Injectable({ providedIn: 'root' })
export class LayoutGestureService {
  private readonly sources = signal<ReadonlySet<string>>(new Set());

  /** True while any named source has a gesture in flight. */
  readonly active = computed(() => this.sources().size > 0);

  /** Marks `source`'s gesture as in flight (`on`) or finished. */
  set(source: string, on: boolean): void {
    this.sources.update((cur) => {
      if (on === cur.has(source)) {
        return cur;
      }
      const next = new Set(cur);
      if (on) {
        next.add(source);
      } else {
        next.delete(source);
      }
      return next;
    });
  }
}
