import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';
import { concealDecorations } from './conceal';
import { BulletWidget, CheckboxWidget, HrWidget } from './widgets';

function state(doc: string, anchor = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ base: markdownLanguage })],
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

  it('replaces task markers with checkbox widgets carrying the checked state', () => {
    const all = build('- [ ] todo\n- [x] done\n\nend');
    const boxes = widgets(all)
      .map((e) => e.deco.spec['widget'])
      .filter((w): w is CheckboxWidget => w instanceof CheckboxWidget);
    expect(boxes.map((w) => w.checked)).toEqual([false, true]);
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
});
