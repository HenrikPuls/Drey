/**
 * The extended-Markdown rules for every markdown-it render in the app:
 * the Live Preview's table cells and HTML-region blocks
 * (`src/app/editor/live-preview/block-render.ts`) and the PDF export
 * (`shared/pdf-html.ts`). One factory, so all renders agree on the
 * dialect — GFM autolinking (`linkify`), `==highlight==`, Pandoc
 * subscript/superscript, `:emoji:` shortcodes, `$…$` / `$$…$$` math,
 * GitHub/Obsidian callouts, and footnotes (markdown-it-footnote).
 *
 * The dialect mirrors the editor's Lezer extensions
 * (`src/app/editor/markdown-extensions.ts`) — the same shapes parse in
 * both engines, and the unit suites pin the overlap.
 */
import type {
  MarkdownIt as MarkdownItInstance,
  StateBlock,
  StateCore,
  StateInline,
} from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { parseCalloutMarker } from './callouts';
import { EMOJI_NAME_AT_START, emojiFor } from './emoji';

export interface ExtendedMarkdownOptions {
  /**
   * How math renders:
   * - `'placeholder'` — `<span class="drey-math" data-display="…">latex</span>`,
   *   typeset later by a KaTeX runtime walking those spans (the PDF print
   *   page).
   * - `'source'` (default) — a styled literal span; used by the editor's
   *   table cells, where math is rare and no KaTeX copy is loaded.
   */
  math?: 'placeholder' | 'source';
  /**
   * Whether footnote rules are installed. Only the full-document renders
   * (the PDF export) want them — a table cell has no definitions, so a
   * `[^1]` there must stay literal text.
   */
  footnotes?: boolean;
}

/**
 * Re-tokenizes `from..to` of the inline source between an open/close
 * token pair — the `==mark==` / `~sub~` / `^sup^` inner content — with
 * `posMax` bounded so nesting (bold inside a highlight) parses but the
 * scan never runs past the closing delimiter.
 */
function tokenizeInner(state: StateInline, from: number, to: number): void {
  const outerMax = state.posMax;
  state.pos = from;
  state.posMax = to;
  state.md.inline.tokenize(state);
  state.pos = to;
  state.posMax = outerMax;
}

/** `==marked==` — highlight; nests like emphasis, never spans lines. */
function markRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src[start] !== '=' || state.src[start + 1] !== '=') {
    return false;
  }
  const end = state.src.indexOf('==', start + 2);
  if (end < 0 || end === start + 2 || state.src.slice(start + 2, end).includes('\n')) {
    return false;
  }
  if (!silent) {
    const open = state.push('mark_open', 'mark', 1);
    open.markup = '==';
    tokenizeInner(state, start + 2, end);
    const close = state.push('mark_close', 'mark', -1);
    close.markup = '==';
  }
  state.pos = end + 2;
  return true;
}

/** `H~2~O` / `X^2^` — pandoc sub/superscript: one unspaced run inside. */
function subSupRule(state: StateInline, silent: boolean, ch: string, tag: string): boolean {
  const start = state.pos;
  if (state.src[start] !== ch || state.src[start + 1] === ch) {
    return false; // `~~x~~` stays strikethrough's
  }
  let end = -1;
  for (let i = start + 1; i < state.posMax; i++) {
    const c = state.src[i];
    if (c === ch) {
      end = i;
      break;
    }
    if (/\s/.test(c)) {
      return false;
    }
  }
  if (end < 0) {
    return false;
  }
  if (!silent) {
    const open = state.push(`${tag}_open`, tag, 1);
    open.markup = ch;
    tokenizeInner(state, start + 1, end);
    const close = state.push(`${tag}_close`, tag, -1);
    close.markup = ch;
  }
  state.pos = end + 1;
  return true;
}

/** `:joy:` — only curated GitHub names ever match (timestamps stay text). */
function emojiRule(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== ':') {
    return false;
  }
  const match = EMOJI_NAME_AT_START.exec(state.src.slice(state.pos + 1, state.posMax));
  if (match === null) {
    return false;
  }
  const glyph = emojiFor(match[0].slice(0, -1));
  if (glyph === null) {
    return false;
  }
  if (!silent) {
    const token = state.push('emoji', '', 0);
    token.content = glyph;
    token.markup = `:${match[0]}`;
  }
  state.pos += 1 + match[0].length;
  return true;
}

/**
 * `$…$` (inline) and `$$…$$` (display; single-line inside a paragraph or
 * its own block). Opening `$` must not precede whitespace, closing `$`
 * must not follow whitespace — the currency guard ("$5 and $6" stays
 * prose because the run ends in a space).
 */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const display = state.src[start + 1] === '$';
  const contentStart = start + (display ? 2 : 1);
  if (!display && (state.src[contentStart] === undefined || /\s|\$/.test(state.src[contentStart]))) {
    return false;
  }
  let end = -1;
  for (let i = contentStart; i < state.posMax; i++) {
    const c = state.src[i];
    if (c === '$') {
      if (display && state.src[i + 1] !== '$') {
        continue; // a lone `$` inside display math
      }
      if (i > contentStart && (display || !/\s/.test(state.src[i - 1]))) {
        end = i;
      }
      break;
    }
    if (!display && c === '\n') {
      break; // inline math stays on one line
    }
  }
  if (end < 0 || end === contentStart) {
    return false;
  }
  if (!silent) {
    const token = state.push('math_inline', '', 0);
    token.content = state.src.slice(contentStart, end);
    token.markup = display ? '$$' : '$';
    token.meta = { display };
  }
  state.pos = end + (display ? 2 : 1);
  return true;
}

/** `$$`-delimited display blocks, fence-style: opener line, body, closer. */
function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const first = lineText(state, startLine).trim();
  // `$$ x = 1 $$` on one line is a complete block.
  const single = /^\$\$(.+)\$\$$/.exec(first);
  if (single === null && first !== '$$') {
    return false;
  }

  let lastLine = startLine;
  let body: string;
  if (single !== null) {
    body = single[1];
  } else {
    const lines: string[] = [];
    let closed = false;
    for (let line = startLine + 1; line < endLine; line++) {
      if (lineText(state, line).trim() === '$$') {
        closed = true;
        lastLine = line;
        break;
      }
      lines.push(lineText(state, line));
    }
    if (!closed) {
      lastLine = endLine - 1; // unterminated: math runs to the end, like a fence
    }
    body = lines.join('\n');
  }
  const latex = body.trim();
  if (latex === '') {
    return false;
  }
  if (silent) {
    return true;
  }

  const token = state.push('math_block', '', 0);
  token.content = latex;
  token.markup = '$$';
  token.map = [startLine, lastLine + 1];
  state.line = lastLine + 1;
  return true;
}

/**
 * Callouts: a blockquote whose first line opens with `[!TYPE]` renders as
 * the alert/callout box (marker + custom title consumed into the title
 * bar). Runs before the `inline` core rule, so the marker is stripped
 * from the paragraph's raw content before its children are parsed.
 */
function calloutsRule(state: StateCore): void {
  const tokens = state.tokens;
  const md = state.md;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open') {
      continue;
    }
    let depth = 0;
    let close = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') {
        depth++;
      } else if (tokens[j].type === 'blockquote_close') {
        if (depth === 0) {
          close = j;
          break;
        }
        depth--;
      }
    }
    if (close < 0) {
      continue;
    }
    // The first inline token of the quote carries the marker line.
    for (let k = i + 1; k < close; k++) {
      if (tokens[k].type !== 'inline') {
        continue;
      }
      const inline = tokens[k];
      const marker = parseCalloutMarker(inline.content);
      if (marker === null) {
        break;
      }
      // Consume the marker AND the rest of its line (a custom title);
      // body lines after it stay.
      const firstBreak = inline.content.indexOf('\n');
      inline.content = firstBreak < 0 ? '' : inline.content.slice(firstBreak + 1);

      const open = tokens[i];
      open.type = 'callout_open';
      open.tag = 'div';
      open.attrJoin('class', 'callout');
      open.attrJoin('class', `callout-${marker.kind}`);
      const closeToken = tokens[close];
      closeToken.type = 'callout_close';
      closeToken.tag = 'div';

      // `html_block` (not a bespoke type): its renderer rule emits
      // `content` verbatim — injected tokens render the same whether the
      // instance parses raw HTML or not.
      const title = new state.Token('html_block', '', 0);
      title.content =
        `<p class="callout-title"><span class="callout-icon">${marker.info.icon}</span>` +
        `${md.utils.escapeHtml(marker.title ?? marker.info.label)}</p>`;
      // An empty remainder drops its paragraph wrapper (no stray <p/>).
      if (inline.content.trim() === '') {
        tokens.splice(k - 2, 3, title); // paragraph_open, inline, paragraph_close
      } else {
        tokens.splice(k, 0, title);
      }
      break;
    }
  }
}

/** Installs the extended-Markdown rules on `md`. */
export function applyExtendedMarkdown(
  md: MarkdownItInstance,
  opts: ExtendedMarkdownOptions = {},
): void {
  md.set({ linkify: true });
  if (opts.footnotes === true) {
    md.use(footnote);
  }

  md.block.ruler.before('fence', 'drey_math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.core.ruler.before('inline', 'drey_callouts', calloutsRule);

  md.inline.ruler.push('drey_emoji', emojiRule);
  md.inline.ruler.push('drey_mark', markRule);
  md.inline.ruler.push('drey_sub', (state: StateInline, silent: boolean) =>
    subSupRule(state, silent, '~', 'sub'),
  );
  md.inline.ruler.push('drey_sup', (state: StateInline, silent: boolean) =>
    subSupRule(state, silent, '^', 'sup'),
  );
  md.inline.ruler.push('drey_math', mathInlineRule);

  const placeholder = opts.math === 'placeholder';
  const mathSpan = (latex: string, display: boolean): string => {
    const escaped = md.utils.escapeHtml(latex);
    return placeholder
      ? `<span class="drey-math" data-display="${display ? 1 : 0}">${escaped}</span>`
      : `<code class="drey-math-src">${escaped}</code>`;
  };
  md.renderer.rules['math_inline'] = (tokens, idx) =>
    mathSpan(
      tokens[idx].content,
      Boolean((tokens[idx].meta as { display?: boolean } | null)?.display),
    );
  md.renderer.rules['math_block'] = (tokens, idx) => mathSpan(tokens[idx].content, true);
  md.renderer.rules['emoji'] = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content);
}
