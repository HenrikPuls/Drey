/**
 * Toolbar actions and their reducers for the Markdown surface. Everything
 * here is PURE string/selection math -- no CodeMirror types, no DOM -- so
 * the whole command layer is unit-testable on its own. The surface maps an
 * action onto its `EditorView` by calling `applyAction` and dispatching the
 * returned change + selection.
 *
 * All commands are TOGGLES where it makes sense (applying "H1" to an H1
 * line turns it back into body text) and operate on every line the
 * selection touches, mirroring the block-semantics editors use.
 *
 * The extended-dialect inserts (milestone 72, ADR-0070) ride the same
 * reducer: highlight / sub / superscript / inline math are plain wraps,
 * the math block drops a `$$` fence like the code fence does, callouts
 * toggle a `> [!TYPE]` marker line onto the quoted block, and a footnote
 * plants `[^n]` plus its definition in one undo step.
 */

import type { CalloutKind } from '../../../shared/markdown/callouts';

/** A toolbar interaction, emitted by the formatting toolbar. */
export type ToolbarAction =
  | { kind: 'heading'; level: 0 | 1 | 2 | 3 }
  | { kind: 'list'; style: 'bullet' | 'ordered' | 'task' }
  | { kind: 'wrap'; marker: '**' | '*' | '~~' }
  | { kind: 'link' }
  | { kind: 'table'; rows: number; cols: number }
  | { kind: 'image'; alt: string; url: string }
  | { kind: 'quote' }
  | { kind: 'fence' }
  | { kind: 'divider' }
  | { kind: 'highlight' }
  | { kind: 'subscript' }
  | { kind: 'superscript' }
  | { kind: 'mathInline' }
  | { kind: 'mathBlock' }
  | { kind: 'callout'; variant: CalloutKind }
  | { kind: 'footnote' };

/** A single change plus the selection to land in afterwards. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  selFrom: number;
  selTo: number;
}

const HEADING_RE = /^(\s*)(#{1,6}) /;
const TASK_RE = /^(\s*)(?:[-*+]|\d+\.) \[[ xX]\] /;
const LIST_RE = /^(\s*)(?:[-*+]|\d+\.) /;

/** Splits a line into indent + body, dropping any heading/list prefix. */
function stripLine(text: string): { indent: string; body: string; prefix: string } {
  const m = HEADING_RE.exec(text) ?? TASK_RE.exec(text) ?? LIST_RE.exec(text);
  if (m) {
    return { indent: m[1], body: text.slice(m[0].length), prefix: m[0].slice(m[1].length) };
  }
  const indent = /^[ \t]*/.exec(text)![0];
  return { indent, body: text.slice(indent.length), prefix: '' };
}

function listPrefix(style: 'bullet' | 'ordered' | 'task', index: number): string {
  switch (style) {
    case 'bullet':
      return '- ';
    case 'ordered':
      return `${index}. `;
    case 'task':
      return '- [ ] ';
  }
}

interface MappedLine {
  start: number;
  end: number; // exclusive, without the trailing newline
  text: string;
  replacement: string;
  indentLen: number;
  oldPrefixLen: number;
  newPrefixLen: number;
}

/**
 * Applies `rewrite` to every line touched by [from, to) and maps the
 * selection through the per-line prefix changes: a caret that sat inside
 * an old prefix lands after the new one, everything past the prefix keeps
 * its offset into the body.
 */
function rewriteLines(
  text: string,
  from: number,
  to: number,
  rewrite: (line: { indent: string; body: string; prefix: string }, index: number) => string,
): Edit {
  const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lines: MappedLine[] = [];
  let pos = start;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const lineText = text.slice(pos, end);
    const s = stripLine(lineText);
    const replacement = s.indent + rewrite(s, lines.length);
    lines.push({
      start: pos,
      end,
      text: lineText,
      replacement,
      indentLen: s.indent.length,
      oldPrefixLen: s.prefix.length,
      newPrefixLen: replacement.length - s.indent.length - s.body.length,
    });
    if (end >= to || end >= text.length) {
      break;
    }
    pos = end + 1;
  }
  const insert = lines.map((l) => l.replacement).join('\n');
  return {
    from: lines[0].start,
    to: lines[lines.length - 1].end,
    insert,
    selFrom: mapPos(lines, from),
    selTo: mapPos(lines, to),
  };
}

/** Maps a doc position through the rewritten lines (see `rewriteLines`). */
function mapPos(lines: MappedLine[], pos: number): number {
  const newStarts: number[] = [];
  let at = lines[0].start;
  for (const l of lines) {
    newStarts.push(at);
    at += l.replacement.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (pos <= l.end && (i === lines.length - 1 || pos < lines[i + 1].start)) {
      const offset = pos - l.start;
      const intoBody = offset <= l.oldPrefixLen ? 0 : offset - l.oldPrefixLen;
      return newStarts[i] + l.indentLen + l.newPrefixLen + intoBody;
    }
  }
  return newStarts[lines.length - 1] + lines[lines.length - 1].replacement.length;
}

function setHeading(text: string, from: number, to: number, level: 0 | 1 | 2 | 3): Edit {
  const prefix = level > 0 ? '#'.repeat(level) + ' ' : '';
  return rewriteLines(text, from, to, (s, _i) =>
    s.prefix === prefix && s.body !== '' ? s.body : prefix + s.body,
  );
}

function toggleList(
  text: string,
  from: number,
  to: number,
  style: 'bullet' | 'ordered' | 'task',
): Edit {
  const first = stripLine(
    text.slice(text.lastIndexOf('\n', Math.max(0, from - 1)) + 1, lineEnd(text, from)),
  );
  const already = style !== 'ordered' && first.prefix === listPrefix(style, 1) && first.body !== '';
  return rewriteLines(text, from, to, (s, i) =>
    already ? s.body : listPrefix(style, i + 1) + s.body,
  );
}

function lineEnd(text: string, pos: number): number {
  const idx = text.indexOf('\n', pos);
  return idx === -1 ? text.length : idx;
}

/**
 * Toggles a `> ` blockquote prefix on every touched line. Works on RAW
 * lines, unlike the heading/list rewrites: a quote wraps whatever else the
 * line carries (a heading keeps its `#`, a list its `-`), and quoting an
 * already-quoted line deepens it by one level.
 */
function toggleQuote(text: string, from: number, to: number): Edit {
  const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const quoting = !/^\s*> /.test(text.slice(start, lineEnd(text, from)));
  const lines: MappedLine[] = [];
  let pos = start;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(pos, end);
    const indent = /^[ \t]*/.exec(raw)![0];
    const rest = raw.slice(indent.length);
    const hadQuote = rest.startsWith('> ');
    const replacement =
      indent + (quoting ? `> ${rest}` : hadQuote ? rest.slice(2) : rest);
    lines.push({
      start: pos,
      end,
      text: raw,
      replacement,
      indentLen: indent.length,
      oldPrefixLen: indent.length + (hadQuote ? 2 : 0),
      newPrefixLen: indent.length + (quoting ? 2 : hadQuote ? 0 : 0),
    });
    if (end >= to || end >= text.length) {
      break;
    }
    pos = end + 1;
  }
  const insert = lines.map((l) => l.replacement).join('\n');
  return {
    from: lines[0].start,
    to: lines[lines.length - 1].end,
    insert,
    selFrom: mapPos(lines, from),
    selTo: mapPos(lines, to),
  };
}

function wrapInline(text: string, from: number, to: number, marker: string): Edit {
  const m = marker.length;
  if (from !== to) {
    const slice = text.slice(from, to);
    if (slice.length >= 2 * m && slice.startsWith(marker) && slice.endsWith(marker)) {
      const inner = slice.slice(m, -m);
      return { from, to, insert: inner, selFrom: from, selTo: from + inner.length };
    }
    return {
      from,
      to,
      insert: `${marker}${slice}${marker}`,
      selFrom: from,
      selTo: to + 2 * m,
    };
  }
  // Empty selection: drop a pair and park the caret between the markers.
  return { from, to, insert: `${marker}${marker}`, selFrom: from + m, selTo: from + m };
}

const URL_PLACEHOLDER = 'https://';

function makeLink(text: string, from: number, to: number): Edit {
  const label = from === to ? '' : text.slice(from, to);
  const insert = `[${label}](${URL_PLACEHOLDER})`;
  const urlAt = from + 1 + label.length + 2;
  return { from, to, insert, selFrom: urlAt, selTo: urlAt + URL_PLACEHOLDER.length };
}

function insertTable(text: string, from: number, to: number, rows: number, cols: number): Edit {
  const row = (fill: (c: number) => string) =>
    `| ${Array.from({ length: cols }, (_, c) => fill(c)).join(' | ')} |`;
  const header = row((c) => `Header ${c + 1}`);
  const sep = row(() => '---');
  const body = Array.from({ length: Math.max(1, rows - 1) }, () => row(() => ' '));
  const table = [header, sep, ...body].join('\n');
  // Place the table as its own block after the caret's line; the caret
  // lands on the first header cell, ready to type over it.
  const end = lineEnd(text, from);
  const at = Math.min(text.length, end + (end < text.length ? 1 : 0));
  const lead = end < text.length ? '' : '\n';
  const insert = `${lead}${table}\n`;
  const cellStart = at + lead.length + 2;
  return { from: at, to: at, insert, selFrom: cellStart, selTo: cellStart + 'Header 1'.length };
}

/**
 * Turns a file name into image alt text: the extension goes, and the
 * characters that would end the alt early (`]`), open a nested one (`[`) or
 * be read as a size suffix (`|`, see `parseImageEmbed`) are replaced.
 */
export function imageAltFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return (
    base
      .replace(/[[\]|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'image'
  );
}

function insertImage(text: string, from: number, alt: string, url: string): Edit {
  // Like a table, the image becomes its own block after the caret's line;
  // the caret lands at the end of the inserted line.
  const end = lineEnd(text, from);
  const at = Math.min(text.length, end + (end < text.length ? 1 : 0));
  const lead = end < text.length ? '' : '\n';
  const line = `![${alt}](${url})`;
  const insert = `${lead}${line}\n`;
  const caret = at + lead.length + line.length;
  return { from: at, to: at, insert, selFrom: caret, selTo: caret };
}

/**
 * Places an empty fenced code block after the caret's line; the caret sits
 * on the blank line between the fences, ready for the code.
 */
function insertFence(text: string, from: number): Edit {
  const end = lineEnd(text, from);
  const at = Math.min(text.length, end + (end < text.length ? 1 : 0));
  const lead = end < text.length ? '' : '\n';
  const insert = `${lead}\`\`\`\n\n\`\`\`\n`;
  const caret = at + lead.length + 4;
  return { from: at, to: at, insert, selFrom: caret, selTo: caret };
}

/**
 * Places a `---` divider as its own block. Unlike the other block inserts
 * it needs a BLANK line before it when the caret's line is not empty --
 * `---` directly under a paragraph is a Setext heading, not a rule.
 */
function insertDivider(text: string, from: number): Edit {
  const lineStart = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineEndPos = lineEnd(text, from);
  const line = text.slice(lineStart, lineEndPos);
  if (/^\s*$/.test(line)) {
    // Replace the empty line (and its newline) with the divider.
    const caret = lineStart + 4;
    return {
      from: lineStart,
      to: lineEndPos + (lineEndPos < text.length ? 1 : 0),
      insert: `---\n`,
      selFrom: caret,
      selTo: caret,
    };
  }
  const hasNl = lineEndPos < text.length;
  const at = lineEndPos + (hasNl ? 1 : 0); // past the newline / at doc end
  const lead = hasNl ? '' : '\n'; // a doc end needs its own line break
  const insert = `${lead}\n---\n`; // blank separator + rule
  const caret = at + lead.length + 5;
  return { from: at, to: at, insert, selFrom: caret, selTo: caret };
}

/**
 * Places an empty `$$` display-math block after the caret's line (the
 * twin of `insertFence`, ADR-0070); the caret sits on the blank line
 * between the delimiters, ready for the formula.
 */
function insertMathBlock(text: string, from: number): Edit {
  const end = lineEnd(text, from);
  const at = Math.min(text.length, end + (end < text.length ? 1 : 0));
  const lead = end < text.length ? '' : '\n';
  const insert = `${lead}$$\n\n$$\n`;
  const caret = at + lead.length + 3;
  return { from: at, to: at, insert, selFrom: caret, selTo: caret };
}

/** A callout marker (`[!NOTE]` + optional Obsidian fold suffix). */
const CALLOUT_MARKER = /^\[!(\w+)\][+-]?/;

/** The `[!KEYWORD]` this canonical kind emits (the five GitHub keywords). */
function calloutKeyword(variant: CalloutKind): string {
  return variant.toUpperCase();
}

/**
 * Toggles a `> [!TYPE]` marker line onto the quote block the selection
 * touches (ADR-0070):
 *
 * - plain lines -> every touched line gets its `> ` prefix and the marker
 *   line lands above the block;
 * - a plain blockquote -> only the marker line is added on top;
 * - a callout of the SAME kind -> the marker line goes away again;
 * - a callout of another kind -> just the keyword is swapped.
 */
function toggleCallout(text: string, from: number, to: number, variant: CalloutKind): Edit {
  const keyword = calloutKeyword(variant);
  const firstStart = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const isQuote = (start: number): boolean =>
    /^[ \t]*>/.test(text.slice(start, lineEnd(text, start)));

  if (isQuote(firstStart)) {
    // Expand upward to the whole contiguous quote block.
    let blockStart = firstStart;
    while (blockStart > 0) {
      const prevStart = text.lastIndexOf('\n', blockStart - 2) + 1;
      if (!isQuote(prevStart)) {
        break;
      }
      blockStart = prevStart;
    }
    const firstLine = text.slice(blockStart, lineEnd(text, blockStart));
    const stripped = firstLine.replace(/^[ \t]*>\s?/, '');
    const marker = CALLOUT_MARKER.exec(stripped);
    if (marker !== null) {
      const kwStart = blockStart + firstLine.indexOf('[!');
      if (marker[1] === keyword) {
        // Toggle OFF: drop the whole marker line, the quote body stays.
        const eol = lineEnd(text, blockStart);
        const removeTo = eol < text.length ? eol + 1 : eol;
        const delta = blockStart - removeTo; // negative
        const shift = (pos: number): number => (pos <= blockStart ? pos : pos + delta);
        return { from: blockStart, to: removeTo, insert: '', selFrom: shift(from), selTo: shift(to) };
      }
      // Switch the variant: replace just the keyword token, keeping any
      // Obsidian fold suffix the marker carried.
      const nextKw = `[!${keyword}]`;
      const kwLen = `[!${marker[1]}]`.length;
      const delta = nextKw.length - kwLen;
      const shift = (pos: number): number => (pos <= kwStart + kwLen ? pos : pos + delta);
      return {
        from: kwStart,
        to: kwStart + kwLen,
        insert: nextKw,
        selFrom: shift(from),
        selTo: shift(to),
      };
    }
    // Plain quote block: the marker line goes on top.
    const line = `> [!${keyword}]\n`;
    const shift = (pos: number): number => (pos < blockStart ? pos : pos + line.length);
    return { from: blockStart, to: blockStart, insert: line, selFrom: shift(from), selTo: shift(to) };
  }

  // Unquoted lines: quote every touched line, marker line above the block.
  const start = firstStart;
  const lines: MappedLine[] = [];
  let pos = start;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(pos, end);
    const indent = /^[ \t]*/.exec(raw)![0];
    const rest = raw.slice(indent.length);
    const already = rest.startsWith('>');
    const quotedPrefix = already ? (rest.startsWith('> ') ? 2 : 1) : 2;
    const replacement = already ? raw : `${indent}> ${rest}`;
    lines.push({
      start: pos,
      end,
      text: raw,
      replacement,
      indentLen: indent.length,
      oldPrefixLen: indent.length + (already ? quotedPrefix : 0),
      newPrefixLen: indent.length + quotedPrefix,
    });
    if (end >= to || end >= text.length) {
      break;
    }
    pos = end + 1;
  }
  const markerLine = `> [!${keyword}]\n`;
  const insert = markerLine + lines.map((l) => l.replacement).join('\n');
  // mapPos maps through the per-line prefixes; the marker line sits before
  // every mapped position, so it shifts the whole selection.
  return {
    from: lines[0].start,
    to: lines[lines.length - 1].end,
    insert,
    selFrom: mapPos(lines, from) + markerLine.length,
    selTo: mapPos(lines, to) + markerLine.length,
  };
}

/** The placeholder word a new footnote definition selects for over-typing. */
const FOOTNOTE_PLACEHOLDER = 'Footnote';

/**
 * Numbers the next footnote definition in document order: one higher than
 * the highest `[^n]:` already present (`1` when there is none). Non-numeric
 * labels (`[^prologue]`) never collide with the generated numbers.
 */
export function nextFootnoteNumber(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/(?:^|\n)\[\^(\d+)\]:/g)) {
    max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Plants `[^n]` right after the selection (the selected text stays -- it
 * becomes the annotated word) and appends the `[^n]: Footnote` definition
 * as its own block at the document end, ONE undo step. A selection that
 * ends just past a line break (what a triple-click line selection is)
 * backs up onto the paragraph: the ref belongs after its last character,
 * not alone on the next line. Two spans, so the edit comes back as a
 * full-document replace -- the same shape the slash commands land -- with
 * the placeholder selected for over-typing.
 */
function insertFootnote(text: string, from: number, to: number): Edit {
  const at = from < to && text[to - 1] === '\n' ? to - 1 : to;
  const n = nextFootnoteNumber(text);
  const ref = `[^${n}]`;
  const withRef = text.slice(0, at) + ref + text.slice(at);
  const body = withRef.replace(/\n+$/, '');
  const label = `[^${n}]: `;
  const withDef = `${body}\n\n${label}${FOOTNOTE_PLACEHOLDER}`;
  const selFrom = body.length + 2 + label.length; // past "\n\n" + the label
  return {
    from: 0,
    to: text.length,
    insert: withDef,
    selFrom,
    selTo: selFrom + FOOTNOTE_PLACEHOLDER.length,
  };
}

/** Reduces a toolbar action to one change + selection, pure and testable. */
export function applyAction(text: string, from: number, to: number, action: ToolbarAction): Edit {
  switch (action.kind) {
    case 'heading':
      return setHeading(text, from, to, action.level);
    case 'list':
      return toggleList(text, from, to, action.style);
    case 'wrap':
      return wrapInline(text, from, to, action.marker);
    case 'link':
      return makeLink(text, from, to);
    case 'table':
      return insertTable(text, from, to, action.rows, action.cols);
    case 'image':
      return insertImage(text, from, action.alt, action.url);
    case 'quote':
      return toggleQuote(text, from, to);
    case 'fence':
      return insertFence(text, from);
    case 'divider':
      return insertDivider(text, from);
    case 'highlight':
      return wrapInline(text, from, to, '==');
    case 'subscript':
      return wrapInline(text, from, to, '~');
    case 'superscript':
      return wrapInline(text, from, to, '^');
    case 'mathInline':
      return wrapInline(text, from, to, '$');
    case 'mathBlock':
      return insertMathBlock(text, from);
    case 'callout':
      return toggleCallout(text, from, to, action.variant);
    case 'footnote':
      return insertFootnote(text, from, to);
  }
}
