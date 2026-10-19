// @vitest-environment jsdom
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { renderRichBody } from './rich-text';

/** Block Markdown in assistant answers: fences (host highlighting), headings, quotes, rules, tables. */

type Highlight = (code: string, lang: string) => Promise<readonly { text: string; className: string }[] | null>;

function apiWith(highlightCode: Highlight): DreyPluginApi {
  return {
    ui: { highlightCode },
    links: {
      parseInline: (text: string) => [{ kind: 'text', text }],
      resolve: () => null,
      open: () => undefined,
    },
    documents: { open: () => Promise.resolve() },
  } as unknown as DreyPluginApi;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('assistant rich text — block Markdown', () => {
  it('shows a fence plain first, then with the host highlight spans', async () => {
    const api = apiWith((code, lang) =>
      Promise.resolve(
        lang === 'ts' ? [{ text: 'const', className: 'k' }, { text: code.slice(5), className: '' }] : null,
      ),
    );
    const body = renderRichBody(api, 'Intro\n```ts\nconst n = 1;\n```\nafter');
    expect(body.querySelector('.md-code-lang')?.textContent).toBe('ts');
    expect(body.querySelector('code .k')).toBeNull();
    await flush();
    expect(body.querySelector('code .k')?.textContent).toBe('const');
    expect(body.querySelector('code')?.textContent).toBe('const n = 1;');
  });

  it('keeps an unknown language as plain text', async () => {
    const body = renderRichBody(apiWith(() => Promise.resolve(null)), '```nope\nx\n```');
    await flush();
    expect(body.querySelector('code')?.textContent).toBe('x');
    expect(body.querySelector('code span')).toBeNull();
  });

  it('colours diff lines itself, without the highlighter', () => {
    const body = renderRichBody(apiWith(() => Promise.reject(new Error('unused'))), '```diff\n+a\n-b\n```');
    expect(body.querySelector('.tok-diff-add')?.textContent).toBe('+a\n');
    expect(body.querySelector('.tok-diff-del')?.textContent).toBe('-b');
  });

  it('keeps list-looking lines inside a fence verbatim', () => {
    const body = renderRichBody(apiWith(() => Promise.resolve(null)), '```\n- not a list\n# not a heading\n```');
    expect(body.querySelector('li')).toBeNull();
    expect(body.querySelector('.md-h')).toBeNull();
  });

  it('renders headings, quotes, rules and tables', () => {
    const body = renderRichBody(
      apiWith(() => Promise.resolve(null)),
      '## Title\n> quoted\n---\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(body.querySelector('.md-h2')?.textContent).toBe('Title');
    expect(body.querySelector('blockquote')?.textContent).toBe('quoted');
    expect(body.querySelector('hr')).not.toBeNull();
    expect(body.querySelectorAll('th')).toHaveLength(2);
    expect(body.querySelector('td')?.textContent).toBe('1');
  });
});
