import { collectTagEntries, formatRegistry, ScannedFile } from '../../../shared/tag-registry';
import { Frontmatter } from '../../../shared/ipc-api';

function fm(partial: Partial<Frontmatter>): Frontmatter {
  return {
    type: null,
    title: null,
    tags: [],
    aliases: [],
    created: null,
    updated: null,
    art: null,
    description: null,
    verweis: null,
    ...partial,
  };
}

describe('collectTagEntries', () => {
  const files: ScannedFile[] = [
    {
      path: 'sailing/_index.md',
      frontmatter: fm({
        type: 'master',
        tags: ['sailing'],
        aliases: ['boot', 'boat'],
        art: 'thema',
        description: 'Kaufprozess fürs neue Boot',
      }),
    },
    {
      path: 'sailing/besichtigung.md',
      frontmatter: fm({ type: 'notiz', tags: ['sailing', 'kiel'] }),
    },
    { path: 'partner.md', frontmatter: fm({ type: 'master', tags: ['partner'], art: 'person' }) },
    { path: 'loose.md', frontmatter: null },
  ];

  it('lists every tag ever seen, sorted, with master metadata attached', () => {
    const { tags } = collectTagEntries(files);
    expect(tags.map((t) => t.tag)).toEqual(['kiel', 'partner', 'sailing']);

    const sailing = tags.find((t) => t.tag === 'sailing')!;
    expect(sailing.hasMaster).toBe(true);
    expect(sailing.masterPath).toBe('sailing/_index.md');
    expect(sailing.art).toBe('thema');
    expect(sailing.aliases).toEqual(['boot', 'boat']);

    const kiel = tags.find((t) => t.tag === 'kiel')!;
    expect(kiel.hasMaster).toBe(false);
    expect(kiel.masterPath).toBeNull();
  });

  it('puts only masters with art AND description in the registry', () => {
    const { registry } = collectTagEntries(files);
    expect(registry).toEqual([
      {
        tag: 'sailing',
        art: 'thema',
        description: 'Kaufprozess fürs neue Boot',
        path: 'sailing/_index.md',
      },
    ]);
  });

  it('formatRegistry renders the classifier prompt lines', () => {
    const { registry } = collectTagEntries(files);
    expect(formatRegistry(registry)).toBe('- sailing (thema): Kaufprozess fürs neue Boot');
  });
});
