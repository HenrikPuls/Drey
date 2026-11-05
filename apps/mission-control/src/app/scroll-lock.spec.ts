// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { blocksTouchMove, lockPageScroll, scrollRoomOf, type ScrollLockHost } from './scroll-lock';

describe('blocksTouchMove (D-5b)', () => {
  const mid = { up: 40, down: 40, left: 0, right: 0 };
  it('cancels every move that starts on chrome or on a scroller with nothing to scroll', () => {
    expect(blocksTouchMove(0, 12, null)).toBe(true);
    expect(blocksTouchMove(5, -3, null)).toBe(true);
  });
  it('lets a scroller scroll while it has room in the dragged direction', () => {
    expect(blocksTouchMove(0, 12, mid)).toBe(false);
    expect(blocksTouchMove(0, -12, mid)).toBe(false);
  });
  it('cancels a drag past either end, so nothing chains into the frame', () => {
    expect(blocksTouchMove(0, 12, { ...mid, up: 0 })).toBe(true); // at the top, dragging down
    expect(blocksTouchMove(0, -12, { ...mid, down: 0 })).toBe(true); // at the bottom, dragging up
  });
  it('judges the dominant axis only', () => {
    expect(blocksTouchMove(30, 4, mid)).toBe(true); // horizontal drag on a vertical scroller
    expect(blocksTouchMove(30, 4, { up: 0, down: 0, left: 10, right: 10 })).toBe(false);
  });
  it('ignores a move that did not move', () => {
    expect(blocksTouchMove(0, 0, null)).toBe(false);
  });
});

function box(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function scrollable(el: HTMLElement, sizes: { sh: number; ch: number; top: number }): void {
  Object.defineProperty(el, 'scrollHeight', { value: sizes.sh, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: sizes.ch, configurable: true });
  el.scrollTop = sizes.top;
  el.style.overflowY = 'auto';
}

describe('scrollRoomOf (D-5b)', () => {
  it('finds the nearest scrolling ancestor and its room', () => {
    const root = box('<div id="s"><p id="t">x</p></div>');
    const s = root.querySelector<HTMLElement>('#s')!;
    scrollable(s, { sh: 500, ch: 200, top: 100 });
    expect(scrollRoomOf(root.querySelector('#t'), true, window)).toEqual({ up: 100, down: 199, left: 0, right: 0 });
  });
  it('is null on chrome and on a scroller whose content fits', () => {
    const root = box('<header id="h">x</header><div id="s">y</div>');
    scrollable(root.querySelector<HTMLElement>('#s')!, { sh: 200, ch: 200, top: 0 });
    expect(scrollRoomOf(root.querySelector('#h'), true, window)).toBeNull();
    expect(scrollRoomOf(root.querySelector('#s'), true, window)).toBeNull();
  });
});

describe('lockPageScroll (D-5b)', () => {
  function touch(type: string, target: Element, points: { x: number; y: number }[]): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
    target.dispatchEvent(event);
    return event;
  }

  it('cancels a drag on the header, lets the content scroll, cancels it at the end, never touches a pinch', () => {
    const root = box('<header id="h">bar</header><div id="s"><p id="t">x</p></div>');
    scrollable(root.querySelector<HTMLElement>('#s')!, { sh: 500, ch: 200, top: 100 });
    lockPageScroll(window as unknown as ScrollLockHost);
    const h = root.querySelector('#h')!;
    const t = root.querySelector('#t')!;

    touch('touchstart', h, [{ x: 10, y: 10 }]);
    expect(touch('touchmove', h, [{ x: 10, y: 14 }]).defaultPrevented).toBe(true);

    touch('touchstart', t, [{ x: 10, y: 100 }]);
    expect(touch('touchmove', t, [{ x: 10, y: 90 }]).defaultPrevented).toBe(false);

    root.querySelector<HTMLElement>('#s')!.scrollTop = 0;
    touch('touchstart', t, [{ x: 10, y: 100 }]);
    expect(touch('touchmove', t, [{ x: 10, y: 120 }]).defaultPrevented).toBe(true); // top, dragging down

    touch('touchstart', h, [{ x: 10, y: 10 }]);
    expect(
      touch('touchmove', h, [
        { x: 10, y: 14 },
        { x: 60, y: 14 },
      ]).defaultPrevented,
    ).toBe(false);
  });
});
