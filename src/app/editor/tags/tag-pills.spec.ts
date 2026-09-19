import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { tagPillDecorationSet } from './tag-pills';

/**
 * The base editor's `#tag` pill decorations (moved from the tags plugin in
 * milestone 33). The syntax-tree check runs against a real Markdown parse,
 * so fenced/inline code cases are covered for real; the color resolver
 * feeds each pill's inline `--tag-hue` custom property.
 */
function pills(
  doc: string,
  colorFor: (tag: string) => string = () => '#c96442',
): { from: number; to: number; tag: string; style: string }[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const set = tagPillDecorationSet({ colorFor }, state, [{ from: 0, to: state.doc.length }]);
  const out: { from: number; to: number; tag: string; style: string }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    const attrs = deco.spec['attributes'] as Record<string, string>;
    out.push({ from, to, tag: attrs['data-tag'], style: attrs['style'] ?? '' });
  });
  return out;
}

describe('tagPillDecorationSet (base editor)', () => {
  it('marks an inline #tag with its bare name', () => {
    expect(pills('a #sailing note').map(({ from, to, tag }) => ({ from, to, tag }))).toEqual([
      { from: 2, to: 10, tag: 'sailing' },
    ]);
  });

  it('marks every occurrence, keeping duplicates', () => {
    expect(pills('#kauf and #kauf again').map((p) => p.tag)).toEqual(['kauf', 'kauf']);
  });

  it('lower-cases the tag but spans the raw text', () => {
    const [p] = pills('see #Rollout done');
    expect(p.tag).toBe('rollout');
    expect(p.from).toBe(4);
    expect(p.to).toBe(12);
  });

  it('never marks the reserved #task marker', () => {
    expect(pills('- #task id:7 ship it')).toEqual([]);
  });

  it('spans a nested #parent/child tag as one pill', () => {
    expect(pills('see #projekt/frontend here').map((p) => p.tag)).toEqual(['projekt/frontend']);
  });

  it('stops a nested tag at a trailing slash', () => {
    expect(pills('done #projekt/ ok').map((p) => p.tag)).toEqual(['projekt']);
  });

  it('ignores a #tag inside an inline code span', () => {
    expect(pills('use `#sailing` literally')).toEqual([]);
  });

  it('ignores a #tag inside a fenced code block', () => {
    expect(pills('```\n#sailing\n```\n')).toEqual([]);
  });

  it('does not treat a ## heading as a tag', () => {
    expect(pills('## 14:32 standup')).toEqual([]);
  });

  it('carries the resolved color as an inline --tag-hue', () => {
    const [p] = pills('a #sailing note', (tag) => (tag === 'sailing' ? '#4f9a90' : '#000000'));
    expect(p.style).toBe('--tag-hue:#4f9a90');
  });

  it('re-marks a tag whose resolved color changed (cache keys on tag + color)', () => {
    const doc = 'a #sailing note';
    const before = pills(doc, () => '#c96442');
    const after = pills(doc, () => '#4f9a90');
    expect(before[0].style).toBe('--tag-hue:#c96442');
    expect(after[0].style).toBe('--tag-hue:#4f9a90');
  });
});
