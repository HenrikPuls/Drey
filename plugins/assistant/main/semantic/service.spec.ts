import { DEFAULT_SEMANTIC_MODEL } from '../../shared/semantic.js';
import type { SemanticSectionHit } from '../../../../shared/plugin-api';
import { SemanticService, type SemanticDeps } from './service';

/**
 * The deterministic fake embedder: a text carrying `NEAR` (any case)
 * embeds to [1, 0], everything else to [0, 1]. Cosine against a `NEAR`
 * query then separates "near" sections (1) from the rest (0) — enough
 * to rank and to see the minScore floor.
 */
const QUERY_NEAR = 'near';
function fakeVec(text: string): Float32Array {
  return text.toLowerCase().includes(QUERY_NEAR) ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]);
}

function makeDeps(files: Map<string, Map<string, string>>): SemanticDeps {
  return {
    listVaults: async () => [
      { id: 'va', name: 'Alpha', active: false },
      { id: 'vb', name: 'Beta', active: true },
    ],
    readVaultText: async (vaultId, p) => files.get(vaultId)?.get(p) ?? null,
    listMarkdownFiles: async (vaultId) => [...(files.get(vaultId)?.keys() ?? [])],
    getConfig: async <T,>(key: string) =>
      key === 'semantic.enabled' ? (true as T) : (undefined as T | undefined),
    emit: () => undefined,
    log: () => undefined,
    dataDir: '/tmp/drey-spec',
    workerPath: '/tmp/drey-spec/worker.js',
    modelCacheDir: '/tmp/drey-spec/models',
    embedderFactory: () => ({
      embed: async (texts) => texts.map(fakeVec),
      changeModel: () => undefined,
      dispose: () => undefined,
    }),
  };
}

function note(sections: string[]): string {
  return sections.join('\n\n');
}

async function builtService(files: Map<string, Map<string, string>>): Promise<SemanticService> {
  const service = new SemanticService(makeDeps(files));
  await service.refreshConfig();
  await service.catchUpAll();
  return service;
}

describe('SemanticService.search — the SDK seam (1.18)', () => {
  it('ranks across the requested scope, stamps vault ids and hydrates text', async () => {
    const files = new Map([
      ['va', new Map([['a.md', note(['# Near', 'NEAR alpha section text'])]])],
      ['vb', new Map([['a.md', note(['# Far', 'unrelated beta text'])]])],
    ]);
    const service = await builtService(files);
    const hits = await service.search(`query about ${QUERY_NEAR}`, { kind: 'all' });
    // Both vaults were in scope, but only the similar section clears the
    // default 0.3 score floor — ranking, not scoping, keeps it out.
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({
      vaultId: 'va',
      path: 'a.md',
      heading: 'Near',
      line: 1,
      score: 1,
    } satisfies Partial<SemanticSectionHit>);
    expect(hits[0].text).toContain('NEAR alpha');
    expect(hits[0].snippet).toBe('NEAR alpha section text');
  });

  it('scope omitted → the active vault only; one vault → exactly it', async () => {
    const files = new Map([
      ['va', new Map([['a.md', note(['# Near', `NEAR ${QUERY_NEAR} text`])]])],
      ['vb', new Map([['b.md', note(['# Also near', `NEAR ${QUERY_NEAR} text`])]])],
    ]);
    const service = await builtService(files);
    expect((await service.search(`about ${QUERY_NEAR}`)).map((h) => h.path)).toEqual(['b.md']);
    expect(
      (await service.search(`about ${QUERY_NEAR}`, { kind: 'vault', vaultId: 'va' })).map(
        (h) => h.path,
      ),
    ).toEqual(['a.md']);
  });

  it('the limit defaults above topK and caps at the SDK maximum', async () => {
    const sections = Array.from({ length: 30 }, (_, i) => `# S${i}\nNEAR ${QUERY_NEAR} ${i}`);
    const files = new Map([['vb', new Map([['big.md', note(sections)]])]]);
    const service = await builtService(files);
    expect((await service.search(`about ${QUERY_NEAR}`)).length).toBe(12);
    expect((await service.search(`about ${QUERY_NEAR}`, undefined, 3)).length).toBe(3);
    expect((await service.search(`about ${QUERY_NEAR}`, undefined, 99)).length).toBe(20);
  });

  it('keeps the chat notes out of the browse results like out of retrieval', async () => {
    const files = new Map([
      ['vb', new Map([['chats/c.md', note(['# Near', `NEAR ${QUERY_NEAR} chat`])]])],
    ]);
    const service = await builtService(files);
    expect(await service.search(`about ${QUERY_NEAR}`)).toEqual([]);
  });

  it('falls back to the section above when the file shifted under the index', async () => {
    const files = new Map([
      ['vb', new Map([['a.md', note(['# One', 'one body', '# Two', `NEAR ${QUERY_NEAR} text`])]])],
    ]);
    const service = await builtService(files);
    // The indexed hit sits at the (now gone) `# Two` section start — line 3
    // no longer starts a section, so hydration takes the last one above.
    files
      .get('vb')
      ?.set('a.md', note(['# One', 'one body', 'the heading below became plain text']));
    const hits = await service.search(`about ${QUERY_NEAR}`);
    expect(hits.length).toBe(1);
    expect(hits[0].heading).toBe('One');
    expect(hits[0].text).toContain('became plain text');
  });

  it('returns [] while disabled — the provider should be unregistered then anyway', async () => {
    const deps = makeDeps(new Map([['vb', new Map([['a.md', note(['# Near', 'NEAR text'])]])]]));
    deps.getConfig = async <T,>(key: string) =>
      key === 'semantic.enabled' ? (false as T) : (undefined as T | undefined);
    const service = new SemanticService(deps);
    await service.refreshConfig();
    expect(await service.search('anything')).toEqual([]);
  });

  it('uses the configured minScore floor (default 0.3 drops orthogonal hits)', async () => {
    const files = new Map([
      ['vb', new Map([['a.md', note(['# Off topic', 'nothing matching the question'])]])],
    ]);
    const service = await builtService(files);
    expect(await service.search(`about ${QUERY_NEAR}`)).toEqual([]);
  });
});

/** Lets fire-and-forget background rebuilds settle (all fake deps are instant). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('SemanticService — the explore engines (ADR-0069)', () => {
  it('searchScoped resolves a custom SUBSET (both vaults), not just one', async () => {
    const files = new Map([
      ['va', new Map([['a.md', note(['# Near', `NEAR ${QUERY_NEAR} alpha`])]])],
      ['vb', new Map([['b.md', note(['# Also near', `NEAR ${QUERY_NEAR} beta`])]])],
    ]);
    const service = await builtService(files);
    expect(
      (await service.searchScoped(`about ${QUERY_NEAR}`, 'custom', ['va', 'vb'])).map(
        (h) => h.path,
      ),
    ).toEqual(['a.md', 'b.md']);
    const onlyBeta = await service.searchScoped(`about ${QUERY_NEAR}`, 'custom', ['vb']);
    expect(onlyBeta.map((h) => h.path)).toEqual(['b.md']);
    expect(onlyBeta[0].vault).toBe('Beta');
  });

  it('searchScoped stays empty while disabled, like retrieve', async () => {
    const deps = makeDeps(new Map([['va', new Map([['a.md', note(['# Near', 'NEAR text'])]])]]));
    deps.getConfig = async <T,>(key: string) =>
      key === 'semantic.enabled' ? (false as T) : (undefined as T | undefined);
    const service = new SemanticService(deps);
    await service.refreshConfig();
    expect(await service.searchScoped('anything', 'vault', [])).toEqual([]);
    expect(await service.outline('vault', [])).toEqual([]);
  });

  it('outline lists indexed headings; a cold vault falls back to file names', async () => {
    const files = new Map([
      ['va', new Map([['a.md', note(['# One', 'one body', '# Two', 'two body'])]])],
      ['vb', new Map([['b.md', note(['# Beta', 'NEAR text'])]])],
    ]);
    const service = new SemanticService(makeDeps(files));
    await service.refreshConfig();
    await service.rebuildVault('vb'); // va stays cold
    const rows = await service.outline('all', []);
    const beta = rows.find((row) => row.vaultId === 'vb');
    const alpha = rows.find((row) => row.vaultId === 'va');
    expect(beta).toMatchObject({ path: 'b.md', headings: ['Beta'], vault: 'Beta' });
    expect(alpha).toMatchObject({ path: 'a.md', headings: [] });
    // The cold vault's fallback kicked its background rebuild.
    await flush();
    const status = await service.status();
    expect(status.vaults.find((vault) => vault.id === 'va')?.sections).toBe(2);
  });

  it('readSection picks by heading (case-insensitive), line, or the first section', async () => {
    const files = new Map([
      [
        'va',
        new Map([['a.md', note(['# Intro', 'hello', '# Deep Dive', 'NEAR details', '# Wrap', 'bye'])]]),
      ],
    ]);
    const service = await builtService(files);
    expect(await service.readSection('va', 'missing.md', {})).toBeNull();
    expect(await service.readSection('va', 'empty.md', {})).toBeNull();
    const byHeading = await service.readSection('va', 'a.md', { heading: 'deep dive' });
    expect(byHeading).toMatchObject({ heading: 'Deep Dive', line: 5, text: 'NEAR details' });
    const byLine = await service.readSection('va', 'a.md', { line: 9 });
    expect(byLine).toMatchObject({ heading: 'Wrap', text: 'bye' });
    const first = await service.readSection('va', 'a.md', {});
    expect(first).toMatchObject({ heading: 'Intro', text: 'hello' });
  });

  it('a retrieval over a cold vault self-heals: empty this round, indexed the next', async () => {
    const files = new Map([
      ['va', new Map([['a.md', note(['# Near', `NEAR ${QUERY_NEAR} alpha`])]])],
    ]);
    const service = new SemanticService(makeDeps(files));
    await service.refreshConfig();
    // No catch-up ran — the index is cold.
    const first = await service.retrieve(`about ${QUERY_NEAR}`, 'custom', ['va']);
    expect(first.enabled).toBe(true);
    expect(first.hits).toEqual([]);
    expect(first.targets).toEqual(['va']);
    await flush();
    const second = await service.retrieve(`about ${QUERY_NEAR}`, 'custom', ['va']);
    expect(second.hits).toHaveLength(1);
    expect(second.hits[0]).toMatchObject({ vaultId: 'va', heading: 'Near' });
  });

  it('resolveTargets mirrors the scope resolver (the explore tools read guard)', async () => {
    const files = new Map([['va', new Map([['a.md', note(['# Near', 'NEAR text'])]])]]);
    const service = await builtService(files);
    expect(await service.resolveTargets('vault', [])).toEqual(['vb']);
    expect(await service.resolveTargets('custom', ['va', 'ghost'])).toEqual(['va']);
  });
});
