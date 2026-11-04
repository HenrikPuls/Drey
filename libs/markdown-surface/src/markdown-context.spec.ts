import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { inCompletableText, markdownContextAt } from './markdown-context';

/** Context kind at the cursor placed on `needle` (shifted by `offset`). */
function kindAt(doc: string, needle: string, offset = 0): string {
  const pos = doc.indexOf(needle) + offset;
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  return markdownContextAt(state, pos).kind;
}

describe('markdownContextAt', () => {
  it('reports prose for ordinary text', () => {
    expect(kindAt('a plain sentence', 'sentence', 2)).toBe('prose');
  });

  it('reports frontmatter only inside the leading fence', () => {
    const doc = '---\ntitle: note\n---\nbody text';
    expect(kindAt(doc, 'title', 1)).toBe('frontmatter');
    expect(kindAt(doc, 'body', 1)).toBe('prose');
  });

  it('reports fenced code blocks and inline code spans', () => {
    expect(kindAt('```sh\necho hi\n```', 'echo', 1)).toBe('code-block');
    expect(kindAt('a `code span` b', 'span', 1)).toBe('code-span');
  });

  it('reports links -- label, target and URL alike', () => {
    expect(kindAt('see [the label](https://x.test) now', 'label', 1)).toBe('link');
    expect(kindAt('see [the label](https://x.test) now', 'https', 2)).toBe('link');
  });

  it('reports raw HTML tags', () => {
    expect(kindAt('a <b>bold</b> c', '<b>', 2)).toBe('html');
  });

  it('reports GFM tables once the delimiter row exists', () => {
    const table = '| a | b |\n|---|---|\n| word |';
    expect(kindAt(table, 'word', 1)).toBe('table');
    expect(kindAt(table, 'a |', 0)).toBe('table');
  });

  it('falls back to table for row-shaped lines the parser has not made a Table yet', () => {
    const partial = '| a | b |\n| x | y |\n|---|---|';
    expect(kindAt(partial, 'a |', 0)).toBe('table');
    expect(kindAt(partial, 'x |', 0)).toBe('table');
  });

  it('reports headings', () => {
    expect(kindAt('## A heading', 'heading', 2)).toBe('heading');
  });

  it('reports a trailing #tag token, also at line start', () => {
    expect(kindAt('note #projekt/fr', 'fr', 1)).toBe('tag');
    expect(kindAt('#alpha first', 'alpha', 2)).toBe('tag');
  });

  it('prefers wikilink for everything after an unclosed [[', () => {
    expect(kindAt('see [[Boat', 'Boat', 2)).toBe('wikilink');
    expect(kindAt('[[note#Head', 'Head', 1)).toBe('wikilink');
  });

  it('keeps the tree verdict for inline markup inside a heading', () => {
    expect(kindAt('## Title #sailing', 'sailing', 2)).toBe('heading');
  });
});

describe('inCompletableText', () => {
  it('opens prose, headings, tables, tags and wikilinks to completion', () => {
    for (const kind of ['prose', 'heading', 'table', 'tag', 'wikilink']) {
      expect(inCompletableText({ kind } as never)).toBe(true);
    }
  });

  it('closes code blocks, code spans, frontmatter, links and HTML to completion', () => {
    for (const kind of ['code-block', 'code-span', 'frontmatter', 'link', 'html']) {
      expect(inCompletableText({ kind } as never)).toBe(false);
    }
  });
});
