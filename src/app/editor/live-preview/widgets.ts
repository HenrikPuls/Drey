import { WidgetType } from '@codemirror/view';
import {
  appendTools,
  applyImageSize,
  ignoreWidgetEvent,
  makeEditButton,
  makeLensButton,
} from './widget-chrome';

// The mermaid diagram widget lives in its own file (it pulls in the lazy
// `import('mermaid')` and its SVG serialisation helper); re-exported here so
// the module's other files keep a single widget import site.
export { MermaidWidget, svgToDataUrl } from './mermaid-widget';

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
    applyImageSize(img, this.width, this.height);
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
      tools.appendChild(makeLensButton(() => open(src)));
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
    applyImageSize(img, this.width, this.height);
    // The raw markup is already on the line above -- a broken reference
    // just drops the mirror instead of showing its own placeholder.
    img.onerror = () => img.remove();
    span.appendChild(img);
    return span;
  }
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
