/**
 * A worker reply as DOM (req-58): the small Markdown subset worker
 * replies use — paragraphs, headings, `-`/`1.` lists, quotes, rules, tables,
 * fenced code (coloured by the host's `ui.highlightCode`) and inline
 * `code` / **bold** / *italic*. Built as nodes, never `innerHTML`:
 * worker output is untrusted text. The shape follows the assistant's
 * rich-text renderer; a plugin cannot import another plugin's folder.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>[ \t]?/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+(?:\s*:?-{2,}:?\s*)?\|?\s*$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]*\d+[.)][ \t]+(.*)$/;
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])/g;

/** One inline span of a reply line. */
export type ReplySpan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'italic'; readonly text: string };

/** Splits a line into plain, code, bold and italic spans (one non-nested pass). */
export function parseReplyInline(text: string): ReplySpan[] {
  const spans: ReplySpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > cursor) {
      spans.push({ kind: 'text', text: text.slice(cursor, match.index) });
    }
    if (match[1] !== undefined) {
      spans.push({ kind: 'code', text: match[1] });
    } else if (match[2] !== undefined) {
      spans.push({ kind: 'bold', text: match[2] });
    } else {
      spans.push({ kind: 'italic', text: match[3] ?? match[4] ?? '' });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    spans.push({ kind: 'text', text: text.slice(cursor) });
  }
  return spans;
}

function inlineInto(parent: HTMLElement, text: string): void {
  for (const span of parseReplyInline(text)) {
    if (span.kind === 'text') {
      parent.append(document.createTextNode(span.text));
    } else if (span.kind === 'code') {
      parent.append(el('code', 'tickets-tx-code', span.text));
    } else if (span.kind === 'bold') {
      parent.append(el('strong', undefined, span.text));
    } else {
      parent.append(el('em', undefined, span.text));
    }
  }
}

/** A fenced block: plain text at once, the host's colours once the grammar has loaded. */
function codeBlock(api: DreyPluginApi, code: string, lang: string): HTMLElement {
  const pre = el('pre', 'tickets-tx-pre');
  const body = el('code', undefined, code);
  pre.append(body);
  if (lang !== '') {
    void api.ui.highlightCode(code, lang).then((spans) => {
      if (spans === null) {
        return;
      }
      body.replaceChildren(...spans.map((span) => (span.className === '' ? document.createTextNode(span.text) : el('span', span.className, span.text))));
    });
  }
  return pre;
}

/** `| a | b |` as its trimmed cells. */
const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

/** A table from parsed rows, the first row its header; scrolls sideways when wider than the column. */
function tableNode(rows: readonly string[][]): HTMLElement {
  const wrap = el('div', 'tickets-tx-table');
  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  for (const cell of rows[0] ?? []) {
    const th = el('th');
    inlineInto(th, cell);
    headRow.append(th);
  }
  head.append(headRow);
  const body = el('tbody');
  for (const row of rows.slice(1)) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      inlineInto(td, cell);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

/** The reply as one `div` of block nodes. */
export function renderReply(api: DreyPluginApi, text: string): HTMLElement {
  const root = el('div', 'tickets-tx-reply');
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      const p = el('p');
      paragraph.forEach((line, index) => {
        if (index > 0) {
          p.append(el('br'));
        }
        inlineInto(p, line);
      });
      root.append(p);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      const listEl = el(list.ordered ? 'ol' : 'ul');
      for (const item of list.items) {
        const li = el('li');
        inlineInto(li, item);
        listEl.append(li);
      }
      root.append(listEl);
      list = null;
    }
  };
  const block = (node: HTMLElement): void => {
    flushParagraph();
    flushList();
    root.append(node);
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      n += 1;
      while (n < lines.length && !FENCE_END.test(lines[n]!)) {
        body.push(lines[n]!);
        n += 1;
      }
      block(codeBlock(api, body.join('\n'), fence[1] ?? ''));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const h = el('div', `tickets-tx-h tickets-tx-h${Math.min(heading[1]!.length, 3)}`);
      inlineInto(h, heading[2] ?? '');
      block(h);
      continue;
    }
    if (RULE.test(line)) {
      block(el('hr'));
      continue;
    }
    if (QUOTE.test(line)) {
      const quote = el('blockquote');
      while (n < lines.length && QUOTE.test(lines[n]!)) {
        const p = el('p');
        inlineInto(p, lines[n]!.replace(QUOTE, ''));
        quote.append(p);
        n += 1;
      }
      n -= 1;
      block(quote);
      continue;
    }
    if (TABLE_ROW.test(line) && n + 1 < lines.length && TABLE_RULE.test(lines[n + 1]!)) {
      const rows: string[][] = [splitRow(line)];
      n += 2;
      while (n < lines.length && TABLE_ROW.test(lines[n]!)) {
        rows.push(splitRow(lines[n]!));
        n += 1;
      }
      n -= 1;
      block(tableNode(rows));
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    const item = bullet ?? ordered;
    if (item !== null) {
      flushParagraph();
      if (list === null || list.ordered !== (ordered !== null)) {
        flushList();
        list = { ordered: ordered !== null, items: [] };
      }
      list.items.push(item[1] ?? '');
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return root;
}
