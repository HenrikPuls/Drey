import { Injectable, signal } from '@angular/core';

/**
 * User-adjustable pane sizes for the shell (sidebar width, entry-drawer
 * height). Kept in a service rather than in `App` so the drag handlers stay
 * thin view code and the values have one place to be read, clamped and
 * persisted (CLAUDE.md, "no business logic inside components").
 *
 * The assistant panel's composer height is the assistant plugin's own
 * `localStorage` value since ADR-0044 stage 7 (`drey.assistant`); the
 * legacy `assistantComposerHeight`/`assistantWidth` entries in this blob
 * are read there once for continuity, then ignored.
 *
 * Persistence is `localStorage`, not the vault or a main-process config:
 * this is per-machine window chrome, not note data, and it must be
 * readable synchronously before first paint so the layout doesn't jump.
 * The write is done straight from the setters (not via an `effect`) so it
 * is synchronous with the drag and easy to reason about.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private static readonly KEY = 'drey.layout';
  private static readonly SIDEBAR = { min: 160, max: 460, def: 220 };
  // The default has to clear the drawer's own content -- topic field, three
  // chip rows, a readable body field and the button row -- otherwise it
  // opens already scrolling, which reads as broken. Dragging below that is
  // allowed and does scroll; that is the user's choice, not the default.
  private static readonly DRAWER = { min: 240, max: 680, def: 430 };

  readonly sidebarWidth = signal(LayoutService.SIDEBAR.def);
  readonly drawerHeight = signal(LayoutService.DRAWER.def);

  constructor() {
    const saved = this.read();
    if (saved) {
      this.sidebarWidth.set(
        clamp(
          saved.sidebarWidth ?? LayoutService.SIDEBAR.def,
          LayoutService.SIDEBAR.min,
          LayoutService.SIDEBAR.max,
        ),
      );
      this.drawerHeight.set(
        clamp(
          saved.drawerHeight ?? LayoutService.DRAWER.def,
          LayoutService.DRAWER.min,
          LayoutService.DRAWER.max,
        ),
      );
    }
  }

  setSidebarWidth(px: number): void {
    this.sidebarWidth.set(clamp(px, LayoutService.SIDEBAR.min, LayoutService.SIDEBAR.max));
    this.persist();
  }

  setDrawerHeight(px: number): void {
    this.drawerHeight.set(clamp(px, LayoutService.DRAWER.min, LayoutService.DRAWER.max));
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(
        LayoutService.KEY,
        JSON.stringify({
          sidebarWidth: this.sidebarWidth(),
          drawerHeight: this.drawerHeight(),
        }),
      );
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }

  private read(): Partial<Record<'sidebarWidth' | 'drawerHeight', number>> | null {
    try {
      const raw = localStorage.getItem(LayoutService.KEY);
      return raw ? (JSON.parse(raw) as Partial<Record<'sidebarWidth' | 'drawerHeight', number>>) : null;
    } catch {
      return null;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
