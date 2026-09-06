import { Injectable, signal } from '@angular/core';

/**
 * User-adjustable pane sizes for the shell (sidebar width, assistant panel
 * width, entry-drawer height, assistant composer height). Kept in a service
 * rather than in `App` so the drag handlers stay
 * thin view code and the values have one place to be read, clamped and
 * persisted (CLAUDE.md, "no business logic inside components").
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
  // Wide enough for a summary card to read as prose rather than as a
  // column of two-word lines; the max keeps the editor the main surface.
  private static readonly ASSISTANT = { min: 260, max: 560, def: 340 };
  // The default has to clear the drawer's own content -- topic field, three
  // chip rows, a readable body field and the button row -- otherwise it
  // opens already scrolling, which reads as broken. Dragging below that is
  // allowed and does scroll; that is the user's choice, not the default.
  private static readonly DRAWER = { min: 240, max: 680, def: 430 };
  // The assistant panel's question composer. Small default -- a couple of
  // lines, the way a chat input opens -- but draggable up when the user
  // wants to see more of a long question while writing it.
  private static readonly ASSISTANT_COMPOSER = { min: 60, max: 400, def: 120 };

  readonly sidebarWidth = signal(LayoutService.SIDEBAR.def);
  readonly assistantWidth = signal(LayoutService.ASSISTANT.def);
  readonly drawerHeight = signal(LayoutService.DRAWER.def);
  readonly assistantComposerHeight = signal(LayoutService.ASSISTANT_COMPOSER.def);

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
      this.assistantWidth.set(
        clamp(
          saved.assistantWidth ?? LayoutService.ASSISTANT.def,
          LayoutService.ASSISTANT.min,
          LayoutService.ASSISTANT.max,
        ),
      );
      this.drawerHeight.set(
        clamp(
          saved.drawerHeight ?? LayoutService.DRAWER.def,
          LayoutService.DRAWER.min,
          LayoutService.DRAWER.max,
        ),
      );
      this.assistantComposerHeight.set(
        clamp(
          saved.assistantComposerHeight ?? LayoutService.ASSISTANT_COMPOSER.def,
          LayoutService.ASSISTANT_COMPOSER.min,
          LayoutService.ASSISTANT_COMPOSER.max,
        ),
      );
    }
  }

  setSidebarWidth(px: number): void {
    this.sidebarWidth.set(clamp(px, LayoutService.SIDEBAR.min, LayoutService.SIDEBAR.max));
    this.persist();
  }

  setAssistantWidth(px: number): void {
    this.assistantWidth.set(clamp(px, LayoutService.ASSISTANT.min, LayoutService.ASSISTANT.max));
    this.persist();
  }

  setDrawerHeight(px: number): void {
    this.drawerHeight.set(clamp(px, LayoutService.DRAWER.min, LayoutService.DRAWER.max));
    this.persist();
  }

  setAssistantComposerHeight(px: number): void {
    this.assistantComposerHeight.set(
      clamp(px, LayoutService.ASSISTANT_COMPOSER.min, LayoutService.ASSISTANT_COMPOSER.max),
    );
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(
        LayoutService.KEY,
        JSON.stringify({
          sidebarWidth: this.sidebarWidth(),
          assistantWidth: this.assistantWidth(),
          drawerHeight: this.drawerHeight(),
          assistantComposerHeight: this.assistantComposerHeight(),
        }),
      );
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }

  private read(): Partial<
    Record<'sidebarWidth' | 'assistantWidth' | 'drawerHeight' | 'assistantComposerHeight', number>
  > | null {
    try {
      const raw = localStorage.getItem(LayoutService.KEY);
      return raw
        ? (JSON.parse(raw) as Partial<
            Record<
              'sidebarWidth' | 'assistantWidth' | 'drawerHeight' | 'assistantComposerHeight',
              number
            >
          >)
        : null;
    } catch {
      return null;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
