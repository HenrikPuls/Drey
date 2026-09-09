/**
 * DOM plumbing shared by the Live Preview block widgets (`widgets.ts`,
 * `mermaid-widget.ts`): the hover corner cluster, the `</>` / lens buttons
 * that sit in it, the "which clicks reach CodeMirror" predicate, and the
 * image-sizing helper. Kept separate so a widget file only pulls in the
 * chrome, not every sibling widget.
 */

/**
 * A 12px stroked-icon `<button>`. `paths` is the inner SVG markup (the
 * `<svg>` wrapper with its shared attributes is added here) so the two
 * icons we use never drift apart.
 */
function iconButton(className: string, title: string, paths: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.title = title;
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    paths +
    '</svg>';
  return btn;
}

/**
 * The hover corner cluster shared by rendered block widgets: a flex row
 * pinned to the widget's top-right that holds the `</>` "View source"
 * button and, where the widget has one, the zoom lens -- so the two never
 * stack on top of each other. Returns the container for the caller to
 * append its buttons into.
 */
export function appendTools(parent: HTMLElement): HTMLElement {
  // A `<span>`, not a `<div>`: `ImageWidget` is an *inline* replace
  // decoration, so its DOM should stay inline-level. `display:flex` in the
  // theme still lays the buttons out in a row (the element is
  // `position:absolute`, so it's out of flow anyway).
  const tools = document.createElement('span');
  tools.className = 'lp-tools';
  parent.appendChild(tools);
  return tools;
}

/**
 * The `</>` "View source" affordance on rendered block widgets
 * (Obsidian-style): clicking it drops the cursor into the block's source.
 * It is the ONE part of such a widget whose events go to CodeMirror (see
 * `ignoreWidgetEvent`) -- everything else stays interactive widget content,
 * so e.g. a `<details>` summary toggles instead of yanking the user into
 * the source.
 */
export function makeEditButton(): HTMLButtonElement {
  return iconButton('lp-edit', 'View source', '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>');
}

/**
 * The magnifier-with-`+` lens that opens an embed (image or diagram) in the
 * shared full-app viewer. It handles its own click and `stopPropagation`s,
 * so CodeMirror never sees it -- no `ignoreEvent` override needed for it.
 */
export function makeLensButton(onActivate: () => void, extraClass?: string): HTMLButtonElement {
  const lens = iconButton(
    extraClass ? `lp-lens ${extraClass}` : 'lp-lens',
    'Open full view',
    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
  );
  lens.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  return lens;
}

/**
 * `true` (= CodeMirror ignores it) for everything except the `</>` button
 * and a mermaid error box -- clicking the error message anywhere should
 * drop the cursor into the fence to fix it, not stay swallowed by the
 * widget.
 */
export function ignoreWidgetEvent(event: Event): boolean {
  if (!(event.target instanceof Element)) {
    return true;
  }
  return (
    event.target.closest('.lp-edit') === null && event.target.closest('.lp-mermaid-error') === null
  );
}

/** Apply an Obsidian-style `![alt|300x200]` size suffix as CSS px. */
export function applyImageSize(
  img: HTMLImageElement,
  width: number | null,
  height: number | null,
): void {
  if (width !== null) {
    img.style.width = `${width}px`;
  }
  if (height !== null) {
    img.style.height = `${height}px`;
  }
}
