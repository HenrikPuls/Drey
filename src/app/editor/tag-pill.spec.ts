import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { tagPillDecorations } from './tag-pill';

function pills(doc: string): { from: number; to: number; tag: string }[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const set: DecorationSet = tagPillDecorations(state, [{ from: 0, to: state.doc.length }]);
  const out: { from: number; to: number; tag: string }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    const attrs = deco.spec['attributes'] as Record<string, string>;
    out.push({ from, to, tag: attrs['data-tag'] });
  });
  return out;
}

describe('tagPillDecorations', () => {
  it('marks an inline #tag with its bare name', () => {
    expect(pills('a #sailing note')).toEqual([{ from: 2, to: 10, tag: 'sailing' }]);
  });

  it('marks every occurrence, keeping duplicates', () => {
    expect(pills('#kauf and #kauf again').map((p) => p.tag)).toEqual(['kauf', 'kauf']);
  });

  it('lower-cases the tag but spans the raw text', () => {
    const [p] = pills('see #Rollout done');
    expect(p).toEqual({ from: 4, to: 12, tag: 'rollout' });
  });

  it('never marks the reserved #task marker', () => {
    expect(pills('- #task id:7 ship it')).toEqual([]);
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
});
