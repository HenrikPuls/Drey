/**
 * Shared chrome for the app's press-then-promote drag gestures (the dock
 * panel header drag in `DockService`, the editor tab drag in
 * `TabDragService`). Not an Angular service -- a single module-level
 * instance so both gestures share one overlay, one ghost element and one
 * set of `<body>` flags.
 *
 * The **overlay** is a full-viewport element mounted for the duration of a
 * drag. It captures the pointer, so nothing underneath fires `:hover` /
 * `mouseover` / starts a text selection while the drag is in flight (the
 * old tab drag let all of that leak through). It also owns the cursor --
 * one place to switch between `grabbing` and `no-drop`. Hit-testing what is
 * under the pointer toggles the overlay's `pointer-events` off around a
 * single `elementFromPoint` call.
 *
 * The **ghost** is the small label chip that follows the cursor.
 *
 * `<body>` gets `user-select: none`, a cursor, and `data-drey-gesture` --
 * the last is the marker `InputRecoveryService`'s watchdog reads to know a
 * gesture is legitimately in progress (ADR-0032); without it a slow drag
 * gets "recovered" out from under the user.
 */

export type DragCursor = 'grabbing' | 'no-drop';

interface DragChromeOptions {
  /** `data-drey-gesture` value -- any non-empty marker (e.g. `'dock'`, `'tab-drag'`). */
  gesture: string;
  /** CSS class for the ghost chip (`dock-drag-ghost` / `tab-drag-ghost`). */
  ghostClass: string;
  /** Inner HTML of the ghost (plain text for a title, or a small markup fragment). */
  ghostHtml: string;
}

let overlay: HTMLElement | null = null;
let ghost: HTMLElement | null = null;

/** True while a drag's overlay/ghost are mounted. */
export function isDragChromeActive(): boolean {
  return overlay !== null;
}

/** Mounts the overlay + ghost and sets the `<body>` gesture flags. Idempotent. */
export function startDragChrome(options: DragChromeOptions): void {
  if (typeof document === 'undefined') {
    return;
  }
  endDragChrome();

  overlay = document.createElement('div');
  overlay.className = 'drag-overlay';
  overlay.style.cursor = 'grabbing';
  document.body.appendChild(overlay);

  ghost = document.createElement('div');
  ghost.className = options.ghostClass;
  ghost.innerHTML = options.ghostHtml;
  document.body.appendChild(ghost);

  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'grabbing';
  document.body.setAttribute('data-drey-gesture', options.gesture);
}

/** Switches the drag cursor (valid target vs. `no-drop`). */
export function setDragCursor(cursor: DragCursor): void {
  if (overlay) {
    overlay.style.cursor = cursor;
  }
  if (typeof document !== 'undefined') {
    document.body.style.cursor = cursor;
  }
}

/** Moves the ghost chip to sit just off the cursor (matches `DockService`'s old offset). */
export function moveDragChrome(clientX: number, clientY: number): void {
  if (ghost) {
    ghost.style.transform = `translate(${clientX + 14}px, ${clientY + 12}px)`;
  }
}

/**
 * The element under the pointer, ignoring the drag overlay (and the
 * `pointer-events: none` ghost). `null` outside the document / when nothing
 * is there.
 */
export function hitTestUnderPointer(clientX: number, clientY: number): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const prev = overlay?.style.pointerEvents ?? '';
  if (overlay) {
    overlay.style.pointerEvents = 'none';
  }
  const el = document.elementFromPoint(clientX, clientY);
  if (overlay) {
    overlay.style.pointerEvents = prev;
  }
  return el;
}

/** Tears everything down: removes the overlay + ghost, clears the `<body>` flags. Safe any time. */
export function endDragChrome(): void {
  overlay?.remove();
  overlay = null;
  ghost?.remove();
  ghost = null;
  if (typeof document !== 'undefined') {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.body.removeAttribute('data-drey-gesture');
  }
}
