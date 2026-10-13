import { noteRelativeLink } from './note-link';

describe('noteRelativeLink', () => {
  it('walks up to a sibling directory', () => {
    expect(noteRelativeLink('projects/foo.md', 'assets/logo.png')).toBe('../assets/logo.png');
  });

  it('is the bare filename when the asset is in the note directory', () => {
    expect(noteRelativeLink('projects/foo.md', 'projects/logo.png')).toBe('logo.png');
  });

  it('descends into a subfolder of the note directory', () => {
    expect(noteRelativeLink('a/foo.md', 'a/b/c/logo.png')).toBe('b/c/logo.png');
  });

  it('returns the target unchanged for a note at the vault root', () => {
    expect(noteRelativeLink('foo.md', 'assets/logo.png')).toBe('assets/logo.png');
  });

  it('climbs one level for a root asset from a nested note', () => {
    expect(noteRelativeLink('a/foo.md', 'logo.png')).toBe('../logo.png');
  });

  it('handles deep divergence', () => {
    expect(noteRelativeLink('a/b/foo.md', 'c/d/logo.png')).toBe('../../c/d/logo.png');
    expect(noteRelativeLink('a/b/c/foo.md', 'a/x.png')).toBe('../../x.png');
  });

  it('keeps a common prefix', () => {
    expect(noteRelativeLink('a/b/foo.md', 'a/assets/logo.png')).toBe('../assets/logo.png');
  });

  it('round-trips: joining the result on the note dir collapses back to the asset path', () => {
    const cases: Array<[string, string]> = [
      ['projects/foo.md', 'assets/logo.png'],
      ['a/b/c/foo.md', 'a/x.png'],
      ['a/foo.md', 'a/b/c/logo.png'],
      ['foo.md', 'deep/nested/pic.png'],
    ];
    for (const [note, asset] of cases) {
      const rel = noteRelativeLink(note, asset);
      const dir = note.includes('/') ? note.slice(0, note.lastIndexOf('/')) : '';
      const joined = normalize(dir ? `${dir}/${rel}` : rel);
      expect(joined).toBe(asset);
    }
  });
});

/** Mirror of `vault-image.ts` `normalizeRelative` for the round-trip check. */
function normalize(pathStr: string): string {
  const out: string[] = [];
  for (const seg of pathStr.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
