import { describe, expect, it } from 'vitest';
import type { SectionSearchScope, TagSearchHit, TagSearchQuery } from '../../../shared/plugin-api';
import { retrieveVaultContext, type VaultContextDeps } from './vault-context';

/**
 * The Vault chip's context lookup (ADR-0072) over a fake section index:
 * one search per word and vault, the ranking, and the reasons for an
 * empty result.
 */

interface Section {
  vaultId: string;
  path: string;
  heading: string;
  line: number;
  text: string;
}

const VAULTS = [
  { id: 'notes', name: 'Notes', active: true },
  { id: 'docs', name: 'Docs', active: false },
];

const SECTIONS: Section[] = [
  { vaultId: 'notes', path: 'physik/relativ.md', heading: 'Relativität', line: 3, text: 'Einstein veröffentlichte 1905 vier Arbeiten.' },
  { vaultId: 'notes', path: 'physik/quanten.md', heading: 'Quanten', line: 1, text: 'Die Physik der kleinsten Teilchen.' },
  { vaultId: 'notes', path: 'physik/quanten.md', heading: 'Leer', line: 9, text: '' },
  { vaultId: 'notes', path: 'chats/2026/10/einstein.md', heading: 'Chat', line: 1, text: 'Was weiß ich über Einstein?' },
  { vaultId: 'notes', path: 'daily/2026-10-01.md', heading: '', line: 1, text: 'Physik gelesen, danach Boot geputzt.' },
  { vaultId: 'docs', path: 'people.md', heading: 'Einstein', line: 5, text: 'Albert Einstein, Physiker.' },
];

function deps(options: { provider?: boolean; calls?: string[] } = {}): VaultContextDeps {
  return {
    listVaults: async () => VAULTS,
    sectionSearch: () =>
      options.provider === false
        ? null
        : {
            search: async (query: TagSearchQuery, scope?: SectionSearchScope) => {
              const vaultId = scope?.kind === 'vault' ? scope.vaultId : 'notes';
              options.calls?.push(`${vaultId}:${query.text}`);
              const term = query.text.toLowerCase();
              return SECTIONS.filter(
                (section) =>
                  section.vaultId === vaultId &&
                  `${section.heading}\n${section.text}`.toLowerCase().includes(term),
              ).map(
                (section): TagSearchHit => ({
                  path: section.path,
                  heading: section.heading,
                  line: section.line,
                  snippet: section.text,
                  text: section.text,
                  vaultId,
                }),
              );
            },
          },
  };
}

describe('retrieveVaultContext', () => {
  it('finds the section that contains the word, and leaves the chat notes out', async () => {
    const outcome = await retrieveVaultContext(deps(), 'Was weiß ich über Einstein?', 'vault');

    expect(outcome.hits.map((hit) => hit.path)).toEqual(['physik/relativ.md']);
    expect(outcome.hits[0]).toMatchObject({
      vaultId: 'notes',
      vault: 'Notes',
      heading: 'Relativität',
      line: 3,
      text: 'Einstein veröffentlichte 1905 vier Arbeiten.',
    });
  });

  it('searches every vault of the scope, one call per word and vault', async () => {
    const calls: string[] = [];
    const outcome = await retrieveVaultContext(deps({ calls }), 'Einstein Physik', 'all');

    expect(calls).toEqual(['notes:einstein', 'docs:einstein', 'notes:physik', 'docs:physik']);
    // Both words, one of them in the heading: the Docs section leads.
    expect(outcome.hits[0]).toMatchObject({ vaultId: 'docs', vault: 'Docs', path: 'people.md' });
    expect(outcome.hits.map((hit) => hit.path)).toContain('physik/relativ.md');
  });

  it('names a section without a heading after its file, and skips one without text', async () => {
    const outcome = await retrieveVaultContext(deps(), 'Boot', 'vault');
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0].heading).toBe('2026-10-01.md');

    const empty = await retrieveVaultContext(deps(), 'Leer', 'vault');
    expect(empty.hits).toEqual([]);
  });

  it('says why nothing came back', async () => {
    expect(await retrieveVaultContext(deps({ provider: false }), 'Einstein', 'vault')).toEqual({
      hits: [],
      unavailable: true,
    });
    expect(await retrieveVaultContext(deps(), 'Einstein', 'custom', ['gone'])).toEqual({
      hits: [],
      noTargets: true,
    });
    expect(await retrieveVaultContext(deps(), 'Zeppelin', 'vault')).toEqual({ hits: [] });
    // A question made of stopwords searches for nothing.
    expect(await retrieveVaultContext(deps(), 'Was ist das?', 'vault')).toEqual({ hits: [] });
  });
});
