/**
 * The extended-Markdown inline widgets (conceal layer): the emoji glyph
 * for a `:shortcode:`, the superscript number for a `[^footnote]`
 * reference, and the icon/label title bar replacing a callout's
 * `[!TYPE]` marker. Small, stateless DOM — the interactive block widgets
 * (math) live in `math-widget.ts`.
 */
import { WidgetType } from '@codemirror/view';

/** `:joy:` → the actual emoji character. */
export class EmojiWidget extends WidgetType {
  constructor(readonly glyph: string) {
    super();
  }

  override eq(other: EmojiWidget): boolean {
    return other.glyph === this.glyph;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-emoji';
    span.textContent = this.glyph;
    return span;
  }
}

/** `[^label]` → its superscript number. */
export class FootnoteRefWidget extends WidgetType {
  constructor(readonly number: number) {
    super();
  }

  override eq(other: FootnoteRefWidget): boolean {
    return other.number === this.number;
  }

  toDOM(): HTMLElement {
    const sup = document.createElement('sup');
    sup.className = 'lp-footnote-ref';
    sup.textContent = String(this.number);
    return sup;
  }
}

/** `[^label]:` at a definition's start → `n.` */
export class FootnoteDefMarkWidget extends WidgetType {
  constructor(readonly number: number) {
    super();
  }

  override eq(other: FootnoteDefMarkWidget): boolean {
    return other.number === this.number;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-footnote-ref';
    span.textContent = `${this.number}.`;
    return span;
  }
}

/**
 * `[!TYPE]` → the callout's icon and (when the marker line carries no
 * custom title) its label; a custom title renders as the plain text that
 * already follows the marker.
 */
export class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly icon: string,
    readonly label: string | null,
  ) {
    super();
  }

  override eq(other: CalloutTitleWidget): boolean {
    return other.icon === this.icon && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lp-callout-title';
    const icon = document.createElement('span');
    icon.className = 'lp-callout-icon';
    icon.textContent = this.icon;
    span.appendChild(icon);
    if (this.label !== null) {
      const label = document.createElement('span');
      label.className = 'lp-callout-label';
      label.textContent = this.label;
      span.appendChild(label);
    }
    return span;
  }
}
