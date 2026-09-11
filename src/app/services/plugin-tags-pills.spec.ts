import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import { tagPillDecorations } from '../../../plugins/tags/renderer/extensions';
import { HOST_CODEMIRROR } from '../plugin-host';

/**
 * The tags plugin's pill decorations (port of the old tag-pill.spec — the
 * implementation moved to `plugins/tags/renderer/extensions.ts`). The
 * syntax-tree check runs against a real Markdown parse, so fenced/inline
 * code cases are covered for real.
 */
function pills(doc: string): { from: number; to: number; tag: string }[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const insideCode = (s: object, pos: number): boolean => {
    interface NodeLike {
      name: string;
      parent: NodeLike | null;
    }
    const language = HOST_CODEMIRROR.language as unknown as {
      syntaxTree(state: object): { resolveInner(pos: number, side: number): NodeLike };
    };
    let node: NodeLike | null = language.syntaxTree(s).resolveInner(pos, 1);
    for (; node !== null; node = node.parent) {
      if (/Code|Comment/.test(node.name)) {
        return true;
      }
    }
    return false;
  };
  const set = tagPillDecorations(
    Decoration as never,
    insideCode,
    state,
    [{ from: 0, to: state.doc.length }],
  ) as DecorationSet;
  const out: { from: number; to: number; tag: string }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    const attrs = deco.spec['attributes'] as Record<string, string>;
    out.push({ from, to, tag: attrs['data-tag'] });
  });
  return out;
}

describe('tagPillDecorations (tags plugin)', () => {
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

  it('spans a nested #parent/child tag as one pill', () => {
    expect(pills('see #projekt/frontend here')).toEqual([
      { from: 4, to: 21, tag: 'projekt/frontend' },
    ]);
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
});
