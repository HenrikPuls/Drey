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
 */

/** A toolbar interaction, emitted by the formatting toolbar. */
export type ToolbarAction =
  | { kind: 'heading'; level: 0 | 1 | 2 | 3 }
  | { kind: 'list'; style: 'bullet' | 'ordered' | 'task' }
  | { kind: 'wrap'; marker: '**' | '*' | '~~' }
  | { kind: 'link' }
  | { kind: 'table'; rows: number; cols: number }
  | { kind: 'image'; alt: string; url: string };

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

function wrapInline(text: string, from: number, to: number, marker: '**' | '*' | '~~'): Edit {
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
  }
}
