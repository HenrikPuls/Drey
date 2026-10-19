// @vitest-environment jsdom
import type { DreyPluginApi, InlineSegment } from '../../../shared/plugin-api/renderer';
import { extractWikilinks } from '../../../shared/wikilinks';
import {
  parseInlineFormatting,
  renderRichBody,
} from './rich-text';

/**
 * Specs for the assistant panel's rich card bodies (SDK 1.11): the mini
 * Markdown subset plus base-owned `[[wikilinks]]`. `api.links` is faked
 * with the real base grammar (`extractWikilinks`), so the segmenting
 * under test is the one production uses.
 */

function fakeLinksApi(overrides: Partial<DreyPluginApi['links']> = {}): DreyPluginApi & {
  opened: Array<{ path: string; vaultId?: string }>;
} {
  const opens: Array<{ path: string; vaultId?: string }> = [];
  const api = {
    documents: {
      open: (path: string, _line?: number, opts?: { vaultId?: string }) => {
        opens.push({ path, ...(opts?.vaultId !== undefined ? { vaultId: opts.vaultId } : {}) });
        return Promise.resolve();
      },
    },
    links: {
      parseInline: (text: string): readonly InlineSegment[] => {
        const segments: InlineSegment[] = [];
        let cursor = 0;
        for (const link of extractWikilinks(text)) {
          if (link.index > cursor) {
            segments.push({ kind: 'text', text: text.slice(cursor, link.index) });
          }
          segments.push({
            kind: 'wikilink',
            target: link.target,
            anchor: link.anchor,
            alias: link.alias,
          });
          cursor = link.index + link.length;
        }
        if (cursor < text.length) {
          segments.push({ kind: 'text', text: text.slice(cursor) });
        }
        return segments;
      },
      resolve: (target: string) =>
        ['notizen/zettel.md', 'daily/2026/09/2026-09-18.md'].includes(target)
          ? { vaultId: 'v1', path: target }
          : null,
      open: () => undefined,
      ...overrides,
    },
  } as unknown as DreyPluginApi & { opened: typeof opens };
  return Object.assign(api, { opened: opens });
}

describe('assistant rich text — inline formatting parser', () => {
  it('splits code, bold and italic in one pass', () => {
    expect(parseInlineFormatting('a `code` b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' b' },
    ]);
    expect(parseInlineFormatting('**fett** und *kursiv*')).toEqual([
      { kind: 'bold', text: 'fett' },
      { kind: 'text', text: ' und ' },
      { kind: 'italic', text: 'kursiv' },
    ]);
    expect(parseInlineFormatting('nichts')).toEqual([{ kind: 'text', text: 'nichts' }]);
  });

  it('prefers bold over italic on `**`', () => {
    expect(parseInlineFormatting('**x**')[0]).toEqual({ kind: 'bold', text: 'x' });
  });
});

describe('assistant rich text — card bodies', () => {
  it('renders paragraphs and bullet/ordered lists', () => {
    const body = renderRichBody(fakeLinksApi(), 'Erste Zeile\n\n- eins\n- zwei\n\n1. a\n2. b');
    const ps = body.querySelectorAll('p');
    const uls = body.querySelectorAll('ul li');
    const ols = body.querySelectorAll('ol li');
    expect(ps).toHaveLength(1);
    expect([...uls].map((li) => li.textContent)).toEqual(['eins', 'zwei']);
    expect([...ols].map((li) => li.textContent)).toEqual(['a', 'b']);
  });

  it('renders bold, italic and inline code as elements', () => {
    const body = renderRichBody(fakeLinksApi(), 'x **wichtig** und `code` y');
    expect(body.querySelector('strong')?.textContent).toBe('wichtig');
    expect(body.querySelector('code')?.textContent).toBe('code');
  });

  it('renders wikilinks as buttons with the alias, probing resolution for styling', () => {
    const api = fakeLinksApi();
    const body = renderRichBody(api, 'siehe [[notizen/zettel.md|den Zettel]] und [[gone.md]]');
    const links = [...body.querySelectorAll('button.chat-link')];
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe('den Zettel');
    expect(links[0].classList.contains('unresolved')).toBe(false);
    expect(links[1].textContent).toBe('gone.md');
    expect(links[1].classList.contains('unresolved')).toBe(true);
  });

  it('a link click calls links.open with target and anchor (create-on-unresolved)', () => {
    const opens: Array<{ target: string; anchor: string | null }> = [];
    const api = fakeLinksApi({
      open: (target, anchor) => {
        opens.push({ target, anchor: anchor ?? null });
        return Promise.resolve();
      },
    });
    const body = renderRichBody(api, '[[notizen/zettel.md#Kapitel 1|K1]]');
    (body.querySelector('button.chat-link') as HTMLButtonElement).click();
    expect(opens).toEqual([{ target: 'notizen/zettel.md', anchor: 'Kapitel 1' }]);
  });

  it('a same-file [[#anchor]] stays plain text (nothing to navigate to)', () => {
    const body = renderRichBody(fakeLinksApi(), 'siehe [[#Kapitel]]');
    expect(body.querySelectorAll('button.chat-link')).toHaveLength(0);
    expect(body.textContent).toContain('[[#Kapitel]]');
  });
});

describe('assistant rich text — deterministic path linkify (57a)', () => {
  it('a resolved .md path mention becomes a button that opens it in its vault', () => {
    const api = fakeLinksApi();
    const body = renderRichBody(api, '(Quelle: daily/2026/09/2026-09-18.md)');
    const link = body.querySelector('button.chat-link');
    expect(link?.textContent).toBe('daily/2026/09/2026-09-18.md');
    (link as HTMLButtonElement).click();
    expect(api.opened).toEqual([{ path: 'daily/2026/09/2026-09-18.md', vaultId: 'v1' }]);
  });

  it('an unresolved path stays plain text (never minted from prose)', () => {
    const api = fakeLinksApi();
    const body = renderRichBody(api, '(Quelle: archiv/geloescht.md)');
    expect(body.querySelectorAll('button.chat-link')).toHaveLength(0);
    expect(body.textContent).toContain('archiv/geloescht.md');
  });

  it('a path inside a code span is not linkified', () => {
    const api = fakeLinksApi();
    const body = renderRichBody(api, 'ablegen unter `notizen/zettel.md` bitte');
    expect(body.querySelectorAll('button.chat-link')).toHaveLength(0);
    expect(body.querySelector('code')?.textContent).toBe('notizen/zettel.md');
  });

  it('a bare file name without a slash stays prose', () => {
    const api = fakeLinksApi();
    const body = renderRichBody(api, 'siehe 2026-09-18.md dort');
    expect(body.querySelectorAll('button.chat-link')).toHaveLength(0);
  });
});

describe('assistant rich text — block Markdown', () => {
  it('renders a fenced block with a language label and coloured tokens', () => {
    const body = renderRichBody(fakeLinksApi(), 'Intro\n```ts\nconst n = 1; // one\nrun("x");\n```\nafter');
    expect(body.querySelector('.md-code-lang')?.textContent).toBe('ts');
    expect(body.querySelector('.tok-keyword')?.textContent).toBe('const');
    expect(body.querySelector('.tok-number')?.textContent).toBe('1');
    expect(body.querySelector('.tok-comment')?.textContent).toBe('// one');
    expect(body.querySelector('.tok-string')?.textContent).toBe('"x"');
    expect(body.querySelector('.tok-function')?.textContent).toBe('run');
    expect(body.querySelector('code')?.textContent).toBe('const n = 1; // one\nrun("x");');
  });

  it('keeps list-looking lines inside a fence verbatim', () => {
    const body = renderRichBody(fakeLinksApi(), '```\n- not a list\n# not a heading\n```');
    expect(body.querySelector('li')).toBeNull();
    expect(body.querySelector('.md-h')).toBeNull();
  });

  it('renders headings, quotes, rules and tables', () => {
    const body = renderRichBody(fakeLinksApi(), '## Title\n> quoted\n---\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(body.querySelector('.md-h2')?.textContent).toBe('Title');
    expect(body.querySelector('blockquote')?.textContent).toBe('quoted');
    expect(body.querySelector('hr')).not.toBeNull();
    expect(body.querySelectorAll('th')).toHaveLength(2);
    expect(body.querySelector('td')?.textContent).toBe('1');
  });
});
