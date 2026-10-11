import { describe, expect, it } from 'vitest';
import {
  VAULT_FIND_TOOL_NAME,
  VAULT_OVERVIEW_TOOL_NAME,
  VAULT_SECTION_TOOL_NAME,
  createVaultExploreTools,
  type ExplorePorts,
} from './vault-explore-tools';
import type { SemanticOutlineEntry, SemanticSectionText } from './semantic/service';
import type { RetrievedSection } from '../shared/semantic';

/**
 * The vault explore tools (ADR-0069): the scope guard (an out-of-scope
 * vaultId is refused, the default scope passes through), the narrowing
 * switch to a `custom` selection, each tool's result shape against a fake
 * service port, and the never-throw error-as-text rule.
 */

const SCOPE = 'custom' as const;
const IDS = ['va', 'vb'];

function makePorts(
  overrides?: Partial<ExplorePorts>,
): ExplorePorts & { scopedCalls: Array<{ scope: string; ids: readonly string[] }> } {
  const scopedCalls: Array<{ scope: string; ids: readonly string[] }> = [];
  const hit: RetrievedSection = {
    vaultId: 'va',
    vault: 'A',
    path: 'notes/a.md',
    heading: 'Plan',
    line: 3,
    score: 0.8123,
    text: 'The plan text. '.repeat(40),
  };
  return {
    scopedCalls,
    resolveTargets: async () => IDS,
    searchScoped: async (_question, scope, ids) => {
      scopedCalls.push({ scope, ids });
      return [hit];
    },
    outline: async (scope, ids) => {
      scopedCalls.push({ scope, ids });
      const entry: SemanticOutlineEntry = {
        vaultId: 'va',
        vault: 'A',
        path: 'notes/a.md',
        headings: ['Plan', 'Risks'],
      };
      return ids.includes('va') || ids.length === 0 ? [entry] : [];
    },
    readSection: async (vaultId, path) => {
      const section: SemanticSectionText = {
        vaultId,
        path,
        heading: 'Plan',
        line: 3,
        text: 'Full section text.',
      };
      return vaultId === 'va' ? section : null;
    },
    ...overrides,
  };
}

function lines(result: string): Record<string, unknown>[] {
  return result
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createVaultExploreTools', () => {
  it('exposes the three specs and routes by name', async () => {
    const tools = createVaultExploreTools(makePorts(), SCOPE, IDS);
    expect(tools.specs.map((spec) => spec.name)).toEqual([
      VAULT_OVERVIEW_TOOL_NAME,
      VAULT_FIND_TOOL_NAME,
      VAULT_SECTION_TOOL_NAME,
    ]);
    expect(tools.names.size).toBe(3);
    expect(await tools.run('nope', '{}')).toBe('Unknown tool: nope');
  });

  it('vault_overview lists the scoped vaults by default', async () => {
    const ports = makePorts();
    const tools = createVaultExploreTools(ports, SCOPE, IDS);
    const rows = lines(await tools.run(VAULT_OVERVIEW_TOOL_NAME, '{}'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vaultId: 'va', path: 'notes/a.md' });
    expect(ports.scopedCalls[0]).toEqual({ scope: 'custom', ids: ['va', 'vb'] });
  });

  it('refuses an out-of-scope vaultId and narrows through a custom selection', async () => {
    const ports = makePorts();
    const tools = createVaultExploreTools(ports, SCOPE, IDS);
    expect(await tools.run(VAULT_OVERVIEW_TOOL_NAME, '{"vaultId":"ghost"}')).toMatch(
      /out of scope/,
    );
    await tools.run(VAULT_OVERVIEW_TOOL_NAME, '{"vaultId":"vb"}');
    // The narrowing must ask for a custom selection of exactly that id —
    // the resolver ignores the id list under the `all` scope.
    expect(ports.scopedCalls[0]).toEqual({ scope: 'custom', ids: ['vb'] });
  });

  it('vault_find ranks and shapes hits, refusing an empty query', async () => {
    const ports = makePorts();
    const tools = createVaultExploreTools(ports, SCOPE, IDS);
    expect(await tools.run(VAULT_FIND_TOOL_NAME, '{}')).toMatch(/needs a non-empty "query"/);
    const rows = lines(await tools.run(VAULT_FIND_TOOL_NAME, '{"query":"plan"}'));
    expect(rows[0]).toMatchObject({
      vault: 'A',
      vaultId: 'va',
      path: 'notes/a.md',
      heading: 'Plan',
      line: 3,
      score: 0.81,
    });
    expect(String(rows[0]['snippet']).length).toBeGreaterThan(0);
    expect(await tools.run(VAULT_FIND_TOOL_NAME, '{"query":"plan","vaultId":"ghost"}')).toMatch(
      /out of scope/,
    );
  });

  it('vault_section reads through the port and demands a vaultId when ambiguous', async () => {
    const ports = makePorts();
    const tools = createVaultExploreTools(ports, SCOPE, IDS);
    expect(await tools.run(VAULT_SECTION_TOOL_NAME, '{}')).toMatch(/needs a "path"/);
    expect(await tools.run(VAULT_SECTION_TOOL_NAME, '{"path":"notes/a.md"}')).toMatch(
      /"vaultId" is required/,
    );
    const result = await tools.run(
      VAULT_SECTION_TOOL_NAME,
      '{"vaultId":"va","path":"notes/a.md","heading":"plan"}',
    );
    const [head, ...body] = result.split('\n');
    expect(JSON.parse(head as string)).toMatchObject({ vaultId: 'va', heading: 'Plan', line: 3 });
    expect(body.join('\n')).toBe('Full section text.');
    expect(
      await tools.run(VAULT_SECTION_TOOL_NAME, '{"vaultId":"vb","path":"notes/b.md"}'),
    ).toMatch(/No such section/);
    expect(
      await tools.run(VAULT_SECTION_TOOL_NAME, '{"vaultId":"ghost","path":"notes/x.md"}'),
    ).toMatch(/out of scope/);
  });

  it('truncates long section text and caps overview rows with a marker', async () => {
    const longText = 'x'.repeat(5000);
    const ports = makePorts({
      readSection: async (vaultId, path) => ({
        vaultId,
        path,
        heading: 'Big',
        line: 1,
        text: longText,
      }),
      outline: async () =>
        Array.from({ length: 200 }, (_, i) => ({
          vaultId: 'va',
          path: `f/${i}.md`,
          headings: [],
        })) as SemanticOutlineEntry[],
    });
    const tools = createVaultExploreTools(ports, SCOPE, IDS);
    const section = await tools.run(
      VAULT_SECTION_TOOL_NAME,
      '{"vaultId":"va","path":"f/big.md"}',
    );
    expect(section).toContain('…section truncated…');
    const rows = lines(await tools.run(VAULT_OVERVIEW_TOOL_NAME, '{}'));
    expect(rows).toHaveLength(151);
    expect(rows[150]['truncated']).toBe(50);
  });

  it('malformed arguments degrade to text, never a throw', async () => {
    const tools = createVaultExploreTools(makePorts(), SCOPE, IDS);
    expect(await tools.run(VAULT_FIND_TOOL_NAME, 'not json')).toMatch(/needs a non-empty/);
    expect(await tools.run(VAULT_SECTION_TOOL_NAME, '[1,2]')).toMatch(/needs a "path"/);
  });
});
