/**
 * Block-level pieces of the assistant's rich card bodies beyond
 * paragraphs and lists: fenced code, headings, rules, quotes, tables.
 * Everything is built as DOM nodes — model output is untrusted text.
 */
import { tokenize } from './code-highlight.js';
import { icon } from './dom.js';

export const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
export const FENCE_END = /^\s*```\s*$/;
export const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
export const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
export const QUOTE = /^\s{0,3}>[ \t]?/;
export const TABLE_ROW = /^\s*\|.*\|\s*$/;
export const TABLE_RULE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+(?:\s*:?-{2,}:?\s*)?\|?\s*$/;

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

export function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** A table from parsed rows (first row = header); `inline` renders one cell's text. */
export function tableNode(rows: string[][], inline: (text: string) => Node[]): HTMLElement {
  const wrap = el('div', 'md-table-wrap');
  const table = el('table');
  const headRow = el('tr');
  for (const cell of rows[0]) {
    const th = el('th');
    inline(cell).forEach((node) => th.appendChild(node));
    headRow.appendChild(th);
  }
  const head = el('thead');
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el('tbody');
  for (const row of rows.slice(1)) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      inline(cell).forEach((node) => td.appendChild(node));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

function diffKind(line: string): string {
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  if (line.startsWith('+')) {
    return 'add';
  }
  return line.startsWith('-') ? 'del' : '';
}

/** A fenced block: language label, copy button, syntax-coloured tokens (diffs per line). */
export function codeBlockNode(code: string, lang: string): HTMLElement {
  const block = el('div', 'md-code');
  const head = el('div', 'md-code-head');
  head.appendChild(el('span', 'md-code-lang', lang === '' ? 'text' : lang));
  const copy = el('button', 'md-code-copy');
  copy.type = 'button';
  copy.title = 'Copy code';
  copy.setAttribute('aria-label', 'Copy code');
  copy.appendChild(icon('copy', 12));
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(code).catch(() => undefined);
  });
  head.appendChild(copy);
  block.appendChild(head);

  const pre = el('pre');
  const codeEl = el('code');
  const kind = lang.toLowerCase();
  if (kind === 'diff' || kind === 'patch') {
    const lines = code.split('\n');
    lines.forEach((text, index) => {
      const mark = diffKind(text);
      codeEl.appendChild(
        el('span', mark === '' ? undefined : `tok-diff-${mark}`, index < lines.length - 1 ? `${text}\n` : text),
      );
    });
  } else {
    for (const token of tokenize(code, lang)) {
      codeEl.appendChild(
        token.kind === 'plain' ? document.createTextNode(token.text) : el('span', `tok-${token.kind}`, token.text),
      );
    }
  }
  pre.appendChild(codeEl);
  block.appendChild(pre);
  return block;
}
