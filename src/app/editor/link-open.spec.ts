import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { linkTargetDecorations, resolveVaultLinkPath } from './link-open';

function links(doc: string): { from: number; to: number; href: string }[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, codeLanguages: languages })],
  });
  const set: DecorationSet = linkTargetDecorations(state, [{ from: 0, to: state.doc.length }]);
  const out: { from: number; to: number; href: string }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    const attrs = deco.spec['attributes'] as Record<string, string>;
    out.push({ from, to, href: attrs['data-href'] });
  });
  return out;
}

describe('linkTargetDecorations', () => {
  it('marks a [label](url) link with its destination', () => {
    const [hit] = links('see [the docs](https://example.com/x) here');
    expect(hit.href).toBe('https://example.com/x');
    // spans the whole [..](..) construct
    expect('see [the docs](https://example.com/x) here'.slice(hit.from, hit.to)).toBe(
      '[the docs](https://example.com/x)',
    );
  });

  it('marks an <autolink>', () => {
    expect(links('mail <https://drey.example> ok').map((l) => l.href)).toEqual([
      'https://drey.example',
    ]);
  });

  it('marks a bare GFM url', () => {
    expect(links('go to https://drey.example/docs now').map((l) => l.href)).toEqual([
      'https://drey.example/docs',
    ]);
  });

  it('marks a vault-relative link target', () => {
    expect(links('[notes](../notes/plan.md)').map((l) => l.href)).toEqual(['../notes/plan.md']);
  });

  it('does not mark an image', () => {
    expect(links('![alt](pic.png)')).toEqual([]);
  });

  it('does not mark a link inside a fenced code block', () => {
    expect(links('```\n[x](https://y)\n```\n')).toEqual([]);
  });
});

describe('resolveVaultLinkPath', () => {
  it('resolves a relative path against the open note folder', () => {
    expect(resolveVaultLinkPath('daily/2026/09/2026-09-08.md', '../../notes/plan.md')).toBe(
      'daily/notes/plan.md',
    );
  });

  it('adds .md when the target has no extension', () => {
    expect(resolveVaultLinkPath('notes/index.md', 'plan')).toBe('notes/plan.md');
  });

  it('drops a #anchor / ?query suffix', () => {
    expect(resolveVaultLinkPath('notes/index.md', 'plan.md#section')).toBe('notes/plan.md');
  });

  it('returns null for a web url, an explicit scheme or a bare #anchor', () => {
    expect(resolveVaultLinkPath('a.md', 'https://example.com')).toBeNull();
    expect(resolveVaultLinkPath('a.md', 'mailto:x@y.z')).toBeNull();
    expect(resolveVaultLinkPath('a.md', '#heading')).toBeNull();
  });

  it('returns null when the path climbs above the vault root', () => {
    expect(resolveVaultLinkPath('a.md', '../../../etc/passwd')).toBeNull();
  });
});
