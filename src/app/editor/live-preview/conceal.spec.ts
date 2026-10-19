import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';
import { extendedMarkdown } from '../markdown-extensions';
import { calloutFolds, concealDecorations, toggleCalloutFold } from './conceal';
import { BulletWidget, CheckboxWidget, HrWidget } from './widgets';
import { CalloutTitleWidget, EmojiWidget, FootnoteRefWidget } from './extended-widgets';

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
      calloutFolds,
    ],
  });
}

interface Entry {
  from: number;
  to: number;
  deco: Decoration;
}

function entries(set: DecorationSet): Entry[] {
  const out: Entry[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    out.push({ from, to, deco });
  });
  return out;
}

function build(doc: string, anchor = doc.length): Entry[] {
  const s = state(doc, anchor);
  return entries(concealDecorations(s, [{ from: 0, to: s.doc.length }]));
}

/** Plain replacements (concealed marker text): no widget, no class. */
const conceals = (all: Entry[]) =>
  all.filter((e) => e.deco.spec['widget'] === undefined && e.deco.spec['class'] === undefined);
const widgets = (all: Entry[]) => all.filter((e) => e.deco.spec['widget'] !== undefined);
const lineClasses = (all: Entry[]) =>
  all
    .filter((e) => e.deco.spec['class'] !== undefined)
    .map((e) => ({ from: e.from, cls: e.deco.spec['class'] as string }));

describe('concealDecorations', () => {
  it('hides the # marks (and trailing space) of a heading the cursor is not on', () => {
    const all = build('# Title\n\ntext');
    expect(conceals(all)).toEqual([expect.objectContaining({ from: 0, to: 2 })]);
  });

  it('reveals the heading marks while the cursor is on that line', () => {
    const all = build('# Title\n\ntext', 3);
    expect(conceals(all).some((e) => e.from === 0)).toBe(false);
  });

  it('hides the ** around bold text and reveals them when the cursor enters', () => {
    const doc = 'some **bold** text';
    const hidden = conceals(build(doc, 0));
    expect(hidden.map((e) => [e.from, e.to])).toEqual([
      [5, 7],
      [11, 13],
    ]);
    expect(conceals(build(doc, 8))).toEqual([]);
  });

  it('hides inline-code backticks and marks the span with lp-inline-code', () => {
    const all = build('a `code` b', 0);
    expect(conceals(all).map((e) => [e.from, e.to])).toEqual([
      [2, 3],
      [7, 8],
    ]);
    expect(all.some((e) => e.deco.spec['class'] === 'lp-inline-code')).toBe(true);
  });

  it('hides link punctuation and URL but keeps the label', () => {
    const doc = 'see [label](https://x.test) end';
    const hidden = conceals(build(doc, 0));
    // `[`, `]`, `(`, the URL, `)` -- the label chars 5..10 stay untouched.
    expect(hidden.some((e) => e.from < 10 && e.to > 5)).toBe(false);
    expect(hidden.some((e) => e.from === 12 && e.to === 26)).toBe(true);
  });

  it('keeps a URL that IS the link label visible (only the target hides)', () => {
    // What the paste-link flow inserts: `[url](url)`. The label parses as a
    // `URL` node with parent `Link` too -- without the target-only guard
    // the whole link rendered empty.
    const doc = 'see [https://x.test](https://x.test) end';
    const hidden = conceals(build(doc, 0)).map((e) => [e.from, e.to]);
    // The label chars 5..19 stay visible; only the target (21..35) hides.
    expect(hidden.some(([f, t]) => f < 19 && t > 5)).toBe(false);
    expect(hidden).toContainEqual([21, 35]);
  });

  it('never reveals while the selection is ignored (view mode)', () => {
    // `revealSelection: false` -- the read-only view mode: the cursor sits
    // on the heading line yet the marks stay concealed.
    const s = state('# Title\n\ntext', 3);
    const all = entries(
      concealDecorations(s, [{ from: 0, to: s.doc.length }], { revealSelection: false }),
    );
    expect(conceals(all).some((e) => e.from === 0)).toBe(true);
  });

  it('replaces task markers with checkbox widgets carrying the checked state', () => {
    const all = build('- [ ] todo\n- [x] done\n\nend');
    const boxes = widgets(all)
      .map((e) => e.deco.spec['widget'])
      .filter((w): w is CheckboxWidget => w instanceof CheckboxWidget);
    expect(boxes.map((w) => w.checked)).toEqual([false, true]);
  });

  it('strikes the text of a checked task, leaving an open one alone', () => {
    const done = build('- [ ] todo\n- [x] done\n\nend').filter(
      (e) => e.deco.spec['class'] === 'lp-task-done',
    );
    expect(done).toHaveLength(1);
    // "- [x] " is 6 chars into the doc after "- [ ] todo\n" (11) -> text at 17.
    expect(done[0]).toMatchObject({ from: 17, to: 21 });
  });

  it('keeps the strikethrough while the cursor is on the checked line', () => {
    const done = build('- [x] done\n\nend', 8).filter(
      (e) => e.deco.spec['class'] === 'lp-task-done',
    );
    expect(done).toHaveLength(1);
  });

  it('replaces bullets with a • widget, leaving ordered lists alone', () => {
    const all = build('- item\n\n1. first\n\nend');
    const bullets = widgets(all).filter((e) => e.deco.spec['widget'] instanceof BulletWidget);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].from).toBe(0);
  });

  it('renders --- as a rule widget unless the cursor is on its line', () => {
    const doc = 'a\n\n---\n\nb';
    expect(widgets(build(doc, 0)).some((e) => e.deco.spec['widget'] instanceof HrWidget)).toBe(
      true,
    );
    expect(widgets(build(doc, 4)).some((e) => e.deco.spec['widget'] instanceof HrWidget)).toBe(
      false,
    );
  });

  it('hides blockquote marks and stamps quote lines with lp-quote', () => {
    const all = build('> quoted line\n\nend');
    expect(conceals(all).map((e) => [e.from, e.to])).toEqual([[0, 2]]);
    expect(lineClasses(all)).toContainEqual({ from: 0, cls: 'lp-quote' });
  });

  it('hides code fences and stamps the block with lp-code line classes', () => {
    const doc = '```ts\nconst a = 1;\n```\n\nafter';
    const all = build(doc);
    expect(conceals(all).map((e) => [e.from, e.to])).toEqual([
      [0, 5], // ```ts
      [19, 22], // ```
    ]);
    const classes = lineClasses(all).map((l) => l.cls);
    expect(classes).toEqual(['lp-code lp-code-first', 'lp-code', 'lp-code lp-code-last']);
    // The concealed opening line carries the language as a data attribute
    // (painted as a right-hand badge by the theme).
    const first = all.find((e) => e.deco.spec['class'] === 'lp-code lp-code-first');
    expect(
      (first?.deco.spec['attributes'] as Record<string, string> | undefined)?.['data-lang'],
    ).toBe('ts');
  });

  it('reveals the fences while the cursor is anywhere inside the block', () => {
    const all = build('```ts\nconst a = 1;\n```\n\nafter', 10);
    expect(conceals(all)).toEqual([]);
    // The block styling stays either way; the badge does not (the raw
    // ```ts is visible again).
    expect(lineClasses(all).length).toBe(3);
    expect(all.some((e) => e.deco.spec['attributes'] !== undefined)).toBe(false);
  });

  it('leaves frontmatter raw (dimmed) and never conceals inside it', () => {
    const doc = '---\ntype: notiz\n---\n\n# Real heading\n';
    const all = build(doc);
    const fmLines = lineClasses(all).filter((l) => l.cls === 'lp-frontmatter');
    expect(fmLines.map((l) => l.from)).toEqual([0, 4, 16]);
    // No replace decorations inside the frontmatter block...
    expect(conceals(all).every((e) => e.from >= 19)).toBe(true);
    // ...but the heading below it is still concealed.
    expect(conceals(all).some((e) => e.from === 21)).toBe(true);
  });

  it('hides the [[ ]] brackets of a wikilink, keeping the target visible', () => {
    const doc = 'see [[Plan]] now';
    expect(conceals(build(doc, 0)).map((e) => [e.from, e.to])).toEqual([
      [4, 6], // [[
      [10, 12], // ]]
    ]);
  });

  it('reveals the raw wikilink while the selection touches it', () => {
    expect(conceals(build('see [[Plan]] now', 8))).toEqual([]);
  });

  it('shows only the alias of [[target|alias]]', () => {
    const doc = 'see [[notes/Plan#Head|the plan]] end';
    const hidden = conceals(build(doc, 0));
    // `[[` through the `|` (0-based 4..22) plus the closing `]]`.
    expect(hidden.map((e) => [e.from, e.to])).toEqual([
      [4, 22],
      [30, 32],
    ]);
  });

  it('never conceals a wikilink inside code or frontmatter', () => {
    expect(
      conceals(build('a `[[b]]` c', 0)).map((e) => [e.from, e.to]),
    ).toEqual([
      [2, 3],
      [8, 9],
    ]); // just the backticks
    const doc = '---\ntitle: "[[x]]"\n---\n\n[[real]]\n';
    const hidden = conceals(build(doc)).map((e) => [e.from, e.to]);
    // fmEnd is 23: nothing inside the frontmatter block, only [[ and ]]
    // of `[[real]]` at 24.
    expect(hidden).toEqual([
      [24, 26],
      [30, 32],
    ]);
  });

  // -- Extended Markdown (milestone 71) ------------------------------------

  it('hides == around highlighted text and washes it with lp-mark', () => {
    const all = build('a ==b== c', 0);
    expect(conceals(all).map((e) => [e.from, e.to])).toEqual([
      [2, 4],
      [5, 7],
    ]);
    expect(all.some((e) => e.deco.spec['class'] === 'lp-mark')).toBe(true);
  });

  it('conceals subscript and superscript marks and styles the run', () => {
    const sub = build('H~2~O', 0);
    expect(conceals(sub).map((e) => [e.from, e.to])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(sub.some((e) => e.deco.spec['class'] === 'lp-sub')).toBe(true);
    const sup = build('X^2^', 0);
    expect(conceals(sup).map((e) => [e.from, e.to])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(sup.some((e) => e.deco.spec['class'] === 'lp-sup')).toBe(true);
  });

  it('replaces a curated :shortcode: with its emoji glyph', () => {
    const widgetsOf = widgets(build('x :joy: y', 0));
    expect(widgetsOf).toHaveLength(1);
    expect((widgetsOf[0].deco.spec['widget'] as EmojiWidget).glyph).toBe('😂');
    // An unknown name stays raw text (no widget, nothing hidden).
    expect(widgets(build('x :nope: y', 0))).toHaveLength(0);
  });

  it('renders a footnote ref as its superscript number, defs styled', () => {
    const doc = 'claim[^a]\n\n[^a]: the note\n';
    const all = build(doc, 0);
    const ref = widgets(all).find((e) => e.deco.spec['widget'] instanceof FootnoteRefWidget);
    expect(ref?.from).toBe(5);
    expect((ref?.deco.spec['widget'] as FootnoteRefWidget).number).toBe(1);
    expect(lineClasses(all).some((c) => c.cls.includes('lp-footnote-def'))).toBe(true);
    // The def line's label is replaced by the `1.` mark.
    expect(widgets(all).some((e) => e.deco.spec['widget']?.constructor.name === 'FootnoteDefMarkWidget')).toBe(true);
  });

  it('styles callout quote lines and replaces the marker with the title', () => {
    const doc = 'intro\n\n> [!NOTE] Custom title\n> body\n';
    const all = build(doc, 0);
    const classes = lineClasses(all);
    expect(classes.some((c) => c.cls.includes('lp-callout-note'))).toBe(true);
    expect(classes.some((c) => c.cls.includes('lp-callout-first'))).toBe(true);
    expect(classes.some((c) => c.cls.includes('lp-callout-last'))).toBe(true);
    const title = widgets(all).find((e) => e.deco.spec['widget'] instanceof CalloutTitleWidget);
    // A custom title is present: the widget carries the icon only.
    expect(title?.from).toBe(9);
    expect((title?.deco.spec['widget'] as CalloutTitleWidget).label).toBeNull();
  });

  it('a callout without a custom title shows icon and label', () => {
    const all = build('intro\n\n> [!WARNING]\n> careful\n', 0);
    const title = widgets(all).find((e) => e.deco.spec['widget'] instanceof CalloutTitleWidget);
    expect((title?.deco.spec['widget'] as CalloutTitleWidget).label).toBe('Warning');
    expect(lineClasses(all).some((c) => c.cls.includes('lp-callout-warning'))).toBe(true);
  });

  describe('foldable callouts (req-54)', () => {
    const doc = 'intro\n\n> [!QUOTE]- Thinking\n> line one\n> line two\n';
    const titleOf = (all: Entry[]) =>
      widgets(all).find((e) => e.deco.spec['widget'] instanceof CalloutTitleWidget)?.deco.spec[
        'widget'
      ] as CalloutTitleWidget | undefined;
    const foldedLines = (all: Entry[]) =>
      lineClasses(all).filter((c) => c.cls === 'lp-callout-folded').map((c) => c.from);

    it('a `-` callout starts folded: its body lines leave the layout, the title is the sole line', () => {
      const all = build(doc, 0);
      expect(titleOf(all)?.fold).toBe('closed');
      expect(foldedLines(all)).toEqual([doc.indexOf('> line one'), doc.indexOf('> line two')]);
      expect(lineClasses(all).some((c) => c.from === 7 && c.cls.includes('lp-callout-last'))).toBe(true);
    });

    it('a `+` callout starts open; a plain one has no chevron', () => {
      expect(titleOf(build(doc.replace(']-', ']+'), 0))?.fold).toBe('open');
      expect(foldedLines(build(doc.replace(']-', ']+'), 0))).toEqual([]);
      expect(titleOf(build(doc.replace(']-', ']'), 0))?.fold).toBeNull();
    });

    it('a flip recorded in the fold field inverts the default and follows edits above it', () => {
      const s = state(doc, 0);
      const flipped = s.update({ effects: toggleCalloutFold.of(7) }).state;
      expect(titleOf(entries(concealDecorations(flipped, [{ from: 0, to: flipped.doc.length }])))?.fold).toBe('open');
      const shifted = flipped.update({ changes: { from: 0, insert: 'more ' } }).state;
      expect([...shifted.field(calloutFolds)]).toEqual([12]);
      const again = shifted.update({ effects: toggleCalloutFold.of(12) }).state;
      expect(again.field(calloutFolds).size).toBe(0);
    });

    it('the caret inside the body unfolds it while it is there', () => {
      expect(foldedLines(build(doc, doc.indexOf('line one') + 2))).toEqual([]);
    });
  });

  it('a plain blockquote keeps the lp-quote styling', () => {
    const all = build('intro\n\n> just a quote\n', 0);
    expect(lineClasses(all).some((c) => c.cls === 'lp-quote')).toBe(true);
    expect(lineClasses(all).some((c) => c.cls.includes('lp-callout'))).toBe(false);
  });
});
