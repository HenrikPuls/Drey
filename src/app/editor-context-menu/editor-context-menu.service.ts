import { Injectable, signal } from '@angular/core';
import { EditorView } from '@codemirror/view';
import { EditorContextMenuRegistry } from '../plugin-host';
import type { EditorContextMenuTarget } from '../../../shared/plugin-api/renderer';

/** Where the editor's right-click menu is anchored, or `null` when closed. */
export interface EditorMenuAnchor {
  x: number;
  y: number;
}

/**
 * Builds the click target for the editor context menu (ADR-0050): an
 * image-tab surface when the click landed on `[data-drey-image]`, an
 * editor surface when it landed inside `.cm-editor`. Exported (with the
 * view lookup injected) so the spec can drive it without real DOM
 * geometry; `findView` is `EditorView.findFromDOM` at the call site.
 *
 * Returns `null` when the DOM does not map to either surface — the native
 * menu path stays untouched then.
 */
export function buildMenuTarget(
  target: Element,
  findView: (cmHost: HTMLElement) => EditorView | null,
): EditorContextMenuTarget | null {
  const imageHost = target.closest('[data-drey-image]');
  if (imageHost !== null) {
    const imagePath = imageHost.getAttribute('data-drey-image');
    return imagePath
      ? { surface: 'image', imagePath }
      : null;
  }
  const cmHost = target.closest('.cm-editor');
  if (cmHost === null) {
    return null;
  }
  // Only a pane editor carries `data-drey-doc`; the entry drawer's and the
  // plugin composers' surfaces stay docPath-less so document-scoped menu
  // rows do not fire on capture/composer surfaces.
  const docPath = target.closest('app-editor')?.getAttribute('data-drey-doc') ?? null;
  let line: { number: number; text: string } | null = null;
  try {
    const view = findView(cmHost as HTMLElement);
    line = view === null ? null : view.state.doc.lineAt(view.posAtDOM(target));
  } catch {
    line = null; // `posAtDOM` rejects nodes outside the document (scroll gadgets etc.)
  }
  return {
    surface: 'editor',
    docPath,
    target,
    lineNumber: line === null ? null : line.number,
    lineText: line === null ? null : line.text,
  };
}

/**
 * Owns the editor's renderer context menu (ADR-0030). A single
 * capture-phase `contextmenu` listener on `window` (same shape as
 * `DropGuardService`): when the click is inside a CodeMirror surface or on
 * an image tab it cancels the default and opens the in-app menu; anywhere
 * else -- native `<input>`/`<textarea>` in Settings, the entry topic field,
 * the rendered Markdown -- it does nothing and Electron's own
 * `context-menu` handler (`electron/menu.ts`, gated on `inputFieldType`)
 * shows the OS menu.
 *
 * Besides the clamped anchor it records WHAT was clicked
 * (`EditorContextMenuTarget`, ADR-0050) so plugin-contributed rows can be
 * surface-scoped (the ocr plugin's "Recognize text").
 *
 * Force-instantiated from `App` via `start()`.
 */
@Injectable({ providedIn: 'root' })
export class EditorContextMenuService {
  /** Viewport-clamped anchor while the menu is open. */
  readonly anchor = signal<EditorMenuAnchor | null>(null);
  /** What the open menu was opened on; null while closed. */
  readonly menuTarget = signal<EditorContextMenuTarget | null>(null);

  constructor(private readonly registry: EditorContextMenuRegistry) {}

  start(): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.addEventListener('contextmenu', this.onContextMenu, { capture: true });
  }

  close(): void {
    this.anchor.set(null);
    this.menuTarget.set(null);
  }

  /**
   * The CodeMirror view of the surface the open menu sits on, or `null`
   * (menu closed, image target, view already gone). The clipboard rows
   * dispatch against THIS view -- not `EditTargetService`'s last-focused
   * pane editor -- so a right-click on a plugin composer (which never
   * registers with the edit target) cuts/copies/pastes right there.
   */
  resolveView(): EditorView | null {
    const target = this.menuTarget();
    if (target === null || target.surface !== 'editor') {
      return null;
    }
    const host = target.target.closest('.cm-editor');
    return host === null ? null : EditorView.findFromDOM(host as HTMLElement);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const menuTarget = buildMenuTarget(target, (el) => EditorView.findFromDOM(el));
    if (menuTarget === null) {
      return;
    }
    // Open only when the menu would have at least one row: an image tab has
    // no built-in rows, so without plugin items there is nothing to show —
    // the native (here: no-op) behaviour stays. Plugin rows count even when
    // disabled (grayed out — that is information worth a menu).
    if (
      menuTarget.surface === 'image' &&
      this.registry.items(menuTarget).filter((item) => item.run !== undefined).length === 0
    ) {
      return;
    }
    event.preventDefault();
    this.menuTarget.set(menuTarget);
    // The clamps reserve room for the whole column: the formatting strip
    // (req-41, ~460px wide on an editor surface) above the menu list,
    // which the css caps at 420px (scrollable beyond) -- so a click near
    // the right or bottom edge shifts the menu far enough to keep the
    // strip, its drop-down menus and every row on screen.
    const width = menuTarget.surface === 'editor' ? 470 : 220;
    this.anchor.set({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - width)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - 470)),
    });
  };
}
