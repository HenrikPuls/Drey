/**
 * D-7d — the iOS keyboard. Safari keeps the layout viewport at full height
 * when the keyboard opens: the visual viewport shrinks and, to bring the
 * focused field into view, pans down inside it — which pushed the header and
 * the top of the thread out of sight. The frame is therefore sized from the
 * visual viewport instead: `--mc-vh` is its height, `--mc-vv-top` how far it
 * has panned, and styles.css lays the body over exactly that rectangle. The
 * composer sits right above the keyboard, header and thread stay in place.
 */

export interface ViewportBox {
  readonly height: number;
  readonly offsetTop: number;
  /** Pinch-zoom factor; absent = 1. */
  readonly scale?: number;
}

/**
 * D-5b: only a keyboard resizes the frame. A smaller difference is the browser's
 * own bar collapsing or an inset change — following it made the chrome twitch by
 * a few pixels — and while the owner pinch-zooms, the visual viewport is smaller
 * and panned by design.
 */
export const KEYBOARD_MIN_PX = 120;

/** The CSS variables for a visual viewport; both null = full height, the stylesheet's fallbacks apply. */
export function viewportVarsOf(box: ViewportBox, innerHeight: number): { readonly vh: string | null; readonly top: string | null } {
  const top = Math.max(0, Math.round(box.offsetTop));
  const height = Math.round(box.height);
  if ((box.scale ?? 1) > 1.01 || Math.round(innerHeight) - height < KEYBOARD_MIN_PX) {
    return { vh: null, top: null };
  }
  return { vh: `${height}px`, top: `${top}px` };
}

/** The slice of `window` the tracker needs — the spec passes a fake. */
export interface ViewportHost {
  readonly innerHeight: number;
  readonly document: { readonly documentElement: { readonly style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> } };
  readonly visualViewport?: (ViewportBox & Pick<EventTarget, 'addEventListener'>) | null;
  scrollTo(x: number, y: number): void;
  /** Optional so a spec host stays small; the browser has them. */
  addEventListener?(type: string, listener: () => void): void;
  setTimeout?(handler: () => void, ms: number): unknown;
}

/** When to look again after a focus change: iOS settles the keyboard animation, and sometimes never says so. */
export const RECHECK_AFTER_MS: readonly number[] = [120, 400, 900];

/** Keeps the two variables current; a browser without a visual viewport keeps the plain full-height frame. */
export function trackVisualViewport(host: ViewportHost): void {
  const viewport = host.visualViewport;
  if (viewport === undefined || viewport === null) {
    return;
  }
  const style = host.document.documentElement.style;
  const update = (): void => {
    const vars = viewportVarsOf(viewport, host.innerHeight);
    if (vars.vh === null || vars.top === null) {
      style.removeProperty('--mc-vh');
      style.removeProperty('--mc-vv-top');
      return;
    }
    style.setProperty('--mc-vh', vars.vh);
    style.setProperty('--mc-vv-top', vars.top);
    // The document may be scrolled to reveal the field; the frame is not a page.
    host.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  // D-5b: iOS has been seen to close the keyboard WITHOUT a final visual-viewport
  // resize (the Done key, a tap outside, a backgrounded app): the variables then
  // stayed at the keyboard's values for the rest of the session and the frame sat
  // short and shifted — the "wobble after the composer was used". Every focus
  // change, orientation change, page show and touch end therefore re-reads the
  // viewport, and a focus change re-reads it again once the animation is over.
  const recheck = (): void => {
    update();
    for (const ms of RECHECK_AFTER_MS) {
      host.setTimeout?.(update, ms);
    }
  };
  host.addEventListener?.('resize', update);
  host.addEventListener?.('orientationchange', recheck);
  host.addEventListener?.('pageshow', recheck);
  host.addEventListener?.('focusin', recheck);
  host.addEventListener?.('focusout', recheck);
  host.addEventListener?.('touchend', update);
  update();
}
