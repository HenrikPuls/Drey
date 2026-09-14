import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';
import { blockDecorations, LivePreviewConfig, revealDecorations } from './block-render';
import {
  HtmlBlockWidget,
  ImagePreviewWidget,
  ImageWidget,
  MermaidWidget,
  PdfPreviewWidget,
  PdfWidget,
  TableWidget,
} from './widgets';

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

const passThrough: LivePreviewConfig = { resolveImage: (url) => [url] };

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
    expect(widget.srcs).toEqual(['img/boat.png']);
    expect(widget.alt).toBe('a boat');
  });

  it('passes a null resolution through so the widget renders its placeholder', () => {
    const config: LivePreviewConfig = { resolveImage: () => [] };
    const all = widgets(blockDecorations(state('![gone](../../etc/x.png)\n\nend', 29), config));
    expect((all[0].deco.spec['widget'] as ImageWidget).srcs).toEqual([]);
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

  it('threads config.onOpenImage into the image widget', () => {
    const seen: string[] = [];
    const config: LivePreviewConfig = {
      resolveImage: (url) => [`resolved:${url}`],
      onOpenImage: (s) => seen.push(s),
    };
    const w = widgets(blockDecorations(state('![a](b.png)\n\nend'), config));
    (w[0].deco.spec['widget'] as ImageWidget).onOpenImage!('resolved:b.png');
    expect(seen).toEqual(['resolved:b.png']);
  });

  it('replaces a pdf reference with a PdfWidget carrying the resolved srcs', () => {
    const config: LivePreviewConfig = {
      resolveImage: (url) => [`drey-asset://v1/asset/${url}`],
    };
    const all = widgets(blockDecorations(state('![Spec](attachments/spec.pdf)\n\nend'), config));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as PdfWidget;
    expect(widget).toBeInstanceOf(PdfWidget);
    expect(widget.srcs).toEqual(['drey-asset://v1/asset/attachments/spec.pdf']);
    expect(widget.alt).toBe('Spec');
    expect(widget.rawUrl).toBe('attachments/spec.pdf');
  });

  it('keeps a size suffix out of a pdf widget (parsed, deliberately ignored)', () => {
    const all = widgets(blockDecorations(state('![plan|300](doc.pdf)\n\nend'), passThrough));
    const widget = all[0].deco.spec['widget'] as PdfWidget;
    expect(widget).toBeInstanceOf(PdfWidget);
    expect(widget.alt).toBe('plan');
    expect(widget.srcs).toEqual(['doc.pdf']);
  });

  it('threads config.onOpenPdf into the pdf widget', () => {
    const seen: string[] = [];
    const config: LivePreviewConfig = {
      resolveImage: (url) => [`resolved:${url}`],
      onOpenPdf: (s) => seen.push(s),
    };
    const w = widgets(blockDecorations(state('![a](doc.pdf)\n\nend'), config));
    (w[0].deco.spec['widget'] as PdfWidget).onOpenPdf!('resolved:doc.pdf');
    expect(seen).toEqual(['resolved:doc.pdf']);
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

describe('revealDecorations', () => {
  const classesOf = (set: DecorationSet): (string | undefined)[] =>
    widgets(set)
      .filter((d) => typeof d.deco.spec['class'] === 'string')
      .map((d) => d.deco.spec['class'] as string);
  const previewOf = (set: DecorationSet) =>
    widgets(set).find((d) => d.deco.spec['widget'] instanceof ImagePreviewWidget);

  it('is empty while nothing is revealed', () => {
    const doc = `intro\n\n${TABLE}\n\nend`;
    expect(widgets(revealDecorations(state(doc, 0), passThrough))).toHaveLength(0);
  });

  it('wraps a touched table in a first / middle / last .lp-reveal container, no widget', () => {
    const doc = `intro\n\n${TABLE}\n\nend`;
    const inTable = doc.indexOf('| 1 |') + 2;
    const set = revealDecorations(state(doc, inTable), passThrough);
    expect(classesOf(set)).toEqual([
      'lp-reveal lp-reveal-first',
      'lp-reveal',
      'lp-reveal lp-reveal-last',
    ]);
    // line decorations sit at a line start (zero length)
    for (const d of widgets(set)) expect(d.from).toBe(d.to);
    expect(previewOf(set)).toBeUndefined();
  });

  it('wraps a touched mermaid fence, no widget', () => {
    const doc = `intro\n\n${MERMAID}\n\nend`;
    const inside = doc.indexOf('A-->B');
    const cls = classesOf(revealDecorations(state(doc, inside), passThrough));
    expect(cls.length).toBeGreaterThan(1);
    expect(cls[0]).toContain('lp-reveal-first');
    expect(cls[cls.length - 1]).toContain('lp-reveal-last');
    expect(previewOf(revealDecorations(state(doc, inside), passThrough))).toBeUndefined();
  });

  it('wraps a touched HTML region, no widget', () => {
    const doc =
      'intro\n\n<details>\n<summary>Titel</summary>\n\nGeheim **fett**\n\n</details>\n\nafter';
    const inBody = doc.indexOf('Geheim') + 2;
    const set = revealDecorations(state(doc, inBody), passThrough);
    const cls = classesOf(set);
    expect(cls[0]).toContain('lp-reveal-first');
    expect(cls[cls.length - 1]).toContain('lp-reveal-last');
    expect(previewOf(set)).toBeUndefined();
  });

  it('keeps a read-only ImagePreviewWidget below a touched image, one-line container', () => {
    const doc = '![a boat|300](img/boat.png)\n\nend';
    const set = revealDecorations(state(doc, 3), passThrough);
    expect(classesOf(set)).toEqual(['lp-reveal lp-reveal-first lp-reveal-last']);
    const preview = previewOf(set);
    expect(preview).toBeDefined();
    expect(preview!.deco.spec['block']).toBe(true);
    const w = preview!.deco.spec['widget'] as ImagePreviewWidget;
    expect(w.srcs).toEqual(['img/boat.png']);
    expect(w.alt).toBe('a boat');
    expect(w.width).toBe(300);
  });

  it('adds the container but no mirror when the image src does not resolve', () => {
    const config: LivePreviewConfig = { resolveImage: () => [] };
    const set = revealDecorations(state('![gone](../../etc/x.png)\n\nend', 3), config);
    expect(classesOf(set).length).toBeGreaterThan(0);
    expect(previewOf(set)).toBeUndefined();
  });

  it('keeps a read-only PdfPreviewWidget below a touched pdf embed', () => {
    const doc = '![Spec](attachments/spec.pdf)\n\nend';
    const set = revealDecorations(state(doc, 3), passThrough);
    expect(classesOf(set)).toEqual(['lp-reveal lp-reveal-first lp-reveal-last']);
    const preview = widgets(set).find((d) => d.deco.spec['widget'] instanceof PdfPreviewWidget);
    expect(preview).toBeDefined();
    expect(preview!.deco.spec['block']).toBe(true);
    const w = preview!.deco.spec['widget'] as PdfPreviewWidget;
    expect(w.srcs).toEqual(['attachments/spec.pdf']);
    expect(w.alt).toBe('Spec');
  });

  it('keeps a broken pdf reference unmirrored (container only)', () => {
    const config: LivePreviewConfig = { resolveImage: () => [] };
    const set = revealDecorations(state('![gone](missing.pdf)\n\nend', 3), config);
    expect(classesOf(set).length).toBeGreaterThan(0);
    expect(widgets(set).find((d) => d.deco.spec['widget'] instanceof PdfPreviewWidget)).toBeUndefined();
  });

  it('reveals an inline image at paragraph granularity (container + mirror)', () => {
    const doc = 'see ![a](b.png) here\n\nend';
    const set = revealDecorations(state(doc, doc.indexOf('b.png')), passThrough);
    expect(classesOf(set).length).toBeGreaterThan(0);
    expect(previewOf(set)).toBeDefined();
  });

  it('never reveals inside frontmatter', () => {
    const doc = '---\ncover: ![x](y.png)\n---\n\ntext';
    expect(widgets(revealDecorations(state(doc), passThrough))).toHaveLength(0);
  });
});

describe('wikilink media embeds ![[...]] (milestone 31)', () => {
  const DOC = 'pre\n\n![[Pasted image 1.png]]\n\nend';

  it('replaces an image-target embed with an ImageWidget over the whole span', () => {
    const all = widgets(blockDecorations(state(DOC, 0), passThrough));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as ImageWidget;
    expect(widget).toBeInstanceOf(ImageWidget);
    expect(widget.srcs).toEqual(['Pasted image 1.png']);
    expect(widget.alt).toBe('');
    expect(DOC.slice(all[0].from, all[0].to)).toBe('![[Pasted image 1.png]]');
  });

  it('keeps the raw markup while the selection touches the embed', () => {
    const at = DOC.indexOf('![[Pasted') + 2;
    expect(widgets(blockDecorations(state(DOC, at), passThrough))).toHaveLength(0);
  });

  it('a size-only alias is the width, not alt text', () => {
    const w = widgets(blockDecorations(state('![[pic.png|300]]\n\nend'), passThrough));
    const widget = w[0].deco.spec['widget'] as ImageWidget;
    expect(widget.alt).toBe('');
    expect(widget.width).toBe(300);
  });

  it('an alias with text becomes the alt text', () => {
    const w = widgets(blockDecorations(state('![[pic.png|a boat]]\n\nend'), passThrough));
    expect((w[0].deco.spec['widget'] as ImageWidget).alt).toBe('a boat');
  });

  it('replaces a pdf-target embed with a PdfWidget', () => {
    const all = widgets(blockDecorations(state('![[attachments/spec.pdf]]\n\nend'), passThrough));
    expect(all).toHaveLength(1);
    expect(all[0].deco.spec['widget']).toBeInstanceOf(PdfWidget);
  });

  it('leaves note links, anchors and code spans alone', () => {
    const notes = '[[Some note]]\n\n![[Note#Heading]]\n\n`![[pic.png]]`\n\nend';
    expect(widgets(blockDecorations(state(notes, 0), passThrough))).toHaveLength(0);
  });
});
