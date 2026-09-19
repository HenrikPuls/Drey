import { TagIndex } from '../../../plugins/tags/main/tag-index';

/**
 * `TagIndex`, per-vault since milestone 33: one map per registered vault,
 * every heading-delimited section indexed (untagged ones too, so free-text
 * search covers them), scoped search with `vaultId` stamps. The literal
 * `templates/` folder is excluded always, the user-configured one on top.
 */

const FILES: Record<string, string> = {
  'daily/2026/09/2026-09-08.md': '## 08:00 #work\nnote\n',
  'templates/meeting.md': '## Agenda #meeting\nx\n',
  'meta/templates/note.md': '## Draft #snippet\ny\n',
  'notes/real.md': '## Real #keeper\nz\n',
};

const V = 'vault-a';

function makeIndex(files: Record<string, string> = FILES, templatesDir?: () => string): TagIndex {
  const index = new TagIndex((vaultId) => {
    void vaultId;
    return Promise.resolve(Object.keys(files));
  }, templatesDir);
  index.setReadContent((_vaultId, p) => Promise.resolve(files[p] ?? ''));
  return index;
}

const tags = (index: TagIndex): string[] => index.getVocabulary().map((e) => e.tag);

describe('TagIndex templates exclusion', () => {
  it('excludes both the literal templates/ folder and the configured one', async () => {
    const index = makeIndex(FILES, () => 'meta/templates');
    await index.requestRebuild(V);
    expect(tags(index)).toContain('work');
    expect(tags(index)).toContain('keeper');
    expect(tags(index)).not.toContain('meeting'); // literal templates/
    expect(tags(index)).not.toContain('snippet'); // configured meta/templates
  });

  it('falls back to only the literal templates/ folder with no getter', async () => {
    const index = makeIndex(FILES);
    await index.requestRebuild(V);
    expect(tags(index)).not.toContain('meeting');
    expect(tags(index)).toContain('snippet'); // meta/templates is now indexed
  });

  it('drops a file from the index when a save moves it under the configured folder', async () => {
    const index = makeIndex(FILES, () => 'meta/templates');
    await index.requestRebuild(V);
    expect(tags(index)).toContain('keeper');

    index.reindexFile(V, 'meta/templates/moved.md', '## Moved #gone\n');
    expect(tags(index)).not.toContain('gone');
  });
});

describe('TagIndex all-sections indexing (milestone 33)', () => {
  it('indexes untagged sections, so text search finds untagged notes', async () => {
    const index = makeIndex({
      'notes/tagged.md': '## Tagged #alpha\nsharedword here\n',
      'notes/plain.md': '## Plain\nsharedword there\n',
      'notes/none.md': 'nothing findable\n',
    });
    await index.requestRebuild(V);

    const textHits = index.search({ tags: [], text: 'sharedword' }, undefined, V);
    expect(textHits.map((h) => h.path).sort()).toEqual(['notes/plain.md', 'notes/tagged.md']);

    // A tag-only query still requires the tag: the untagged section never
    // satisfies it.
    const tagHits = index.search({ tags: ['alpha'], text: '' }, undefined, V);
    expect(tagHits.map((h) => h.path)).toEqual(['notes/tagged.md']);

    // A heading-less note is one implicit section (pre-heading part).
    const implicit = index.search({ tags: [], text: 'findable' }, undefined, V);
    expect(implicit.map((h) => h.path)).toEqual(['notes/none.md']);
    expect(implicit[0].heading).toBe('none.md'); // base-name fallback
    expect(implicit[0].vaultId).toBe(V);
  });

  it('leaves the vocabulary untouched: untagged sections contribute no tags', async () => {
    const index = makeIndex({ 'notes/plain.md': '## Plain\njust text\n' });
    await index.requestRebuild(V);
    expect(tags(index)).toEqual([]);
    expect(index.search({ tags: [], text: 'just' }, undefined, V)).toHaveLength(1);
  });
});

describe('TagIndex per-vault scoping (milestone 33)', () => {
  const TWO: Record<string, Record<string, string>> = {
    'vault-a': { 'notes/a.md': '## A #one\ncontent-a\n' },
    'vault-b': { 'notes/b.md': '## B #two\ncontent-b\n' },
  };

  function twoVaultIndex(): TagIndex {
    const index = new TagIndex((vaultId) =>
      Promise.resolve(Object.keys(TWO[vaultId] ?? {})),
    );
    index.setReadContent((vaultId, p) => Promise.resolve(TWO[vaultId]?.[p] ?? ''));
    return index;
  }

  it('keeps vault indexes isolated and aggregates the vocabulary', async () => {
    const index = twoVaultIndex();
    await index.requestRebuild('vault-a');
    await index.requestRebuild('vault-b');
    expect(tags(index).sort()).toEqual(['one', 'two']);

    // Scoped: exactly one vault.
    expect(index.search({ tags: [], text: 'content' }, { kind: 'vault', vaultId: 'vault-a' }, null).map((h) => h.path)).toEqual(['notes/a.md']);
    expect(index.search({ tags: [], text: 'content' }, { kind: 'vault', vaultId: 'vault-b' }, null).map((h) => h.path)).toEqual(['notes/b.md']);
  });

  it("scope { kind: 'all' } flattens every vault with vaultId stamps", async () => {
    const index = twoVaultIndex();
    await index.requestRebuild('vault-a');
    await index.requestRebuild('vault-b');
    const hits = index.search({ tags: [], text: 'content' }, { kind: 'all' }, null);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.vaultId !== undefined)).toBe(true);
    expect(hits.map((h) => h.vaultId).sort()).toEqual(['vault-a', 'vault-b']);
  });

  it('omitted scope resolves the active vault at call time', async () => {
    const index = twoVaultIndex();
    await index.requestRebuild('vault-a');
    await index.requestRebuild('vault-b');
    expect(index.search({ tags: [], text: 'content' }, undefined, 'vault-b').map((h) => h.path)).toEqual(['notes/b.md']);
    // Unknown/never-built active vault: no hits, no throw.
    expect(index.search({ tags: [], text: 'content' }, undefined, 'vault-x')).toEqual([]);
    expect(index.search({ tags: [], text: 'content' }, undefined, null)).toEqual([]);
  });

  it('reindexFile / removeFile target only their own vault', async () => {
    const index = twoVaultIndex();
    await index.requestRebuild('vault-a');
    await index.requestRebuild('vault-b');

    index.reindexFile('vault-a', 'notes/new.md', '## New #fresh\n');
    expect(tags(index)).toContain('fresh');
    expect(index.search({ tags: ['fresh'], text: '' }, { kind: 'vault', vaultId: 'vault-b' }, null)).toEqual([]);
    expect(index.search({ tags: ['fresh'], text: '' }, { kind: 'vault', vaultId: 'vault-a' }, null)).toHaveLength(1);

    index.removeFile('vault-a', 'notes/a.md');
    expect(index.search({ tags: [], text: 'content-a' }, { kind: 'vault', vaultId: 'vault-a' }, null)).toEqual([]);
    expect(index.search({ tags: [], text: 'content-b' }, { kind: 'vault', vaultId: 'vault-b' }, null)).toHaveLength(1);
  });

  it('dropVault forgets the vault entirely', async () => {
    const index = twoVaultIndex();
    await index.requestRebuild('vault-a');
    await index.requestRebuild('vault-b');
    index.dropVault('vault-a');
    expect(index.search({ tags: [], text: 'content' }, { kind: 'all' }, null).map((h) => h.vaultId)).toEqual(['vault-b']);
    expect(index.knownVaults()).toEqual(['vault-b']);
  });
});

describe('TagIndex requestRebuild coalescing (per vault)', () => {
  it('collapses concurrent requests into at most one extra sweep', async () => {
    let sweeps = 0;
    let release!: () => void;
    const index = new TagIndex((_vaultId) => {
      sweeps += 1;
      if (sweeps === 1) {
        return new Promise<string[]>((resolve) => {
          release = () => resolve(Object.keys(FILES));
        });
      }
      return Promise.resolve(Object.keys(FILES));
    });
    index.setReadContent((_v, p) => Promise.resolve(FILES[p] ?? ''));

    const first = index.requestRebuild(V);

    await Promise.resolve(); // let the first sweep start (its list call pends)
    expect(sweeps).toBe(1);

    const second = index.requestRebuild(V);
    const third = index.requestRebuild(V);
    release();
    await Promise.all([first, second, third]);
    expect(sweeps).toBe(2); // one extra sweep, not one per request

    await index.requestRebuild(V);
    expect(sweeps).toBe(3);
  });

  it('a save landing during a sweep survives the snapshot swap', async () => {
    let content = '## A #one\n';
    let readGated = false;
    let releaseRead: (() => void) | undefined;
    const index = new TagIndex(() => Promise.resolve(['notes/a.md']));
    index.setReadContent((_v) => {
      if (!readGated) {
        return Promise.resolve(content);
      }
      return new Promise<string>((resolve) => {
        releaseRead = () => resolve(content); // a stale read: disk as of BEFORE the save
      });
    });

    await index.requestRebuild(V); // first sweep: the index knows #one
    expect(tags(index)).toEqual(['one']);

    readGated = true;
    const sweeping = index.requestRebuild(V);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseRead).toBeDefined();
    index.reindexFile(V, 'notes/a.md', '## A #two\n');
    releaseRead?.();
    await sweeping;

    expect(tags(index)).toEqual(['two']);
  });

  it('sweeps of DIFFERENT vaults run independently', async () => {
    let sweeps = 0;
    let release!: () => void;
    const index = new TagIndex((vaultId) => {
      void vaultId;
      sweeps += 1;
      if (sweeps === 1) {
        return new Promise<string[]>((resolve) => {
          release = () => resolve(['notes/a.md']);
        });
      }
      return Promise.resolve(['notes/a.md']);
    });
    index.setReadContent((_v, p) => Promise.resolve(p === 'notes/a.md' ? '## A #one\n' : ''));

    const held = index.requestRebuild('vault-a');
    const other = index.requestRebuild('vault-b');
    await Promise.resolve();
    expect(sweeps).toBe(2); // vault-b's sweep did not queue behind vault-a's held one
    release();
    await Promise.all([held, other]);
  });
});
