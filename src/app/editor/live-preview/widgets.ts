import { WidgetType } from '@codemirror/view';

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
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string | null,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-image';
    if (this.src === null) {
      span.appendChild(this.placeholder());
      return span;
    }
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.onerror = () => {
      img.remove();
      span.appendChild(this.placeholder());
    };
    span.appendChild(img);
    return span;
  }

  private placeholder(): HTMLElement {
    const missing = document.createElement('span');
    missing.className = 'lp-image-missing';
    missing.textContent = `image not found: ${this.alt || '(no alt text)'}`;
    return missing;
  }
}

/**
 * The hover `✎` affordance on rendered block widgets (Obsidian-style):
 * clicking it drops the cursor into the block's source. It is the ONE part
 * of such a widget whose events go to CodeMirror (see `ignoreWidgetEvent`)
 * -- everything else stays interactive widget content, so e.g. a
 * `<details>` summary toggles instead of yanking the user into the source.
 */
function appendEditButton(parent: HTMLElement): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lp-edit';
  btn.title = 'Edit source';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  parent.appendChild(btn);
}

/** `true` (= CodeMirror ignores it) for everything except the `✎` button. */
function ignoreWidgetEvent(event: Event): boolean {
  return !(event.target instanceof Element && event.target.closest('.lp-edit') !== null);
}

/**
 * A rendered HTML block (`<div>`, `<table>`, `<details>`, ...) in place of
 * raw HTML in the note -- Markdown allows embedded HTML, so Live Preview
 * renders it. `html` MUST already be sanitized (`sanitize-html.ts`).
 * The hover `✎` reveals the source; content clicks stay in the widget.
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
    appendEditButton(div);
    return div;
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreWidgetEvent(event);
  }
}

/**
 * A rendered HTML table in place of a raw GFM table block. `html` comes from
 * markdown-it with `html: false`, so note content cannot smuggle markup in.
 * The hover `✎` reveals the raw table for editing; the table body itself
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
    appendEditButton(div);
    return div;
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreWidgetEvent(event);
  }
}
