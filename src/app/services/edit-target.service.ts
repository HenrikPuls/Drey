import { Injectable, signal } from '@angular/core';
import type { EditorView } from '@codemirror/view';

/**
 * Tracks which CodeMirror surface last held focus, so the HTML Edit /
 * Selection menus (`MenuService`) can dispatch editor commands at it.
 *
 * "Last focused", not "currently focused": clicking a menu-bar item moves
 * focus to the menu button and blurs the editor, so a plain focus/blur pair
 * would lose the target before the menu item runs. Instead every
 * `MarkdownSurface` calls `register` on focus and the tracked view is only
 * dropped when focus moves to *another* editable (a native `<input>` /
 * `<textarea>` / `contenteditable` outside any `.cm-editor`) or the surface
 * is destroyed. A menu button is not editable, so opening a menu keeps the
 * target.
 */
@Injectable({ providedIn: 'root' })
export class EditTargetService {
  private _view: EditorView | null = null;

  /** Whether a CodeMirror surface is the current edit target (drives menu enablement). */
  readonly hasView = signal(false);

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('focusin', (event) => this.onFocusIn(event), true);
    }
  }

  /** A surface gained focus. */
  register(view: EditorView): void {
    this._view = view;
    this.hasView.set(true);
  }

  /** A surface is being destroyed; clear it only if it is the tracked one. */
  unregister(view: EditorView): void {
    if (this._view === view) {
      this._view = null;
      this.hasView.set(false);
    }
  }

  /** The tracked view, or null. Callers guard editor-only commands on this. */
  get view(): EditorView | null {
    return this._view;
  }

  private onFocusIn(event: FocusEvent): void {
    const el = event.target as HTMLElement | null;
    if (!el || el.closest('.cm-editor')) {
      // Focus landed inside a CodeMirror surface -- its own focus handler
      // registers it; nothing to clear here.
      return;
    }
    const editable =
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
    if (editable) {
      this._view = null;
      this.hasView.set(false);
    }
    // A non-editable element (a menu button, a toolbar icon) keeps the
    // last editor as the target.
  }
}
