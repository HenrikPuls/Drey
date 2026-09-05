import { blockIndexForNode, domPointToTextOffset, textOffsetToDomPoint } from './preview-caret';

function fragment(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('preview-caret DOM helpers', () => {
  it('domPointToTextOffset counts text across inline elements', () => {
    const root = fragment('<p>a <strong>bold</strong> c</p>');
    const p = root.querySelector('p')!;
    const boldText = p.querySelector('strong')!.firstChild!;
    // "a " (2) + "bo" (2)
    expect(domPointToTextOffset(p, boldText, 2)).toBe(4);
  });

  it('domPointToTextOffset accepts an element point (child index)', () => {
    const root = fragment('<p>a <strong>bold</strong> c</p>');
    const p = root.querySelector('p')!;
    // after the first two child nodes: "a " + "bold"
    expect(domPointToTextOffset(p, p, 2)).toBe(6);
  });

  it('textOffsetToDomPoint round-trips with domPointToTextOffset', () => {
    const root = fragment('<p>a <strong>bold</strong> c</p>');
    const p = root.querySelector('p')!;
    for (const target of [0, 2, 4, 6, 8]) {
      const point = textOffsetToDomPoint(p, target);
      expect(domPointToTextOffset(p, point.node, point.offset)).toBe(target);
    }
  });

  it('textOffsetToDomPoint clamps past the end to the last text node', () => {
    const root = fragment('<p>hi</p>');
    const p = root.querySelector('p')!;
    const point = textOffsetToDomPoint(p, 99);
    expect(point.offset).toBe(2);
  });

  it('blockIndexForNode picks the nearest cm-src ancestor', () => {
    const root = fragment('<blockquote class="cm-src-0"><p class="cm-src-1">hi</p></blockquote>');
    const text = root.querySelector('p')!.firstChild!;
    expect(blockIndexForNode(text, root)).toBe(1);
  });

  it('blockIndexForNode sees the marker among other classes', () => {
    const root = fragment('<pre><code class="language-js cm-src-4">x</code></pre>');
    const text = root.querySelector('code')!.firstChild!;
    expect(blockIndexForNode(text, root)).toBe(4);
  });

  it('blockIndexForNode returns null outside any mapped block', () => {
    const root = fragment('<div><span>loose</span></div>');
    const text = root.querySelector('span')!.firstChild!;
    expect(blockIndexForNode(text, root)).toBeNull();
  });
});
