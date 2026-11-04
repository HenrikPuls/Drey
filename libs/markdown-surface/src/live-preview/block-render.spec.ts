import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, Extension, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { extendedMarkdown } from '../markdown-extensions';
import {
  blockDecorations,
  LivePreviewConfig,
  livePreviewBlocks,
  revealDecorations,
} from './block-render';
import { MathWidget } from './math-widget';
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
    extensions: [
      markdown({
        base: markdownLanguage,
        // The surface's exact grammar: built-in Emoji out, curated one in.
        extensions: [{ remove: ['Emoji'] }, ...extendedMarkdown],
      }),
    ],
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

  it('ends the widget at the last pipe row when a paragraph follows without a blank line', () => {
    // lezer-markdown absorbs every following paragraph line into the Table
    // node -- without the clamp a Backspace on the blank line would turn
    // the paragraph into table rows inside the widget.
    const doc = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\ncx\nWas bleibt?\n\nend';
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    const widget = all[0].deco.spec['widget'] as TableWidget;
    expect(widget.html).toContain('<td>1</td>');
    expect(widget.html).not.toContain('cx');
    expect(doc.slice(all[0].from, all[0].to)).toBe('| a | b |\n| - | - |\n| 1 | 2 |');
    // A caret on the line glued to the table (no blank line) keeps the
    // widget rendered -- only the table's own rows reveal the raw source.
    const atGlue = doc.indexOf('cx');
    expect(widgets(blockDecorations(state(doc, atGlue), passThrough))).toHaveLength(1);
    expect(widgets(revealDecorations(state(doc, atGlue), passThrough))).toHaveLength(0);
    const apart = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ncx';
    const atApart = apart.indexOf('cx');
    expect(widgets(blockDecorations(state(apart, atApart), passThrough))).toHaveLength(1);
    expect(widgets(revealDecorations(state(apart, atApart), passThrough))).toHaveLength(0);
  });

  it('still renders a header-only table after the clamp', () => {
    const doc = 'intro\n\n| a | b |\n| - | - |\n\ntext';
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    expect((all[0].deco.spec['widget'] as TableWidget).source).toBe('| a | b |\n| - | - |');
  });

  it('view mode keeps the widget even while the selection touches it', () => {
    // `revealSelection: false` -- the read-only view mode: the embed stays
    // a rendered atom and no reveal layer is built, wherever the caret sits.
    const doc = `intro\n\n${TABLE}\n\nend`;
    const s = state(doc, doc.indexOf('| 1 |') + 2);
    const opts = { revealSelection: false } as const;
    expect(widgets(blockDecorations(s, passThrough, opts))).toHaveLength(1);
    expect(widgets(revealDecorations(s, passThrough, opts))).toHaveLength(0);
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

describe('tables glued after an absorbed text line', () => {
  // lezer-markdown absorbs the text line AND the following table into ONE
  // `Table` node; the clamp ends the first widget, the second half must
  // render as its own embed.
  const GLUED = 'mm\n| a | b |\n| - | - |\n| 1 | 2 |\nmm\n| c | d |\n| - | - |\n| 3 | 4 |';
  const FIRST = '| a | b |\n| - | - |\n| 1 | 2 |';
  const SECOND = '| c | d |\n| - | - |\n| 3 | 4 |';

  it('renders the second glued table as its own widget beyond the clamp', () => {
    const all = widgets(blockDecorations(state(GLUED, 0), passThrough));
    expect(all).toHaveLength(2);
    expect(GLUED.slice(all[0].from, all[0].to)).toBe(FIRST);
    expect(GLUED.slice(all[1].from, all[1].to)).toBe(SECOND);
    const widget = all[1].deco.spec['widget'] as TableWidget;
    expect(widget.html).toContain('<td>3</td>');
    // markdown-it's trailing newline would render as a phantom empty line
    // inside the widget (pre-wrap content) -- trimmed away.
    expect(widget.html.endsWith('\n')).toBeFalsy();
  });

  it('reveals only the second table while the selection touches it', () => {
    const inSecond = GLUED.indexOf('| 3 |') + 2;
    const blocks = widgets(blockDecorations(state(GLUED, inSecond), passThrough));
    expect(blocks).toHaveLength(1);
    expect(GLUED.slice(blocks[0].from, blocks[0].to)).toBe(FIRST);
    const reveal = widgets(revealDecorations(state(GLUED, inSecond), passThrough));
    const lineDecos = reveal.filter((d) => typeof d.deco.spec['class'] === 'string');
    expect(lineDecos).toHaveLength(3);
    expect(lineDecos[0].from).toBe(GLUED.indexOf('| c |'));
  });

  it('a caret on the glued text line keeps both tables rendered', () => {
    const atGlue = GLUED.lastIndexOf('mm');
    expect(widgets(blockDecorations(state(GLUED, atGlue), passThrough))).toHaveLength(2);
    expect(widgets(revealDecorations(state(GLUED, atGlue), passThrough))).toHaveLength(0);
  });

  it('keeps absorbed pipe rows that have no delimiter row raw', () => {
    const doc = `mm\n${FIRST}\nmm\n| x |\n| y |`;
    expect(widgets(blockDecorations(state(doc, 0), passThrough))).toHaveLength(1);
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

describe('deletion grace (Backspace holds the table open)', () => {
  const DOC = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nend';
  const ROW = '| 1 | 2 |';

  // The grace lives in the StateField's update (it reads the transaction's
  // userEvent), so the assertions must read the FIELD, not recompute the
  // pure decoration functions.
  const extensions = livePreviewBlocks(passThrough) as unknown as [
    StateField<{ atoms: DecorationSet; reveal: DecorationSet }>,
    ...Extension[],
  ];
  const field = extensions[0];
  const atomWidgets = () => widgets(view!.state.field(field).atoms);
  const revealDecorated = () => widgets(view!.state.field(field).reveal);

  let view: EditorView | undefined;
  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  function makeView(anchor: number): void {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: DOC,
        selection: { anchor },
        extensions: [markdown({ base: markdownLanguage }), extensions],
      }),
    });
  }

  function backspace(from: number, to: number): void {
    view!.dispatch({
      changes: { from, to },
      selection: { anchor: from },
      userEvent: 'delete.backward',
    });
  }

  it('a deletion that empties the last row keeps the table revealed', () => {
    // the emptied line leaves the paragraph, the extent retracts past the
    // caret -- the grace must hold the reveal where the touch test would
    // already show the widget again
    const at = DOC.indexOf(ROW);
    makeView(at + 2);
    backspace(at, at + ROW.length);
    expect(atomWidgets()).toHaveLength(0);
    expect(revealDecorated().length).toBeGreaterThan(0);
  });

  it('a second deletion holds it, the first non-deletion change hands back', () => {
    const at = DOC.indexOf(ROW);
    makeView(at + 2);
    backspace(at, at + ROW.length);
    backspace(at, at + 1); // one of the blank newlines
    expect(atomWidgets()).toHaveLength(0);
    view!.dispatch({
      changes: { from: at, insert: 'x' },
      selection: { anchor: at + 1 },
      userEvent: 'input.type',
    });
    expect(atomWidgets()).toHaveLength(1);
    expect(revealDecorated()).toHaveLength(0);
  });

  it('a deletion away from the table changes nothing', () => {
    const at = DOC.indexOf('end') + 1;
    makeView(at);
    backspace(at, at + 1);
    expect(atomWidgets()).toHaveLength(1);
    expect(revealDecorated()).toHaveLength(0);
  });
});

describe('blockDecorations math (milestone 71)', () => {
  it('replaces a $$ display block with a KaTeX block widget', () => {
    const doc = 'intro\n\n$$\nE=mc^2\n$$\n\nend';
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    expect(all[0].deco.spec['block']).toBe(true);
    const widget = all[0].deco.spec['widget'] as MathWidget;
    expect(widget).toBeInstanceOf(MathWidget);
    expect(widget.latex).toBe('E=mc^2');
    expect(widget.display).toBe(true);
  });

  it('extracts the body of a compact one-line block', () => {
    const doc = 'intro\n\n$$ x = 1 $$\n\nend';
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect((all[0].deco.spec['widget'] as MathWidget).latex).toBe(' x = 1 ');
  });

  it('replaces inline $…$ with the inline widget, revealed on touch', () => {
    const doc = 'value $x^2$ here';
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    expect(all).toHaveLength(1);
    expect(all[0].deco.spec['block']).toBeUndefined();
    const widget = all[0].deco.spec['widget'] as MathWidget;
    expect(widget.latex).toBe('x^2');
    expect(widget.display).toBe(false);
    expect(all[0].from).toBe(6);

    const inside = doc.indexOf('x^2');
    expect(widgets(blockDecorations(state(doc, inside), passThrough))).toHaveLength(0);
  });

  it('renders extended inline syntax inside table cells', () => {
    const doc = `intro\n\n| a | b |\n| - | - |\n| ==mark== | H~2~O :joy: |\n\nend`;
    const all = widgets(blockDecorations(state(doc, 0), passThrough));
    const widget = all[0].deco.spec['widget'] as TableWidget;
    expect(widget.html).toContain('<mark>mark</mark>');
    expect(widget.html).toContain('H<sub>2</sub>O');
    expect(widget.html).toContain('😂');
    // Math inside a cell renders as the styled source span (no KaTeX copy
    // rides the table render).
    const mathDoc = `intro\n\n| a |\n| - |\n| $x^2$ |\n\nend`;
    const mathWidget = widgets(blockDecorations(state(mathDoc, 0), passThrough))[0]
      .deco.spec['widget'] as TableWidget;
    expect(mathWidget.html).toContain('drey-math-src');
  });
});
