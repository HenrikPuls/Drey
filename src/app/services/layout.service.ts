import { Injectable, signal } from '@angular/core';

/**
 * User-adjustable pane sizes for the shell (sidebar width, chat-input
 * height). Kept in a service rather than in `App` so the drag handlers stay
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
  private static readonly CHAT = { min: 76, max: 360, def: 96 };

  readonly sidebarWidth = signal(LayoutService.SIDEBAR.def);
  readonly chatInputHeight = signal(LayoutService.CHAT.def);

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
      this.chatInputHeight.set(
        clamp(
          saved.chatInputHeight ?? LayoutService.CHAT.def,
          LayoutService.CHAT.min,
          LayoutService.CHAT.max,
        ),
      );
    }
  }

  setSidebarWidth(px: number): void {
    this.sidebarWidth.set(clamp(px, LayoutService.SIDEBAR.min, LayoutService.SIDEBAR.max));
    this.persist();
  }

  setChatInputHeight(px: number): void {
    this.chatInputHeight.set(clamp(px, LayoutService.CHAT.min, LayoutService.CHAT.max));
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(
        LayoutService.KEY,
        JSON.stringify({
          sidebarWidth: this.sidebarWidth(),
          chatInputHeight: this.chatInputHeight(),
        }),
      );
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }

  private read(): { sidebarWidth?: number; chatInputHeight?: number } | null {
    try {
      const raw = localStorage.getItem(LayoutService.KEY);
      return raw ? (JSON.parse(raw) as { sidebarWidth?: number; chatInputHeight?: number }) : null;
    } catch {
      return null;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
