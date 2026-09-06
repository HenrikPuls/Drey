import {
  bumpUpdated,
  readFrontmatter,
  splitFrontmatter,
  writeFrontmatter,
} from '../../../shared/frontmatter';
import { Frontmatter } from '../../../shared/ipc-api';

describe('splitFrontmatter', () => {
  it('splits a fenced note into yaml and the exact body remainder', () => {
    const text = '---\ntype: notiz\ntags: []\n---\n\n# H\n\ntext\n\n---\n\nmore\n';
    const { yamlText, body, hadFence } = splitFrontmatter(text);
    expect(hadFence).toBe(true);
    expect(yamlText).toBe('type: notiz\ntags: []');
    expect(body).toBe('\n# H\n\ntext\n\n---\n\nmore\n');
  });

  it('treats a --- further down as body, not a fence', () => {
    const text = '# H\n\ntext\n\n---\n\nmore';
    expect(splitFrontmatter(text)).toEqual({ yamlText: null, body: text, hadFence: false });
  });

  it('handles a file that is only frontmatter', () => {
    expect(splitFrontmatter('---\ntags: []\n---')).toEqual({
      yamlText: 'tags: []',
      body: '',
      hadFence: true,
    });
  });
});

describe('readFrontmatter', () => {
  it('normalises every field and keeps unquoted dates as strings', () => {
    const text =
      '---\n' +
      'type: notiz\n' +
      'title: "Boot"\n' +
      'tags: ["sailing", "kiel"]\n' +
      'aliases: []\n' +
      'created: 2026-08-01\n' +
      'updated: "2026-09-05T14:32:00"\n' +
      '---\n\nbody\n';
    expect(readFrontmatter(text)).toEqual<Frontmatter>({
      type: 'notiz',
      title: 'Boot',
      tags: ['sailing', 'kiel'],
      aliases: [],
      created: '2026-08-01',
      updated: '2026-09-05T14:32:00',
      art: null,
      description: null,
      verweis: null,
    });
  });

  it('reads master-only fields and rejects an unknown type/art', () => {
    const text = '---\ntype: master\nart: person\ndescription: "Rolle"\ntags: ["partner"]\n---\n';
    const fm = readFrontmatter(text)!;
    expect(fm.type).toBe('master');
    expect(fm.art).toBe('person');
    expect(fm.description).toBe('Rolle');

    const bogus = readFrontmatter('---\ntype: weird\nart: nope\ntags: []\n---\n')!;
    expect(bogus.type).toBeNull();
    expect(bogus.art).toBeNull();
  });

  it('coerces a bare-string tags value to an array', () => {
    expect(readFrontmatter('---\ntags: sailing\n---\n')!.tags).toEqual(['sailing']);
  });

  it('returns null when there is no frontmatter fence', () => {
    expect(readFrontmatter('# just a note\n')).toBeNull();
  });
});

describe('writeFrontmatter', () => {
  it('adds updated and rewrites tags as a double-quoted flow list, body untouched', () => {
    const text = '---\ntype: notiz\ntags: []\n---\n\n# H\n\n---\n\nmore\n';
    const out = writeFrontmatter(text, {
      tags: ['sailing', 'kiel'],
      updated: '2026-09-06T10:00:00',
    });
    expect(out).toBe(
      '---\n' +
        'type: notiz\n' +
        'tags: ["sailing", "kiel"]\n' +
        'updated: "2026-09-06T10:00:00"\n' +
        '---\n\n# H\n\n---\n\nmore\n',
    );
  });

  it('keeps an unrelated key and a comment across a tags rewrite', () => {
    const text = '---\ntype: notiz\n# keep me\ntags: []\ncreated: "2026-08-01"\n---\nbody\n';
    const out = writeFrontmatter(text, { tags: ['a'] });
    expect(out).toContain('# keep me');
    expect(out).toContain('created: "2026-08-01"');
    expect(out).toContain('tags: ["a"]');
    expect(out.endsWith('---\nbody\n')).toBe(true);
  });

  it('returns the text unchanged when there is no frontmatter fence', () => {
    expect(writeFrontmatter('# just a note\n', { updated: 'x' })).toBe('# just a note\n');
  });
});

describe('bumpUpdated', () => {
  const now = new Date(2026, 8, 6, 10, 0, 0);

  it('sets updated to now and keeps an existing created', () => {
    const fm = { created: '2026-08-01' } as Frontmatter;
    expect(bumpUpdated(fm, now)).toEqual({ updated: '2026-09-06T10:00:00', created: '2026-08-01' });
  });

  it('fills created with today when the file has none', () => {
    expect(bumpUpdated(null, now)).toEqual({
      updated: '2026-09-06T10:00:00',
      created: '2026-09-06',
    });
  });
});
