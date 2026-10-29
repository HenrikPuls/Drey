import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { applyExtendedMarkdown } from '../../../shared/markdown/markdown-it-extended';
import { ensureFenceLanguage, fenceLanguageOf, highlightFence } from './preview-highlight';

/**
 * The fence highlighter (T-0051): a ```ts fence renders with the same
 * Lezer grammars and the same colors the source editor uses, as inline
 * styles that survive into any document. Grammars load lazily — the
 * first fence of a language is plain until `ensureFenceLanguage`
 * finished, then the next render colors it.
 */
describe('highlightFence', () => {
  it('an unknown language falls back to markdown-it (empty string)', async () => {
    expect(fenceLanguageOf('')).toBeNull();
    expect(fenceLanguageOf('   ')).toBeNull();
    expect(fenceLanguageOf('not-a-language-name')).toBeNull();
    expect(highlightFence('const x = 1', 'not-a-language-name')).toBe('');
    // An info word the index knows resolves to its description.
    expect(fenceLanguageOf('ts')?.name).toBe('TypeScript');
  });

  it('colors a TypeScript fence with inline-styled spans (the plan\'s verify)', async () => {
    await expect(ensureFenceLanguage('ts')).resolves.toBe(true);
    const html = highlightFence('const answer: number = 42 // done', 'ts');
    expect(html).toContain('<span style="');
    // keyword, number and comment each carry their own color.
    const colors = [...html.matchAll(/<span style="([^"]+)">/g)].map((m) => m[1]);
    expect(new Set(colors).size).toBeGreaterThanOrEqual(3);
    expect(html).toContain('const');
    expect(html).toContain('42');
    // Everything outside spans is escaped; spans close.
    const opens = (html.match(/<span /g) ?? []).length;
    expect(html.match(/<\/span>/g)).toHaveLength(opens);
  });

  it('escapes html in the code, colored or not', async () => {
    await expect(ensureFenceLanguage('ts')).resolves.toBe(true);
    expect(highlightFence('let s = "<b>&"</b>', 'ts')).not.toContain('<b>');
    expect(highlightFence('a < b', 'not-a-language-name')).toBe('');
  });

  it('wires into markdown-it through applyExtendedMarkdown (the hook)', async () => {
    const md = new MarkdownIt({ html: false });
    applyExtendedMarkdown(md, { fenceHighlight: highlightFence });
    const plain = md.render('```ts\nconst x = 1\n```\n');
    expect(plain).toContain('<pre>');
    // Grammar cached by the earlier tests: the fence carries colors.
    expect(plain).toContain('<span style="');

    const bare = new MarkdownIt({ html: false });
    applyExtendedMarkdown(bare);
    expect(bare.render('```ts\nconst x = 1\n```\n')).not.toContain('<span style="');
  });
});
