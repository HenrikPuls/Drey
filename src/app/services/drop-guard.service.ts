import { Injectable } from '@angular/core';

/**
 * Window-level drag-and-drop navigation guard (ADR-0027). Chromium's
 * default for a file / URL dropped anywhere on the page is to **navigate
 * the whole `BrowserWindow`** to `file:///…` (or the dragged link),
 * blowing away the SPA. Only `.cm-content` and native input fields have
 * their own drop handling; everything else -- the titlebar, docks, tabs,
 * status bar, the empty state -- needs a blanket `preventDefault`.
 *
 * Mirrors `EditorZoomService`'s global `wheel` guard: capture phase,
 * non-passive, `preventDefault` only (never `stopPropagation`), and the
 * early-return for editable targets means CodeMirror's own `drop` path is
 * untouched. Force-instantiated from `App`.
 */
@Injectable({ providedIn: 'root' })
export class DropGuardService {
  constructor() {
    if (typeof window === 'undefined') {
      return;
    }
    window.addEventListener('dragover', onDragOver, { capture: true, passive: false });
    window.addEventListener('drop', onDrop, { capture: true, passive: false });
  }
}

/** Elements that own their own drop (CodeMirror, native text fields). */
const OWNS_DROP = '.cm-content, input, textarea, [contenteditable="true"]';

/** DataTransfer types a drop we might act on carries. */
const HANDLED_TYPES = ['Files', 'text/uri-list', 'text/html', 'application/x-drey-vault-path'];

function handledElsewhere(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWNS_DROP) !== null;
}

function carriesDrag(data: DataTransfer | null): boolean {
  const types = Array.from(data?.types ?? []);
  return HANDLED_TYPES.some((t) => types.includes(t));
}

function onDragOver(event: DragEvent): void {
  if (handledElsewhere(event.target) || !carriesDrag(event.dataTransfer)) {
    return;
  }
  // Become a drop target so the "copy" cursor shows and `drop` fires here
  // (where it is swallowed) instead of navigating.
  event.preventDefault();
}

function onDrop(event: DragEvent): void {
  if (handledElsewhere(event.target)) {
    return;
  }
  event.preventDefault();
}
