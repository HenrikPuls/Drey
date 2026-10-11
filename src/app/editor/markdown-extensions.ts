/**
 * The editor's extended-Markdown grammar (the Lezer half of the dialect):
 * `==highlight==`, `$…$` / `$$…$$` math, `[^footnote]` references and
 * definitions, and the curated `:emoji:` shortcodes. Subscript and
 * superscript need nothing here — `markdownLanguage` already carries
 * @lezer/markdown's `Subscript`/`Superscript` parsers; the conceal layer
 * renders them.
 *
 * The same shapes parse in markdown-it (`shared/markdown/
 * markdown-it-extended.ts`) for table cells, HTML regions and the PDF
 * export — the suites pin the overlap. Block constructs without grammar
 * pressure (callout boxes are blockquotes; `$$` display blocks could not
 * share the fence machinery) are scanned textually by the render layers
 * instead.
 *
 * The built-in `Emoji` inline parser is removed at the surface
 * (any `name:` matched — timestamps like `00:03:48` lit up as `:03:`);
 * `CuratedEmoji` below re-adds the node with a known-names lookup
 * (`shared/markdown/emoji.ts`), so only real shortcodes ever match.
 */
import { tags as t } from '@lezer/highlight';
import type { BlockContext, InlineContext, LeafBlock, Line, MarkdownConfig } from '@lezer/markdown';
import { emojiFor } from '../../../shared/markdown/emoji';

/** `==marked==` — obsidian highlight, one line, nests inline content. */
function parseHighlight(cx: InlineContext, next: number, pos: number): number {
  if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61) {
    return -1;
  }
  const elts = [cx.elt('HighlightMark', pos, pos + 2)];
  for (let i = pos + 2; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === 61 && cx.char(i + 1) === 61) {
      if (i === pos + 2) {
        return -1; // `====` — empty content
      }
      return cx.addElement(
        cx.elt('Highlight', pos, i + 2, elts.concat(cx.elt('HighlightMark', i, i + 2))),
      );
    }
    if (c === 92 /* '\\' */) {
      elts.push(cx.elt('Escape', i, i + 2));
      i++;
      continue;
    }
    if (c === 10 /* '\n' */) {
      return -1; // inline highlight stays on one line
    }
  }
  return -1;
}

/**
 * `$x^2$` (inline) and `$$E=mc^2$$` (display, same line). Multi-line `$$`
 * display math is the `MathBlock` leaf below. Opening `$` never precedes
 * whitespace, closing `$` never follows it — "costs $5 and $6" stays
 * prose because the run ends in a space.
 */
function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== 36 /* '$' */) {
    return -1;
  }
  const display = cx.char(pos + 1) === 36;
  const start = pos + (display ? 2 : 1);
  const first = cx.char(start);
  if (start >= cx.end || first === 10 || (!display && (first === 32 || first === 36))) {
    return -1;
  }
  for (let i = start; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === 36) {
      if (display && cx.char(i + 1) !== 36) {
        continue; // lone `$` inside display math
      }
      if (i === start || (!display && cx.char(i - 1) === 32)) {
        return -1; // empty, or a single-`$` closer after a space
      }
      return cx.addElement(cx.elt('InlineMath', pos, i + (display ? 2 : 1)));
    }
    if (c === 10 /* '\n' */) {
      return -1; // both inline shapes stay on one line
    }
  }
  return -1;
}

/** A `[^label]` reference (the label: no `]`, non-empty, no newline). */
function parseFootnoteRef(cx: InlineContext, next: number, pos: number): number {
  if (next !== 91 /* '[' */ || cx.char(pos + 1) !== 94 /* '^' */) {
    return -1;
  }
  const match = /^[^\]\n]+\]/.exec(cx.slice(pos + 2, cx.end));
  if (match === null) {
    return -1;
  }
  return cx.addElement(cx.elt('FootnoteRef', pos, pos + 2 + match[0].length));
}

/** `:name:` — only curated GitHub names ever match. */
function parseCuratedEmoji(cx: InlineContext, next: number, pos: number): number {
  if (next !== 58 /* ':' */) {
    return -1;
  }
  const match = /^[a-zA-Z0-9_+-]+:/.exec(cx.slice(pos + 1, cx.end));
  if (match === null || emojiFor(match[0].slice(0, -1)) === null) {
    return -1;
  }
  return cx.addElement(cx.elt('Emoji', pos, pos + 1 + match[0].length));
}

/**
 * One `$$`-delimited display block, fence-style: opener line, body
 * lines, closer line (or the compact `$$ x $$` form). The closer is
 * ABSORBED (its line never re-parses); the first line after it — or the
 * paragraph's natural end — emits the element. Unterminated blocks run
 * to the paragraph's end.
 */
class MathBlockParser {
  /** End of the closing `$$` line; null while the body is still open. */
  private end: number | null = null;
  private emitted = false;

  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (this.end !== null) {
      // A line survived the closer: emit and let it start a new block.
      this.emit(cx, leaf);
      return true;
    }
    if (line.text.slice(line.pos).trim() === '$$') {
      this.end = cx.lineStart + line.text.length;
    }
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    this.emit(cx, leaf);
    return true;
  }

  private emit(cx: BlockContext, leaf: LeafBlock): void {
    if (this.emitted) {
      return;
    }
    this.emitted = true;
    cx.addLeafElement(
      leaf,
      cx.elt('MathBlock', leaf.start, this.end ?? leaf.start + leaf.content.length),
    );
  }
}

/** A `$$`-only line (the opener/closer of a math display block). */
function isOpenMathLine(line: Line): boolean {
  return line.text.slice(line.pos).trim() === '$$';
}

/** A complete one-line display block: `$$ x = 1 $$`. */
const MATH_BLOCK_SINGLE = /^\$\$.+\$\$$/;

/** `[^label]: text` — a footnote definition; continuation lines join the
 * paragraph the way plain paragraphs absorb them. */
class FootnoteDefParser {
  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(leaf, cx.elt('FootnoteDef', leaf.start, leaf.start + leaf.content.length));
    return true;
  }
}

const FOOTNOTE_DEF = /^\[\^[^\]\n]+\]:/;

/**
 * The one extension list the Markdown surface adds to
 * `markdownLanguage` (alongside `remove: ['Emoji']`).
 */
export const extendedMarkdown: MarkdownConfig[] = [
  {
    defineNodes: [
      { name: 'Highlight', style: t.special(t.strong) },
      { name: 'HighlightMark', style: t.processingInstruction },
    ],
    parseInline: [{ name: 'DreyHighlight', parse: parseHighlight }],
  },
  {
    // `Emoji` is already defined by the base grammar (the removed
    // parser's node spec stays); only the parser is new.
    parseInline: [{ name: 'DreyEmoji', parse: parseCuratedEmoji }],
  },
  {
    defineNodes: [
      { name: 'InlineMath', style: t.special(t.monospace) },
      { name: 'MathBlock', block: true, style: t.special(t.monospace) },
    ],
    parseInline: [{ name: 'DreyMath', parse: parseInlineMath }],
    parseBlock: [
      {
        name: 'DreyMathBlock',
        // A `$$` line interrupts a paragraph the way a fence does — but
        // never interrupts an active math block (its own closer is a
        // `$$` line too; absorbing it is the parser's job).
        endLeaf: (_, line, leaf) =>
          leaf.parsers.some((p) => p instanceof MathBlockParser)
            ? false
            : MATH_BLOCK_SINGLE.test(line.text.slice(line.pos).trim()) || isOpenMathLine(line),
        leaf(_, leaf) {
          return MATH_BLOCK_SINGLE.test(leaf.content.trim()) || leaf.content.trim() === '$$'
            ? new MathBlockParser()
            : null;
        },
      },
    ],
  },
  {
    defineNodes: [
      { name: 'FootnoteRef', style: t.link },
      { name: 'FootnoteDef', block: true, style: t.content },
    ],
    // Before the built-in Link parser — otherwise `[` starts a link
    // delimiter and `[^1]` parses as a (shortcut) Link node.
    parseInline: [{ name: 'DreyFootnoteRef', parse: parseFootnoteRef, before: 'Link' }],
    parseBlock: [
      {
        name: 'DreyFootnoteDef',
        // Before LinkReference: `[^x]: …` must never read as a reference.
        before: 'LinkReference',
        leaf(_, leaf) {
          return FOOTNOTE_DEF.test(leaf.content) ? new FootnoteDefParser() : null;
        },
      },
    ],
  },
];

/**
 * Footnote numbers by label: definitions number in document order
 * (fence-aware — a `[^x]:` inside a code fence is code). The conceal and
 * reveal layers both call this on the whole document text; it is a cheap
 * line scan, the same whole-document pass `block-render.ts` already pays.
 */
export function footnoteNumbers(text: string): Map<string, number> {
  const numbers = new Map<string, number>();
  let inFence = false;
  let fenceMarker = '';
  for (const line of text.split('\n')) {
    const fence = line.trim().match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      continue;
    }
    const def = /^\s{0,3}\[\^([^\]\n]+)\]:/.exec(line);
    if (def !== null && !numbers.has(def[1])) {
      numbers.set(def[1], numbers.size + 1);
    }
  }
  return numbers;
}
