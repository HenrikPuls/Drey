/**
 * D-5b — the chrome never moves. CSS alone (`overflow: hidden`,
 * `overscroll-behavior`) leaves two ways for iOS to wobble the page by a few
 * pixels: a finger that starts on a bar (header, tab bar, composer row) or on a
 * scroller that has nothing to scroll still rubber-bands the whole frame, and a
 * scroller dragged past its end chains into the page on iOS before 16. So every
 * touch move is judged here: it goes through only when the nearest scrollable
 * ancestor of the finger can still scroll in the direction it is dragged —
 * otherwise it is cancelled. Pinch (two fingers) is never touched.
 */

/** How far an element can still scroll in each direction, in px. */
export interface ScrollRoom {
  readonly up: number; // toward the top: a finger dragging DOWN needs this
  readonly down: number;
  readonly left: number;
  readonly right: number;
}

/** True when a one-finger move of (dx, dy) since the last event must be cancelled. */
export function blocksTouchMove(dx: number, dy: number, room: ScrollRoom | null): boolean {
  if (dx === 0 && dy === 0) {
    return false;
  }
  if (room === null) {
    return true;
  }
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy > 0 ? room.up <= 0 : room.down <= 0;
  }
  return dx > 0 ? room.left <= 0 : room.right <= 0;
}

const SCROLLABLE = /^(auto|scroll)$/;

/** The room of the nearest ancestor (self included) that scrolls on the gesture's axis; null = none does. */
export function scrollRoomOf(target: EventTarget | null, vertical: boolean, view: Pick<Window, 'getComputedStyle'>): ScrollRoom | null {
  let node = target instanceof Element ? target : null;
  while (node !== null) {
    const style = view.getComputedStyle(node);
    const overflow = vertical ? style.overflowY : style.overflowX;
    const span = vertical ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
    if (SCROLLABLE.test(overflow) && span > 1) {
      const at = vertical ? node.scrollTop : node.scrollLeft;
      return vertical
        ? { up: at, down: span - at - 1, left: 0, right: 0 }
        : { up: 0, down: 0, left: at, right: span - at - 1 };
    }
    node = node.parentElement;
  }
  return null;
}

/** The slice of `window` the lock needs — the spec passes the jsdom one. */
export interface ScrollLockHost extends Pick<Window, 'getComputedStyle' | 'scrollTo' | 'addEventListener'> {
  readonly document: Pick<Document, 'addEventListener'>;
  readonly scrollY: number;
}

/** Installs the touch guard and pins the document at scroll 0. */
export function lockPageScroll(host: ScrollLockHost): void {
  let last: { x: number; y: number } | null = null;
  host.document.addEventListener(
    'touchstart',
    (event) => {
      const touch = (event as TouchEvent).touches[0];
      last = (event as TouchEvent).touches.length === 1 && touch !== undefined ? { x: touch.clientX, y: touch.clientY } : null;
    },
    { passive: true },
  );
  host.document.addEventListener(
    'touchmove',
    (event) => {
      const touches = (event as TouchEvent).touches;
      const touch = touches[0];
      if (touches.length !== 1 || touch === undefined || last === null) {
        last = null; // a pinch or a stray move: the browser's business
        return;
      }
      const dx = touch.clientX - last.x;
      const dy = touch.clientY - last.y;
      last = { x: touch.clientX, y: touch.clientY };
      const vertical = Math.abs(dy) >= Math.abs(dx);
      if (blocksTouchMove(dx, dy, scrollRoomOf(event.target, vertical, host)) && event.cancelable) {
        event.preventDefault();
      }
    },
    { passive: false },
  );
  // Whatever still moves the document (focus scrolling, a stray pan) is put back.
  host.addEventListener('scroll', () => {
    if (host.scrollY !== 0) {
      host.scrollTo(0, 0);
    }
  });
}
