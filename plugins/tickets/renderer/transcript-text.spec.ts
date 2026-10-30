// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { renderReply } from './transcript-text';

const api = { ui: { highlightCode: () => Promise.resolve(null) } } as unknown as DreyPluginApi;

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

  it("colours a fence with the host's highlighter, aliases included, and diffs per line", async () => {
    const asked: string[] = [];
    const colouring = {
      ui: {
        highlightCode: (code: string, lang: string) => {
          asked.push(lang);
          return Promise.resolve([{ text: code, className: 'tok-keyword' }]);
        },
      },
    } as unknown as DreyPluginApi;
    const node = renderReply(colouring, '```ts\nconst x = 1;\n```\n\n```ps1\nGet-Item .\n```\n\n```diff\n@@ a\n+new\n-old\n```');
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual(['ts', 'powershell']);
    expect(node.querySelector('pre span.tok-keyword')?.textContent).toBe('const x = 1;');
    expect([...node.querySelectorAll('.tickets-tx-codeblock-lang')].map((n) => n.textContent)).toEqual(['ts', 'ps1', 'diff']);
    expect([...node.querySelectorAll('pre span[class^="tickets-tx-diff"]')].map((n) => n.className)).toEqual([
      'tickets-tx-diff-hunk',
      'tickets-tx-diff-add',
      'tickets-tx-diff-del',
    ]);
  });

  it('takes the indent of a fence inside a list item off its code lines', () => {
    const node = renderReply(api, '1. Wire it:\n   ```ts\n   if (a) {\n     b();\n   }\n   ```');
    expect(node.querySelector('pre')?.textContent).toBe('if (a) {\n  b();\n}');
  });

  it('never interprets HTML in worker text', () => {
    const node = renderReply(api, '<img src=x onerror=alert(1)>');
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
