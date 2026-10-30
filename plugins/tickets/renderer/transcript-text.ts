/**
 * A worker reply as DOM (req-58): the small Markdown subset worker
 * replies use — paragraphs, headings, `-`/`1.` lists, quotes, rules, tables,
 * fenced code (coloured by the host's `ui.highlightCode`) and inline
 * `code` / **bold** / *italic* (the inline parser and row splitter live in
 * `shared/markdown.ts`, shared with the remote client). Built as nodes,
 * never `innerHTML`: worker output is untrusted text. The shape follows
 * the assistant's rich-text renderer; a plugin cannot import another
 * plugin's folder.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { parseReplyInline, splitRow } from '../shared/markdown';

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

/** Common worker spellings the host's language catalogue does not know by that name. */
const LANG_ALIAS: Readonly<Record<string, string>> = {
  ps1: 'powershell',
  pwsh: 'powershell',
  sh: 'shell',
  bash: 'shell',
  console: 'shell',
  jsonl: 'json',
  ndjson: 'json',
};

/** A `diff` / `patch` line's colour class. */
const diffClass = (line: string): string =>
  line.startsWith('@@') ? 'tickets-tx-diff-hunk' : line.startsWith('+') ? 'tickets-tx-diff-add' : line.startsWith('-') ? 'tickets-tx-diff-del' : '';

/**
 * A fenced block: a head with the language and a copy button over the
 * code — plain text at once, the host's syntax colours (the editor's own
 * theme) once the grammar has loaded; diffs colour per line.
 */
function codeBlock(api: DreyPluginApi, code: string, lang: string): HTMLElement {
  const block = el('div', 'tickets-tx-codeblock');
  const head = el('div', 'tickets-tx-codeblock-head');
  head.append(el('span', 'tickets-tx-codeblock-lang', lang === '' ? 'text' : lang));
  const copy = el('button', 'tickets-tx-codeblock-copy', 'Copy');
  copy.type = 'button';
  copy.title = 'Copy the code';
  copy.setAttribute('aria-label', 'Copy the code');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(code).then(
      () => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1_200);
      },
      () => undefined,
    );
  });
  head.append(copy);
  const pre = el('pre', 'tickets-tx-pre');
  const body = el('code', undefined, code);
  pre.append(body);
  block.append(head, pre);
  const kind = lang.toLowerCase();
  if (kind === 'diff' || kind === 'patch') {
    const lines = code.split('\n');
    body.replaceChildren(
      ...lines.map((line, index) => {
        const text = index < lines.length - 1 ? `${line}\n` : line;
        const cls = diffClass(line);
        return cls === '' ? document.createTextNode(text) : el('span', cls, text);
      }),
    );
  } else if (kind !== '') {
    void api.ui
      .highlightCode(code, LANG_ALIAS[kind] ?? kind)
      .then((spans) => {
        if (spans !== null) {
          body.replaceChildren(...spans.map((span) => (span.className === '' ? document.createTextNode(span.text) : el('span', span.className, span.text))));
        }
      })
      .catch(() => undefined);
  }
  return block;
}

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
      // A fence inside a list item is indented; its code lines lose that indent.
      const indent = new RegExp(`^ {0,${line.length - line.trimStart().length}}`);
      const body: string[] = [];
      n += 1;
      while (n < lines.length && !FENCE_END.test(lines[n]!)) {
        body.push(lines[n]!.replace(indent, ''));
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
