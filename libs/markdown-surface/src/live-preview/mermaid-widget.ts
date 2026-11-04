import { WidgetType } from '@codemirror/view';
import type { MermaidConfig } from 'mermaid';
import { appendTools, ignoreWidgetEvent, makeEditButton, makeLensButton } from './widget-chrome';

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
      wrap
        .querySelector('.lp-tools')
        ?.appendChild(makeLensButton(() => zoom(svgToDataUrl(svg)), 'lp-mermaid-lens'));
    }
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreWidgetEvent(event);
  }
}
