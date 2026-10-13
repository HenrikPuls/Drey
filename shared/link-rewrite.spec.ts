import { maskNonText, planRename, relativePath } from './link-rewrite';
import type { RenamePlan } from './link-rewrite';

/** Plans a rename over a vault given as `path -> content` (non-notes: any string). */
function plan(
  vault: Record<string, string>,
  fromRel: string,
  toRel: string,
  targetFiles?: string[],
): RenamePlan {
  const files = Object.keys(vault);
  const contents = new Map(files.filter((p) => p.endsWith('.md')).map((p) => [p, vault[p]]));
  return planRename({ files, fromRel, toRel, contents, targetFiles });
}

function after(result: RenamePlan, path: string): string | undefined {
  return result.patches.find((p) => p.path === path)?.after;
}

describe('planRename -- wikilinks', () => {
  it('rewrites links to a renamed note, keeping anchor, alias and embed', () => {
    const result = plan(
      {
        'Old.md': '',
        'a.md': 'See [[Old]], [[Old#Part|the part]] and ![[Old]].',
      },
      'Old.md',
      'New.md',
    );
    expect(after(result, 'a.md')).toBe('See [[New]], [[New#Part|the part]] and ![[New]].');
    expect(result.patches[0].links).toBe(3);
  });

  it('leaves a bare-name link alone when the note only moves', () => {
    const result = plan({ 'Note.md': '', 'a.md': '[[Note]]' }, 'Note.md', 'archive/Note.md');
    expect(result.patches).toEqual([]);
  });

  it('rewrites a path-form link when the note moves', () => {
    const result = plan(
      { 'proj/Note.md': '', 'a.md': '[[proj/Note]] and [[proj/Note.md]]' },
      'proj/Note.md',
      'archive/Note.md',
    );
    expect(after(result, 'a.md')).toBe('[[archive/Note]] and [[archive/Note.md]]');
  });

  it('follows a folder rename for every note under it', () => {
    const result = plan(
      { 'proj/a.md': '', 'proj/sub/b.md': '', 'x.md': '[[proj/a]] [[proj/sub/b]] [[b]]' },
      'proj',
      'work',
    );
    expect(after(result, 'x.md')).toBe('[[work/a]] [[work/sub/b]] [[b]]');
  });

  it('switches to the path when the new name is ambiguous', () => {
    const result = plan(
      { 'Old.md': '', 'other/Plan.md': '', 'notes/a.md': '[[Old]]' },
      'Old.md',
      'Plan.md',
    );
    // `[[Plan]]` from notes/ would pick the shorter path -- which is the
    // renamed note here, so the bare name still holds.
    expect(after(result, 'notes/a.md')).toBe('[[Plan]]');

    const sibling = plan(
      { 'Old.md': '', 'notes/Plan.md': '', 'notes/a.md': '[[Old]]' },
      'Old.md',
      'Plan.md',
    );
    // A sibling `Plan` would win the bare name: the root note needs its extension.
    expect(after(sibling, 'notes/a.md')).toBe('[[Plan.md]]');
  });

  it('repairs a link whose ambiguity shifts because the LINKING note moved', () => {
    const result = plan(
      { 'a/Plan.md': '', 'b/Plan.md': '', 'a/n.md': '[[Plan]]' },
      'a/n.md',
      'b/n.md',
    );
    expect(after(result, 'a/n.md')).toBe('[[a/Plan]]');
  });

  it('never touches code, frontmatter or unresolved links', () => {
    const content = '---\ntitle: "[[Old]]"\n---\n`[[Old]]`\n```\n[[Old]]\n```\n[[Missing]]';
    const result = plan({ 'Old.md': '', 'a.md': content }, 'Old.md', 'New.md');
    expect(result.patches).toEqual([]);
  });

  it('ignores a case-only rename', () => {
    const result = plan({ 'note.md': '', 'a.md': '[[note]]' }, 'note.md', 'Note.md');
    expect(result.patches).toEqual([]);
  });
});

describe('planRename -- attachments', () => {
  it('moves an attachment only the moved note uses, link untouched', () => {
    const result = plan(
      { 'a/n.md': '![](attachments/x.png) ![[y.png]]', 'a/attachments/x.png': '', 'a/attachments/y.png': '' },
      'a/n.md',
      'b/n.md',
    );
    expect(result.assets).toEqual([
      { kind: 'move', from: 'a/attachments/x.png', to: 'b/attachments/x.png' },
      { kind: 'move', from: 'a/attachments/y.png', to: 'b/attachments/y.png' },
    ]);
    expect(result.patches).toEqual([]);
  });

  it('leaves a shared attachment and rewrites the moved note instead', () => {
    const result = plan(
      {
        'a/n.md': '![pic](attachments/x.png)',
        'a/other.md': '![pic](attachments/x.png)',
        'a/attachments/x.png': '',
      },
      'a/n.md',
      'b/deep/n.md',
    );
    expect(result.assets).toEqual([]);
    expect(after(result, 'a/n.md')).toBe('![pic](../../a/attachments/x.png)');
    expect(after(result, 'a/other.md')).toBeUndefined();
  });

  it('does nothing for a rename inside the same folder', () => {
    const result = plan(
      { 'a/n.md': '![](attachments/x.png)', 'a/attachments/x.png': '' },
      'a/n.md',
      'a/m.md',
    );
    expect(result).toEqual({ patches: [], assets: [] });
  });

  it('keeps a folder move self-contained', () => {
    const result = plan(
      { 'a/n.md': '![](attachments/x.png)', 'a/attachments/x.png': '' },
      'a',
      'b',
    );
    expect(result).toEqual({ patches: [], assets: [] });
  });

  it('rewrites references to a renamed attachment', () => {
    const result = plan(
      { 'n.md': '![a](img/old.png) <img src="img/old.png"> [doc](<img/old.png>)', 'img/old.png': '' },
      'img/old.png',
      'img/new name.png',
    );
    expect(after(result, 'n.md')).toBe(
      '![a](img/new%20name.png) <img src="img/new name.png"> [doc](<img/new name.png>)',
    );
  });

  it('does not overwrite a file already at the destination', () => {
    const result = plan(
      {
        'a/n.md': '![](attachments/x.png)',
        'a/attachments/x.png': '',
        'b/attachments/x.png': '',
      },
      'a/n.md',
      'b/n.md',
    );
    expect(result.assets).toEqual([]);
    expect(after(result, 'a/n.md')).toBe('![](../a/attachments/x.png)');
  });

  it('across vaults moves the exclusive attachment and copies the shared one', () => {
    const result = plan(
      {
        'a/n.md': '![](attachments/x.png) ![](attachments/s.png) [[other]]',
        'a/other.md': '![](attachments/s.png)',
        'a/attachments/x.png': '',
        'a/attachments/s.png': '',
      },
      'a/n.md',
      'inbox/n.md',
      ['inbox/readme.md'],
    );
    expect(result.patches).toEqual([]);
    expect(result.assets).toEqual([
      { kind: 'move', from: 'a/attachments/x.png', to: 'inbox/attachments/x.png' },
      { kind: 'copy', from: 'a/attachments/s.png', to: 'inbox/attachments/s.png' },
    ]);
  });
});

describe('link-rewrite helpers', () => {
  it('relativePath steps up and down', () => {
    expect(relativePath('', 'a/x.png')).toBe('a/x.png');
    expect(relativePath('a', 'a/x.png')).toBe('x.png');
    expect(relativePath('a/b', 'c/x.png')).toBe('../../c/x.png');
  });

  it('maskNonText keeps offsets', () => {
    const text = '---\na: 1\n---\nx `code` y';
    expect(maskNonText(text)).toHaveLength(text.length);
    expect(maskNonText(text).trim()).toBe('x        y');
  });
});
