/**
 * Sanitizer for raw HTML blocks in a note before they are rendered as a
 * Live Preview widget (ADR-0009). Markdown deliberately allows inline HTML;
 * a vault file is normally the user's own content, but it can also arrive
 * from elsewhere (OneDrive share, imported notes), and the renderer talks
 * to a privileged IPC bridge -- so scripts and event handlers must never
 * execute. Allowlist-based: unknown tags are unwrapped (children survive as
 * text/inline content), dangerous URLs are stripped, `on*` attributes die.
 */

/** Presentational/structural tags that may appear in a note. */
const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

/** Attributes kept (per element, after URL checks). Everything else is dropped. */
const ALLOWED_ATTRS = new Set([
  'align',
  'alt',
  'border',
  'cellpadding',
  'cellspacing',
  'class',
  'colspan',
  'dir',
  'height',
  'href',
  'lang',
  'open',
  'rowspan',
  'src',
  'start',
  'style',
  'title',
  'type',
  'valign',
  'width',
]);

/**
 * `style` may only carry simple presentational properties -- no parentheses
 * in values, which blocks `url(...)` (and every other CSS function; hex and
 * named colors are enough for a note).
 */
const SAFE_STYLE = /^[-a-z]+\s*:\s*[^;{}<>()]*(;\s*[-a-z]+\s*:\s*[^;{}<>()]*)*;?$/i;

const SAFE_HREF = /^(https?:|mailto:|#)/i;

/** Elements that never take a closing tag. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const TAG_SCAN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*?)?(\/?)>/g;

/**
 * Net count of opened-minus-closed HTML tags in `source` (void and
 * self-closing tags ignored, comments stripped). Positive means the
 * fragment leaves tags open -- used by the block-render layer to merge a
 * `<details>` HTML block with the Markdown and closing block that follow
 * it (CommonMark ends an HTML block at the first blank line, so one
 * logical element frequently spans several `HTMLBlock` nodes).
 */
export function htmlTagBalance(source: string): number {
  const text = source.replace(/<!--[\s\S]*?-->/g, '');
  let balance = 0;
  for (const match of text.matchAll(TAG_SCAN)) {
    const [, closing, rawTag, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (VOID_TAGS.has(tag) || (selfClosing && !closing)) {
      continue;
    }
    balance += closing ? -1 : 1;
  }
  return balance;
}

export interface SanitizeOptions {
  /** Maps an `<img src>` the way note images are mapped (`resolveVaultImageUrl`). */
  resolveImage: (url: string) => string | null;
}

export function sanitizeHtml(source: string, options: SanitizeOptions): string {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  sanitizeChildren(doc.body, options);
  return doc.body.innerHTML;
}

function sanitizeChildren(parent: Element, options: SanitizeOptions): void {
  for (const child of Array.from(parent.children)) {
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap rather than drop: a `<font>`/`<custom-x>` wrapper's content
      // should survive. Scripts/styles carry only text -> remove whole.
      // Sanitize the subtree BEFORE unwrapping, or the children would be
      // hoisted past this loop's snapshot unchecked.
      if (tag === 'script' || tag === 'style' || tag === 'title') {
        child.remove();
      } else {
        sanitizeChildren(child, options);
        child.replaceWith(...Array.from(child.childNodes));
      }
      continue;
    }
    sanitizeAttributes(child, tag, options);
    sanitizeChildren(child, options);
  }
}

function sanitizeAttributes(el: Element, tag: string, options: SanitizeOptions): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'style' && !SAFE_STYLE.test(attr.value.trim())) {
      el.removeAttribute(attr.name);
    } else if (name === 'href' && !SAFE_HREF.test(attr.value.trim())) {
      el.removeAttribute(attr.name);
    } else if (name === 'src') {
      const resolved = tag === 'img' ? options.resolveImage(attr.value) : null;
      if (resolved === null) {
        el.removeAttribute(attr.name);
      } else {
        el.setAttribute('src', resolved);
      }
    }
  }
}
