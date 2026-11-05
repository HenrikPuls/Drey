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
}

/** The CSS variables for a visual viewport; both null = full height, the stylesheet's fallbacks apply. */
export function viewportVarsOf(box: ViewportBox, innerHeight: number): { readonly vh: string | null; readonly top: string | null } {
  const top = Math.max(0, Math.round(box.offsetTop));
  const height = Math.round(box.height);
  if (top === 0 && height >= Math.round(innerHeight)) {
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
}

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
  update();
}
