import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it';
import { applyExtendedMarkdown } from './markdown-it-extended';

/** A fresh instance with the extended rules, like the render sites use. */
function md(math: 'placeholder' | 'source' = 'placeholder'): MarkdownItInstance {
  const instance: MarkdownItInstance = new MarkdownIt({ html: true });
  applyExtendedMarkdown(instance, { math, footnotes: true });
  return instance;
}

describe('applyExtendedMarkdown', () => {
  it('renders ==highlight== as <mark> and nests inline formatting', () => {
    expect(md().render('a ==b **bold**== c')).toContain('a <mark>b <strong>bold</strong></mark> c');
  });

  it('leaves an unmatched == alone', () => {
    expect(md().renderInline('a == b')).toBe('a == b');
  });

  it('renders pandoc subscript and superscript', () => {
    expect(md().renderInline('H~2~O and X^2^')).toBe('H<sub>2</sub>O and X<sup>2</sup>');
  });

  it('keeps ~~strike~~ strikethrough and refuses spaced sub/sup runs', () => {
    expect(md().renderInline('~~gone~~')).toContain('<s>gone</s>');
    expect(md().renderInline('a ~ b ~')).toBe('a ~ b ~');
    expect(md().renderInline('~a b~')).toBe('~a b~');
  });

  it('renders curated :shortcodes: and leaves timestamps alone', () => {
    expect(md().renderInline(':joy:')).toBe('😂');
    expect(md().renderInline('at 00:03:48 sharp')).toBe('at 00:03:48 sharp');
    expect(md().renderInline(':not_a_shortcode:')).toBe(':not_a_shortcode:');
  });

  it('renders inline math as placeholder or source spans', () => {
    expect(md().renderInline('$x^2$')).toBe('<span class="drey-math" data-display="0">x^2</span>');
    expect(md('source').renderInline('$x^2$')).toBe('<code class="drey-math-src">x^2</code>');
    expect(md().renderInline('$$E=mc^2$$')).toContain('data-display="1"');
  });

  it('keeps currency and escaped dollars as prose', () => {
    expect(md().renderInline('costs $5 and $6 total')).toBe('costs $5 and $6 total');
    expect(md().renderInline('escaped \\$x$ stays')).toBe(
      'escaped $x$ stays', // \\$ becomes $ via the escape rule; no math anywhere
    );
  });

  it('renders $$ display blocks, multiline and single-line', () => {
    const html = md().render('$$\n\\int_0^1 x dx\n$$\n');
    expect(html).toContain('data-display="1"');
    expect(html).toContain('\\int_0^1 x dx');
    expect(md().render('$$ E = mc^2 $$\n')).toContain('data-display="1"');
  });

  it('linkifies bare URLs and keeps code spans unlinked (disabling)', () => {
    const html = md().render('see https://example.com/x now');
    expect(html).toContain('<a href="https://example.com/x">');
    const code = md().render('`https://example.com`');
    expect(code).not.toContain('<a href');
    expect(code).toContain('<code>');
  });

  it('renders footnotes as a footnote section', () => {
    const html = md().render('A claim[^1] and another[^note]\n\n[^1]: First\n\n[^note]: Second\n');
    expect(html).toContain('footnote-ref');
    expect(html).toContain('footnotes');
    expect(html).toMatch(/First[\s\S]*Second|Second[\s\S]*First/);
  });

  it('renders GitHub alerts and Obsidian callouts as callout boxes', () => {
    const html = md().render('> [!NOTE] Custom title\n> body text\n');
    expect(html).toContain('<div class="callout callout-note">');
    expect(html).toContain('callout-title');
    expect(html).toContain('Custom title');
    expect(html).toContain('body text');

    const caution = md().render('> [!CAUTION]\n> careful\n');
    expect(caution).toContain('<div class="callout callout-caution">');
    expect(caution).toContain('Caution');

    const obsidian = md().render('> [!bug]- known issue\n> details\n');
    expect(obsidian).toContain('<div class="callout callout-caution">');
    expect(obsidian).toContain('known issue');
  });

  it('keeps a plain blockquote without a marker', () => {
    const html = md().render('> [!NOSUCHTYPE] x\n> body\n');
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('callout');
  });

  it('keeps the fold suffix out of the body and title', () => {
    const html = md().render('> [!TIP]+\n> hint body\n');
    expect(html).toContain('<div class="callout callout-tip">');
    expect(html).toContain('Tip');
    expect(html).toContain('hint body');
  });
});
