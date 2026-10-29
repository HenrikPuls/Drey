// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { parseReplyInline, renderReply } from './transcript-text';

const api = { ui: { highlightCode: () => Promise.resolve(null) } } as unknown as DreyPluginApi;

describe('parseReplyInline', () => {
  it('splits code, bold and italic, leaving snake_case words alone', () => {
    expect(parseReplyInline('a `x` **b** *c* _d_ my_var_name')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'd' },
      { kind: 'text', text: ' my_var_name' },
    ]);
  });
});

describe('renderReply', () => {
  it('builds paragraphs, lists, headings and code blocks as nodes', () => {
    const node = renderReply(api, '## Plan\n\nFirst line\nsecond\n\n- one\n- two\n\n1. a\n\n```ts\nconst x = 1;\n```');
    expect(node.querySelector('.tickets-tx-h2')?.textContent).toBe('Plan');
    expect(node.querySelector('p')?.childNodes.length).toBe(3);
    expect(node.querySelectorAll('ul li')).toHaveLength(2);
    expect(node.querySelectorAll('ol li')).toHaveLength(1);
    expect(node.querySelector('pre')?.textContent).toBe('const x = 1;');
  });

  it('builds a table right after a paragraph line, inline formatting in its cells', () => {
    const node = renderReply(
      api,
      'Decisions (the main ones)\n| Decision | Reason |\n|---|---|\n| reuse `reorder` | **no** main changes |\n| pure helpers | a gate |',
    );
    expect(node.querySelector('p')?.textContent).toBe('Decisions (the main ones)');
    expect([...node.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Decision', 'Reason']);
    expect(node.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(node.querySelector('td code')?.textContent).toBe('reorder');
    expect(node.querySelector('td strong')?.textContent).toBe('no');
  });

  it('never interprets HTML in worker text', () => {
    const node = renderReply(api, '<img src=x onerror=alert(1)>');
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
