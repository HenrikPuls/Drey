/**
 * The remote client's Markdown DOM (req-66 R8): the blocks
 * (`model.ts` blocksOf) as nodes with inline `code` / **bold** / *italic*
 * from the one canonical parser (`shared/markdown.ts`). Built through
 * `h()` and `textContent` only — ticket and worker text is untrusted.
 */
import { parseReplyInline } from '../shared/markdown';
import { h } from './dom';
import { blocksOf, type Block } from './model';

/** One line's inline spans appended to `parent` as nodes. */
function inlineInto(parent: HTMLElement, text: string): void {
  for (const span of parseReplyInline(text)) {
    if (span.kind === 'text') {
      parent.append(document.createTextNode(span.text));
    } else if (span.kind === 'code') {
      parent.append(h('code', { class: 'ic', text: span.text }));
    } else if (span.kind === 'bold') {
      parent.append(h('strong', { text: span.text }));
    } else {
      parent.append(h('em', { text: span.text }));
    }
  }
}

/** A table from its rows, the first the header; the wrapper scrolls sideways. */
function tableNode(rows: readonly string[][]): HTMLElement {
  const headRow = h('tr');
  for (const cell of rows[0] ?? []) {
    const th = h('th');
    inlineInto(th, cell);
    headRow.append(th);
  }
  const body = h('tbody');
  for (const row of rows.slice(1)) {
    const tr = h('tr');
    for (const cell of row) {
      const td = h('td');
      inlineInto(td, cell);
      tr.append(td);
    }
    body.append(tr);
  }
  return h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, headRow), body));
}

/** The blocks as DOM: `p`, list rows with the client's checkbox chrome, code, tables, rules and in-section headings. */
export function markdownBlocks(blocks: readonly Block[], opts: { log?: boolean } = {}): HTMLElement[] {
  const log = opts.log === true;
  return blocks.map((block): HTMLElement => {
    switch (block.kind) {
      case 'code':
        return h('pre', { class: 'code', text: block.text });
      case 'li': {
        const text = h('span');
        inlineInto(text, block.text);
        return h(
          'div',
          { class: `li${log ? ' li-log' : ''}` },
          block.checked === null
            ? h('span', { class: 'bullet', text: log ? '' : '•' })
            : h('span', { class: `box${block.checked ? ' done' : ''}` }),
          text,
        );
      }
      case 'table':
        return tableNode(block.rows);
      case 'hr':
        return h('hr');
      case 'h': {
        const node = h('h5', { class: 'md-sub' });
        inlineInto(node, block.text);
        return node;
      }
      default: {
        const p = h('p');
        inlineInto(p, block.text);
        return p;
      }
    }
  });
}

/** One Markdown text (a transcript row) as the container that owns its whitespace. */
export function renderMarkdown(text: string): HTMLElement {
  return h('div', { class: 'mdr' }, ...markdownBlocks(blocksOf(text.replace(/\r\n?/g, '\n').split('\n'))));
}
