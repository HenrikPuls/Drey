import MarkdownIt from 'markdown-it';

/** Instance type of the markdown-it default export (a class in v15's own typings). */
type Md = InstanceType<typeof MarkdownIt>;

/**
 * Source-position mapping for the auto-switch editor mode (ADR-0004).
 *
 * The rendered view is not a live editor, so to move the caret between the
 * preview and CodeMirror we need to know, for a click in the rendered HTML,
 * which Markdown source offset it corresponds to -- and back again after a
 * save. Two ingredients:
 *
 *  1. `renderWithSourceMap` stamps every rendered block element with a
 *     `cm-src-<n>` marker class and hands back a parallel `spans[]` array of
 *     `{ start, end }` source offsets (from markdown-it's block `token.map`,
 *     which is line-granular but reliable). A class, not a `data-` attribute:
 *     Angular's `[innerHTML]` sanitizer drops unknown attributes but keeps
 *     `class`.
 *  2. `alignRenderedToSource` narrows that to a single character: within one
 *     block it walks the block's rendered plain text against its slice of
 *     source. Every visible character also appears, in order, in the source
 *     -- emphasis / heading / list / link syntax is just *extra* source
 *     characters between them -- so for each rendered char we scan the
 *     source forward to its next occurrence. The result is non-decreasing,
 *     so the inverse (`sourceToRenderedOffset`) is a binary search.
 *
 * Exact for plain prose, headings and fenced code (identity). Degrades to a
 * few characters off only inside pathological nested inline markup, or when
 * a source entity (`&lt;`) renders as a character it does not literally
 * contain. That is an acceptable trade for not pulling in a full
 * position-tracking Markdown parser (see ADR-0004, "Consequences").
 */

type Token = ReturnType<Md['parse']>[number];

/** Marker class put on the nth rendered block; `blockClass(n)` <-> `spans[n]`. */
export function blockClass(index: number): string {
  return `cm-src-${index}`;
}

const BLOCK_CLASS_RE = /(?:^|\s)cm-src-(\d+)(?:\s|$)/;

/** Parses the `cm-src-<n>` index off an element's class list, or `null`. */
export function blockIndexOfClassName(className: string): number | null {
  const match = BLOCK_CLASS_RE.exec(className);
  return match ? Number(match[1]) : null;
}

/** Source offsets (in the frontmatter-stripped text) of one rendered block. */
export interface BlockSpan {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset, trailing newlines trimmed. */
  end: number;
}

export interface RenderedDoc {
  html: string;
  /** Indexed by the integer in a rendered element's `cm-src-<n>` class. */
  spans: BlockSpan[];
}

/** Byte-... rather, char-offset of the first character of every line. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Renders `strippedSource` (frontmatter already removed) to HTML, tagging
 * each block-level element with a `cm-src-<index>` class and returning the
 * matching source spans. Nested blocks are all tagged; a caret lookup takes
 * the *innermost* tagged ancestor, which is the tightest span.
 */
export function renderWithSourceMap(md: Md, strippedSource: string): RenderedDoc {
  const tokens = md.parse(strippedSource, {});
  const lineStarts = lineStartOffsets(strippedSource);
  const spans: BlockSpan[] = [];

  for (const token of tokens as Token[]) {
    // Stamp the tokens that render as an element: block openers (`nesting 1`)
    // plus self-contained leaf blocks (`fence`, `hr`). Skip closers
    // (`nesting -1`) and the `inline` token, which carries a `map` but only
    // renders its children -- letting it through wastes an index and the
    // class never reaches the DOM.
    if (!token.map || !token.block || token.nesting === -1 || token.type === 'inline') {
      continue;
    }
    const [startLine, endLine] = token.map;
    const start = lineStarts[startLine] ?? strippedSource.length;
    let end = lineStarts[endLine] ?? strippedSource.length;
    while (end > start && strippedSource[end - 1] === '\n') {
      end--;
    }

    // attrJoin, not attrSet: a fenced block already carries `language-*`.
    token.attrJoin('class', blockClass(spans.length));
    spans.push({ start, end });
  }

  return { html: md.renderer.render(tokens, md.options, {}), spans };
}

/**
 * `r2s[k]` is the source index (relative to `sourceSlice`) that rendered
 * offset `k` maps to. Length is `rendered.length + 1`; non-decreasing.
 */
export function alignRenderedToSource(sourceSlice: string, rendered: string): number[] {
  const r2s = new Array<number>(rendered.length + 1);
  let s = 0;
  for (let r = 0; r < rendered.length; r++) {
    const ch = rendered[r];
    while (s < sourceSlice.length && sourceSlice[s] !== ch) {
      s++;
    }
    r2s[r] = s;
    if (s < sourceSlice.length) {
      s++;
    }
  }
  r2s[rendered.length] = s;
  return r2s;
}

/** Inverse of `alignRenderedToSource`: smallest rendered offset at/after `sourceOffset`. */
export function sourceToRenderedOffset(r2s: number[], sourceOffset: number): number {
  let lo = 0;
  let hi = r2s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r2s[mid] < sourceOffset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Picks the block whose span best contains `strippedOffset`: the tightest
 * (smallest) span that covers it, or -- for an offset that falls in the
 * blank line between blocks -- the last block that starts at or before it.
 * Returns the block index, or `null` when there are no spans.
 */
export function blockIndexForSourceOffset(
  spans: BlockSpan[],
  strippedOffset: number,
): number | null {
  let containing = -1;
  let containingWidth = Infinity;
  let lastBefore = -1;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span.start <= strippedOffset) {
      lastBefore = i;
    }
    if (span.start <= strippedOffset && strippedOffset <= span.end) {
      const width = span.end - span.start;
      if (width < containingWidth) {
        containing = i;
        containingWidth = width;
      }
    }
  }
  if (containing !== -1) {
    return containing;
  }
  if (lastBefore !== -1) {
    return lastBefore;
  }
  return spans.length > 0 ? 0 : null;
}
