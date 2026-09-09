import { Injectable, signal } from '@angular/core';

/** Where the editor's right-click menu is anchored, or `null` when closed. */
export interface EditorMenuAnchor {
  x: number;
  y: number;
}

/**
 * Owns the editor's renderer context menu (ADR-0030). A single
 * capture-phase `contextmenu` listener on `window` (same shape as
 * `DropGuardService`): when the click is inside a CodeMirror surface it
 * cancels the default and opens the in-app menu; anywhere else -- native
 * `<input>`/`<textarea>` in Settings, the entry topic field, the rendered
 * Markdown -- it does nothing and Electron's own `context-menu` handler
 * (`electron/menu.ts`, gated on `inputFieldType`) shows the OS menu.
 *
 * Force-instantiated from `App` via `start()`.
 */
@Injectable({ providedIn: 'root' })
export class EditorContextMenuService {
  /** Viewport-clamped anchor while the menu is open. */
  readonly anchor = signal<EditorMenuAnchor | null>(null);

  start(): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.addEventListener('contextmenu', this.onContextMenu, { capture: true });
  }

  close(): void {
    this.anchor.set(null);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('.cm-editor') === null) {
      return;
    }
    event.preventDefault();
    this.anchor.set({
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 280),
    });
  };
}
