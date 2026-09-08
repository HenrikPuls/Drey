import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';
import { blockDecorations, LivePreviewConfig } from './block-render';
import { HtmlBlockWidget, ImageWidget, MermaidWidget, TableWidget } from './widgets';

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';
const MERMAID = '```mermaid\ngraph TD;\n  A-->B;\n```';

function state(doc: string, anchor = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function widgets(set: DecorationSet): { from: number; to: number; deco: Decoration }[] {
  const out: { from: number; to: number; deco: Decoration }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    out.push({ from, to, deco });
  });
  return out;
}

const passThrough: LivePreviewConfig = { resolveImage: (url) => url };

describe('blockDecorations', () => {
  it('replaces a table the cursor is outside of with a rendered block widget', () => {
    const doc = `intro\n\n${TABLE}\n\nend`;
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as TableWidget;
    expect(widget).toBeInstanceOf(TableWidget);
    expect(all[0].deco.spec['block']).toBe(true);
    expect(widget.html).toContain('<table>');
    expect(widget.html).toContain('<td>1</td>');
  });

  it('shows the raw table while the selection touches it', () => {
    const doc = `intro\n\n${TABLE}\n\nend`;
    const inTable = doc.indexOf('| 1 |') + 2;
    expect(widgets(blockDecorations(state(doc, inTable), passThrough))).toHaveLength(0);
  });

  it('replaces an image with a widget carrying the resolved src and alt text', () => {
    const all = widgets(blockDecorations(state('![a boat](img/boat.png)\n\nend', 28), passThrough));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as ImageWidget;
    expect(widget).toBeInstanceOf(ImageWidget);
    expect(widget.src).toBe('img/boat.png');
    expect(widget.alt).toBe('a boat');
  });

  it('passes a null resolution through so the widget renders its placeholder', () => {
    const config: LivePreviewConfig = { resolveImage: () => null };
    const all = widgets(blockDecorations(state('![gone](../../etc/x.png)\n\nend', 29), config));
    expect((all[0].deco.spec['widget'] as ImageWidget).src).toBeNull();
  });

  it('reveals the raw image markup while the cursor is inside it', () => {
    expect(widgets(blockDecorations(state('![a](b.png)', 3), passThrough))).toHaveLength(0);
  });

  it('reads an Obsidian-style |W / |WxH size off the alt text', () => {
    const w = widgets(blockDecorations(state('![a boat|300](img/boat.png)\n\nend'), passThrough));
    const widget = w[0].deco.spec['widget'] as ImageWidget;
    expect(widget.alt).toBe('a boat');
    expect(widget.width).toBe(300);
    expect(widget.height).toBeNull();

    const wh = widgets(blockDecorations(state('![plan|300x200](p.png)\n\nend'), passThrough));
    const w2 = wh[0].deco.spec['widget'] as ImageWidget;
    expect(w2.alt).toBe('plan');
    expect(w2.width).toBe(300);
    expect(w2.height).toBe(200);
  });

  it('leaves width null for a plain image', () => {
    const w = widgets(blockDecorations(state('![a](b.png)\n\nend'), passThrough));
    expect((w[0].deco.spec['widget'] as ImageWidget).width).toBeNull();
  });

  it('renders an HTML block as a sanitized widget, raw while the cursor is inside', () => {
    const doc = 'before\n\n<div class="x"><b>hi</b><script>boom()</script></div>\n\nafter';
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as HtmlBlockWidget;
    expect(widget).toBeInstanceOf(HtmlBlockWidget);
    expect(all[0].deco.spec['block']).toBe(true);
    expect(widget.html).toContain('<b>hi</b>');
    expect(widget.html).not.toContain('script');

    const inBlock = doc.indexOf('<b>');
    expect(widgets(blockDecorations(state(doc, inBlock), passThrough))).toHaveLength(0);
  });

  it('merges a <details> split by blank lines into one widget, markdown body rendered', () => {
    const doc =
      'intro\n\n<details>\n<summary>Titel</summary>\n\nGeheim **fett**\n\n</details>\n\nafter';
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as HtmlBlockWidget;
    expect(widget.html).toContain('<summary>Titel</summary>');
    expect(widget.html).toContain('<strong>fett</strong>');
    // One region: from the opening block's line through the closing tag's
    // line -- the hidden body must NOT be left standing outside the widget.
    expect(all[0].from).toBe(doc.indexOf('<details>'));
    expect(all[0].to).toBe(doc.indexOf('</details>') + '</details>'.length);

    // Cursor inside the markdown body reveals the whole region.
    const inBody = doc.indexOf('Geheim') + 2;
    expect(widgets(blockDecorations(state(doc, inBody), passThrough))).toHaveLength(0);
  });

  it('leaves a stray closing tag raw instead of rendering an empty widget', () => {
    expect(widgets(blockDecorations(state('text\n\n</div>\n\nmore', 0), passThrough))).toHaveLength(
      0,
    );
  });

  it('replaces a ```mermaid fence the cursor is outside of with a MermaidWidget', () => {
    const doc = `intro\n\n${MERMAID}\n\nend`;
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as MermaidWidget;
    expect(widget).toBeInstanceOf(MermaidWidget);
    expect(all[0].deco.spec['block']).toBe(true);
    expect(widget.source).toBe('graph TD;\n  A-->B;');
  });

  it('reveals the raw ```mermaid fence while the cursor is inside it', () => {
    const doc = `intro\n\n${MERMAID}\n\nend`;
    const inside = doc.indexOf('A-->B');
    expect(widgets(blockDecorations(state(doc, inside), passThrough))).toHaveLength(0);
  });

  it('leaves a non-mermaid fenced block alone', () => {
    const doc = 'intro\n\n```ts\nconst x = 1;\n```\n\nend';
    expect(widgets(blockDecorations(state(doc, 0), passThrough))).toHaveLength(0);
  });

  it('never renders widgets inside frontmatter', () => {
    // `![x](y.png)` in the YAML would parse as an Image node -- the
    // frontmatter guard must keep it raw.
    const doc = '---\ncover: ![x](y.png)\n---\n\ntext';
    expect(widgets(blockDecorations(state(doc), passThrough))).toHaveLength(0);
  });
});
