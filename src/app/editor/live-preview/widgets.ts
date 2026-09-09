import { WidgetType } from '@codemirror/view';
import type { MermaidConfig } from 'mermaid';

/** `•` in place of a bullet-list `-` / `*` / `+` marker. */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-bullet';
    span.textContent = '•';
    return span;
  }
}

/**
 * A real checkbox in place of a `[ ]` / `[x]` task marker. The click is
 * handled by the conceal plugin's `mousedown` handler (which edits the
 * underlying text), not by the widget itself -- `ignoreEvent` returning
 * `false` lets the event through to the editor.
 */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-task';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    span.appendChild(box);
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** A thematic-break line in place of `---` / `***`. */
export class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-hr';
    return span;
  }
}

/**
 * An embedded `<img>` in place of `![alt](path)`. `src === null` means the
 * path could not be resolved to something servable (escapes the vault, no
 * open document); a load error at runtime falls back to the same
 * placeholder, so a broken reference reads as text instead of a broken icon.
 *
 * `width` / `height` come from an Obsidian-style `![alt|300](path)` /
 * `![alt|300x200](path)` suffix (`shared/image-embed.ts`) and are applied
 * as CSS px; the theme's `max-width: 100%` still caps overflow.
 *
 * When `onOpenImage` is given (and the src resolved), a hover lens button
 * opens the image in the full-app viewer (ADR-0026). Its click is handled
 * by a direct DOM listener that `stopPropagation`s, so CodeMirror never
 * sees it -- no `ignoreEvent` override needed for the lens.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string | null,
    readonly alt: string,
    readonly width: number | null = null,
    readonly height: number | null = null,
    readonly onOpenImage?: (src: string) => void,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-image';
    if (this.src === null) {
      span.appendChild(this.placeholder());
      return span;
    }
    const src = this.src;
    const img = document.createElement('img');
    img.src = src;
    img.alt = this.alt;
    if (this.width !== null) {
      img.style.width = `${this.width}px`;
    }
    if (this.height !== null) {
      img.style.height = `${this.height}px`;
    }
    img.onerror = () => {
      img.remove();
      span.querySelector('.lp-tools')?.remove();
      span.querySelector('.lp-resize')?.remove();
      span.appendChild(this.placeholder());
    };
    span.appendChild(img);

    const tools = appendTools(span);
    tools.appendChild(makeEditButton());

    if (this.onOpenImage) {
      const open = this.onOpenImage;
      const lens = document.createElement('button');
      lens.type = 'button';
      lens.className = 'lp-lens';
      lens.title = 'Open full view';
      lens.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>';
      lens.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        open(src);
      });
      tools.appendChild(lens);
    }

    // Corner grip -- the actual drag is a delegated `EditorView`
    // `pointerdown` handler in `block-render.ts` (the widget has no view).
    const grip = document.createElement('span');
    grip.className = 'lp-resize';
    grip.setAttribute('aria-hidden', 'true');
    span.appendChild(grip);
    return span;
  }

  /**
   * CodeMirror ignores everything inside the widget (default `true`)
   * except a `.lp-resize` grip (the block-render `domEventHandlers` needs
   * that `pointerdown`) and the `</>` "View source" button (its click goes
   * through `clickToReveal`). The lens button handles its own click and
   * `stopPropagation`s, so it never gets here.
   */
  override ignoreEvent(event: Event): boolean {
    if (!(event.target instanceof Element)) {
      return true;
    }
    return (
      event.target.closest('.lp-resize') === null && event.target.closest('.lp-edit') === null
    );
  }

  private placeholder(): HTMLElement {
    const missing = document.createElement('span');
    missing.className = 'lp-image-missing';
    missing.textContent = `image not found: ${this.alt || '(no alt text)'}`;
    return missing;
  }
}

/**
 * A read-only copy of a rendered image, shown directly below the raw
 * `![alt](path)` line while that image's source is revealed (ADR-0009
 * "Later change"). Unlike `ImageWidget` it has no lens, resize grip or
 * `</>` button -- it is a mirror of what the note will look like, not an
 * interactive surface. It lives in the non-atomic `reveal` decoration
 * layer, so the caret stays on the editable source line above it.
 */
export class ImagePreviewWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | null = null,
    readonly height: number | null = null,
  ) {
    super();
  }

  override eq(other: ImagePreviewWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-image lp-image-preview';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    if (this.width !== null) {
      img.style.width = `${this.width}px`;
    }
    if (this.height !== null) {
      img.style.height = `${this.height}px`;
    }
    // The raw markup is already on the line above -- a broken reference
    // just drops the mirror instead of showing its own placeholder.
    img.onerror = () => img.remove();
    span.appendChild(img);
    return span;
  }
}

/**
 * The hover corner cluster shared by rendered block widgets: a flex row
 * pinned to the widget's top-right that holds the `</>` "View source"
 * button and, where the widget has one, the zoom lens -- so the two never
 * stack on top of each other. Returns the container for the caller to
 * append its buttons into.
 */
function appendTools(parent: HTMLElement): HTMLElement {
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
function makeEditButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lp-edit';
  btn.title = 'View source';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>';
  return btn;
}

/**
 * `true` (= CodeMirror ignores it) for everything except the `</>` button
 * and a mermaid error box -- clicking the error message anywhere should
 * drop the cursor into the fence to fix it, not stay swallowed by the
 * widget.
 */
function ignoreWidgetEvent(event: Event): boolean {
  if (!(event.target instanceof Element)) {
    return true;
  }
  return (
    event.target.closest('.lp-edit') === null && event.target.closest('.lp-mermaid-error') === null
  );
}

/**
 * A rendered HTML block (`<div>`, `<table>`, `<details>`, ...) in place of
 * raw HTML in the note -- Markdown allows embedded HTML, so Live Preview
 * renders it. `html` MUST already be sanitized (`sanitize-html.ts`).
 * The hover `</>` reveals the source; content clicks stay in the widget.
 */
export class HtmlBlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly source: string,
  ) {
    super();
  }

  override eq(other: HtmlBlockWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'lp-html';
    div.innerHTML = this.html;
    appendTools(div).appendChild(makeEditButton());
    return div;
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreWidgetEvent(event);
  }
}

/**
 * mermaid is a large renderer (d3, dagre, …) -- load it lazily on the
 * first diagram and configure it once (ADR-0025). `securityLevel: 'strict'`
 * routes its output through DOMPurify and blocks click handlers; the app
 * has no CSP, but strict mode is the safe default for note content.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

const MERMAID_BASE_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  darkMode: true,
  fontFamily: 'var(--font-sans, system-ui, sans-serif)',
  // Throw a parse error out of `render()` instead of drawing mermaid's
  // built-in "bomb" diagram -- we show our own compact box.
  suppressErrorRendering: true,
};

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      mod.default.initialize(MERMAID_BASE_CONFIG);
      return mod.default;
    });
  }
  return mermaidPromise;
}

let mermaidRenderSeq = 0;
let mermaidFontFamily = '';

/**
 * Re-pin mermaid's `fontFamily` to the editor's *resolved* typeface before
 * a render. `MERMAID_BASE_CONFIG.fontFamily` is `var(--font-sans, …)`, which
 * mermaid resolves against its own offscreen measuring node -- not
 * `.cm-content`, where Settings → Appearance overrides `--font-sans`. So a
 * non-sans editor font makes mermaid measure every label in a fallback sans,
 * size the node box to that, then paint the (wider) real font -- the label
 * spills past its rectangle (mild for serif, ~40% for monospace). Feeding
 * the concrete resolved stack makes measurement and paint agree.
 *
 * `mermaid.initialize` replaces the whole config (it does not merge onto the
 * previous call), so the full base config is re-sent with `fontFamily`
 * overridden.
 */
function syncMermaidFont(mermaid: typeof import('mermaid').default, near: HTMLElement): void {
  const host = near.closest('.cm-scroller') ?? document.querySelector('.cm-scroller');
  const font = host ? getComputedStyle(host).fontFamily : '';
  if (font && font !== mermaidFontFamily) {
    mermaidFontFamily = font;
    mermaid.initialize({ ...MERMAID_BASE_CONFIG, fontFamily: font });
  }
}

/**
 * Serialises a rendered SVG string to a `data:` URL an `<img>` (the shared
 * image viewer) can load. A `viewBox` is promoted to explicit `width` /
 * `height` attributes and the `max-width` style dropped, so the `<img>`
 * reports a real `naturalWidth`/`Height` -- mermaid otherwise emits
 * `style="max-width…"` + `width="100%"`, which would give the lightbox a
 * zero natural size and break Fit / zoom.
 */
export function svgToDataUrl(svg: string): string {
  let markup = svg;
  try {
    const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    if (el && el.nodeName.toLowerCase() === 'svg' && !el.querySelector('parsererror')) {
      const vb = el.getAttribute('viewBox');
      const m = vb?.match(/-?[\d.]+\s+-?[\d.]+\s+([\d.]+)\s+([\d.]+)/);
      if (m) {
        el.setAttribute('width', m[1]);
        el.setAttribute('height', m[2]);
        el.style.removeProperty('max-width');
      }
      markup = new XMLSerializer().serializeToString(el);
    }
  } catch {
    // fall back to the raw markup
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/**
 * A rendered Mermaid diagram in place of a ` ```mermaid ` fenced block
 * (ADR-0025) -- Live-Preview-only, like tables: the cursor entering the
 * fence reveals the raw source. Renders asynchronously (dynamic
 * `import('mermaid')`) so the bundle stays out of the initial load; a
 * "rendering…" note holds the space until it resolves, and a parse error
 * becomes a compact inline box rather than throwing into the editor.
 *
 * With `onZoom` (the Live Preview config's `onZoomDiagram`) a hover lens
 * button opens the diagram in the shared image viewer -- same recipe as
 * `ImageWidget`'s `.lp-lens`, the SVG handed over as a `data:` URL.
 */
export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly onZoom?: (dataUrl: string) => void,
  ) {
    super();
  }

  override eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lp-mermaid';
    const pending = document.createElement('span');
    pending.className = 'lp-mermaid-pending';
    pending.textContent = 'rendering diagram…';
    wrap.appendChild(pending);
    appendTools(wrap).appendChild(makeEditButton());
    void this.render(wrap);
    return wrap;
  }

  private async render(wrap: HTMLElement): Promise<void> {
    const id = `lp-mermaid-${mermaidRenderSeq++}`;
    let result: HTMLElement;
    let renderedSvg: string | null = null;
    try {
      const mermaid = await loadMermaid();
      syncMermaidFont(mermaid, wrap);
      const { svg } = await mermaid.render(id, this.source);
      renderedSvg = svg;
      result = document.createElement('div');
      result.className = 'lp-mermaid-svg';
      result.innerHTML = svg;
    } catch (error) {
      result = document.createElement('pre');
      result.className = 'lp-mermaid-error';
      result.textContent = `Mermaid: ${error instanceof Error ? error.message : String(error)}`;
    }
    // mermaid can leave its offscreen measuring node behind on a parse error.
    document.getElementById(`d${id}`)?.remove();
    if (!wrap.isConnected) {
      return; // the widget was replaced while mermaid worked
    }
    wrap.querySelector('.lp-mermaid-pending')?.remove();
    // Anchor on `.lp-tools` (a real direct child of `wrap`); `.lp-edit` now
    // lives inside that cluster, so it is no longer a valid `insertBefore`
    // reference node here.
    wrap.insertBefore(result, wrap.querySelector('.lp-tools'));

    if (renderedSvg !== null && this.onZoom) {
      const svg = renderedSvg;
      const zoom = this.onZoom;
      const lens = document.createElement('button');
      lens.type = 'button';
      lens.className = 'lp-lens lp-mermaid-lens';
      lens.title = 'Open full view';
      lens.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>';
      lens.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        zoom(svgToDataUrl(svg));
      });
      wrap.querySelector('.lp-tools')?.appendChild(lens);
    }
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreWidgetEvent(event);
  }
}

/**
 * A rendered HTML table in place of a raw GFM table block. `html` comes from
 * markdown-it with `html: false`, so note content cannot smuggle markup in.
 * The hover `</>` reveals the raw table for editing; the table body itself
 * stays selectable for copying.
 */
export class TableWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly source: string,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'lp-table';
    div.innerHTML = this.html;
    appendTools(div).appendChild(makeEditButton());
    return div;
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreWidgetEvent(event);
  }
}
