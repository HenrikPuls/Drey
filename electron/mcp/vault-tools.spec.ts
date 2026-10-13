import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isLocalHost, isLocalOrigin } from './http-transport';
import { createVaultMcpServer } from './server';
import { VaultTools } from './vault-tools';
import type { AppConfig } from '../../shared/app-config';
import type {
  SectionSearchProvider,
  SemanticSearchProvider,
  SdkTaskRecord,
} from '../../shared/plugin-api';
import type { VaultManager } from '../vault-manager';

/**
 * `electron/mcp/` is transport- and IO-free at its core (ADR-0007 keeps
 * the fragile logic out of the main process shell), so it is unit-tested
 * here like the other cross-layer modules -- with fakes for VaultManager /
 * TagIndex.
 */

function config(overrides: Partial<AppConfig['mcp']> = {}): AppConfig {
  return {
    mcp: { enabled: true, httpEnabled: false, httpPort: 4319, yolo: false, ...overrides },
  } as AppConfig;
}

interface FakeVault extends VaultManager {
  reads: Array<{ path: string; vaultId?: string }>;
  writes: Array<{ path: string; vaultId?: string }>;
}

function fakeVault(files: Record<string, string>): FakeVault {
  const vaults = [
    { id: 'vtest', name: 'Test Vault' },
    { id: 'v2', name: 'Second Vault' },
  ];
  const reads: FakeVault['reads'] = [];
  const writes: FakeVault['writes'] = [];
  const manager = {
    resolveVaultId: (vaultId?: string) => vaultId ?? 'vtest',
    listVaults: () => vaults,
    listMarkdownFiles: async () => Object.keys(files),
    readFile: async (p: string, vaultId?: string) => {
      reads.push({ path: p, vaultId });
      if (!(p in files)) {
        throw new Error(`not found: ${p}`);
      }
      return { content: files[p], modifiedMs: 1 };
    },
    writeFile: async (p: string, content: string, vaultId?: string) => {
      writes.push({ path: p, vaultId });
      files[p] = content;
      return 2;
    },
  } as FakeVault;
  manager.reads = reads;
  manager.writes = writes;
  return manager;
}

function fakeProvider(hits: unknown[] = []): SectionSearchProvider {
  return {
    search: async () => hits as never[],
    vocabulary: () => [],
  };
}


describe('the vault MCP server (SDK protocol layer)', () => {
  const tools = {
    list: () => [
      { name: 'vault_read', description: 'x', inputSchema: { type: 'object', properties: {} } },
    ],
    call: async (name: string, args: Record<string, unknown>) =>
      name === 'vault_read'
        ? { content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }] }
        : { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true },
  };

  async function connected(): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createVaultMcpServer(tools as unknown as VaultTools, '9.9.9').connect(serverSide);
    const client = new Client({ name: 'spec', version: '1' }, { capabilities: {} });
    await client.connect(clientSide);
    return client;
  }

  it('introduces itself and offers tools only', async () => {
    const client = await connected();
    expect(client.getServerVersion()).toMatchObject({ name: 'drey-vault', version: '9.9.9' });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  });

  it('lists tools and runs a tools/call through VaultTools', async () => {
    const client = await connected();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['vault_read']);
    const result = await client.callTool({ name: 'vault_read', arguments: { path: 'a.md' } });
    expect(result.content).toEqual([{ type: 'text', text: 'vault_read:{"path":"a.md"}' }]);
  });

  it('passes a tool error through as an error result', async () => {
    const client = await connected();
    const result = await client.callTool({ name: 'nope', arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe('the HTTP endpoint guards', () => {
  it('accepts only a local Host on its own port', () => {
    expect(isLocalHost('127.0.0.1:4319', 4319)).toBe(true);
    expect(isLocalHost('localhost:4319', 4319)).toBe(true);
    expect(isLocalHost('localhost:9999', 4319)).toBe(false);
    expect(isLocalHost('evil.example', 4319)).toBe(false);
    expect(isLocalHost('evil.example:4319', 4319)).toBe(false);
    expect(isLocalHost(undefined, 4319)).toBe(false);
  });

  it('accepts no Origin (not a browser) or a local page, nothing else', () => {
    expect(isLocalOrigin(undefined)).toBe(true);
    expect(isLocalOrigin('http://localhost:5173')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('https://evil.example')).toBe(false);
    expect(isLocalOrigin('http://localhost.evil.example')).toBe(false);
    expect(isLocalOrigin('null')).toBe(false);
  });
});

describe('VaultTools', () => {
  it('rejects an invalid regex', async () => {
    const tools = new VaultTools(
      fakeVault({}),
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => true,
    );
    const res = await tools.call('vault_search', { regex: '(' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('invalid regex');
  });

  it('scans every file line-by-line for a regex-only search', async () => {
    const tools = new VaultTools(
      fakeVault({ 'a.md': 'alpha\nBETA\n', 'b.md': 'gamma\n' }),
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => true,
    );
    const res = await tools.call('vault_search', { regex: 'beta', regexFlags: 'i' });
    expect(res.content[0].text).toContain('a.md:2');
    expect(res.content[0].text).not.toContain('b.md');
  });

  it('reads a file and errors on a missing one', async () => {
    const tools = new VaultTools(
      fakeVault({ 'a.md': 'hi' }),
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => true,
    );
    expect((await tools.call('vault_read', { path: 'a.md' })).content[0].text).toBe('hi');
    expect((await tools.call('vault_read', { path: 'x.md' })).isError).toBe(true);
  });

  it('appends with a separating newline and honours the confirmation result', async () => {
    const files = { 'note.md': 'first line' };
    let asked = 0;
    const tools = new VaultTools(
      fakeVault(files),
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => {
        asked++;
        return true;
      },
    );
    await tools.call('vault_write', { path: 'note.md', content: '## entry', mode: 'append' });
    expect(files['note.md']).toBe('first line\n## entry');
    expect(asked).toBe(1);
  });

  it('does not write when the user declines', async () => {
    const files = { 'note.md': 'keep me' };
    const tools = new VaultTools(
      fakeVault(files),
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => false,
    );
    const res = await tools.call('vault_write', { path: 'note.md', content: 'nope' });
    expect(res.isError).toBe(true);
    expect(files['note.md']).toBe('keep me');
  });

  it('skips the confirmation in YOLO mode', async () => {
    const files = { 'note.md': 'old' };
    let asked = 0;
    const tools = new VaultTools(
      fakeVault(files),
      () => fakeProvider(),
      () => null,
      () => config({ yolo: true }),
      async () => {
        asked++;
        return true;
      },
    );
    await tools.call('vault_write', { path: 'note.md', content: 'new' });
    expect(files['note.md']).toBe('new');
    expect(asked).toBe(0);
  });

  it('the caller can set the write rule (ADR-0063): the assistant overrides mcp.yolo both ways', async () => {
    const files = { 'note.md': 'old' };
    let asked = 0;
    const make = (yolo: boolean): VaultTools =>
      new VaultTools(
        fakeVault(files),
        () => fakeProvider(),
        () => null,
        () => config({ yolo }),
        async () => {
          asked++;
          return true;
        },
      );
    await make(true).call('vault_write', { path: 'note.md', content: 'a' }, { confirmWrites: true });
    expect(asked).toBe(1);
    await make(false).call('vault_write', { path: 'note.md', content: 'b' }, { confirmWrites: false });
    expect(asked).toBe(1);
    expect(files['note.md']).toBe('b');
  });

  it('degrades vault_search with a clear error when no provider is registered', async () => {
    const tools = new VaultTools(
      fakeVault({}),
      () => null,
      () => null,
      () => config(),
      async () => true,
    );
    const res = await tools.call('vault_search', { tags: ['a'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('no plugin providing the tag/section index');
  });

  it('vault_read targets a named vault and rejects "all"', async () => {
    const vault = fakeVault({ 'a.md': 'hi' });
    const tools = new VaultTools(
      vault,
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => true,
    );
    expect(
      (await tools.call('vault_read', { path: 'a.md', vault: 'v2' })).content[0].text,
    ).toBe('hi');
    expect(vault.reads[0]).toEqual({ path: 'a.md', vaultId: 'v2' });

    const res = await tools.call('vault_read', { path: 'a.md', vault: 'all' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"all" is not valid');
  });

  it('vault_write targets a named vault and labels confirmation + result', async () => {
    const vault = fakeVault({ 'note.md': 'x' });
    const confirms: Array<Record<string, unknown>> = [];
    const tools = new VaultTools(vault, () => fakeProvider(), () => null, () => config(), async (req) => {
      confirms.push({ ...req });
      return true;
    });
    const res = await tools.call('vault_write', { path: 'note.md', content: 'y', vault: 'v2' });
    expect(res.isError).toBeUndefined();
    expect(confirms[0]).toMatchObject({ vaultId: 'v2', vaultName: 'Second Vault' });
    expect(vault.writes[0]).toEqual({ path: 'note.md', vaultId: 'v2' });
    expect(res.content[0].text).toContain('Wrote v2:note.md');
  });

  it('labels cross-vault search hits with the vault id, keeps the default scope bare', async () => {
    const hit = { path: 'a.md', heading: 'H', line: 3, snippet: 's', text: 't', vaultId: 'v9' };
    const tools = new VaultTools(
      fakeVault({}),
      () => fakeProvider([hit]),
      () => null,
      () => config(),
      async () => true,
    );
    const bare = await tools.call('vault_search', { tags: ['x'] });
    expect(bare.content[0].text).toContain('a.md:3');
    expect(bare.content[0].text).not.toContain('v9:');

    const scoped = await tools.call('vault_search', { tags: ['x'], vault: 'all' });
    expect(scoped.content[0].text).toContain('v9:a.md:3');
  });

  it('degrades tasks_list with a clear error when no task provider is registered', async () => {
    const tools = new VaultTools(
      fakeVault({}),
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => true,
    );
    const res = await tools.call('tasks_list', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('no plugin providing the task index');
  });

  it('tasks_list returns one JSON record per line, honoring includeDone and vault', async () => {
    const task = (over: Partial<SdkTaskRecord>): SdkTaskRecord => ({
      path: 'daily/a.md',
      vaultId: 'vtest',
      line: 3,
      text: 'Aufräumen',
      done: false,
      kind: 'checkbox',
      heading: null,
      tags: [],
      due: null,
      priority: null,
      ...over,
    });
    const records = [task({}), task({ done: true, line: 5 }), task({ vaultId: 'v2', line: 7 })];
    const provider = {
      query: async (opts?: { includeDone?: boolean; vaultId?: string }) =>
        records.filter(
          (r) =>
            (opts?.includeDone === true || !r.done) &&
            (opts?.vaultId === undefined || r.vaultId === opts.vaultId),
        ),
      setDone: async (t: SdkTaskRecord) => t,
    };
    const tools = new VaultTools(
      fakeVault({}),
      () => fakeProvider(),
      () => provider,
      () => config(),
      async () => true,
    );

    const open = await tools.call('tasks_list', {});
    expect(open.isError).toBeUndefined();
    const openLines = open.content[0].text.split('\n');
    expect(openLines).toHaveLength(2); // the vtest + the v2 open task
    expect(JSON.parse(openLines[0])).toMatchObject({ line: 3 });

    const all = await tools.call('tasks_list', { includeDone: true });
    expect(all.content[0].text.split('\n')).toHaveLength(3);

    const scoped = await tools.call('tasks_list', { vault: 'v2' });
    expect(JSON.parse(scoped.content[0].text)).toMatchObject({ vaultId: 'v2', line: 7 });
  });

  it('tasks_list passes text/tag/overdue/sort intent args to the provider (57c)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider = {
      query: async (opts?: Record<string, unknown>) => {
        seen.push({ ...(opts ?? {}) });
        return [];
      },
      setDone: async (t: SdkTaskRecord) => t,
    };
    const tools = new VaultTools(
      fakeVault({}),
      () => fakeProvider(),
      () => provider,
      () => config(),
      async () => true,
    );

    const res = await tools.call('tasks_list', {
      text: 'Marta',
      tag: '#blockuniversum',
      overdue: true,
      sort: 'importance',
    });
    expect(res.content[0].text).toBe('No tasks found.');
    expect(seen[0]).toEqual({
      includeDone: false,
      text: 'Marta',
      tag: 'blockuniversum',
      overdue: true,
      sort: 'importance',
    });
    // No sort argument: the provider's file-order default (the MCP tool
    // does not silently re-order an external client's view).
    await tools.call('tasks_list', {});
    expect(seen[1]).toEqual({ includeDone: false });

    // The done view (57d): status passes through and lists newest
    // completion first; a completion-date restriction implies it.
    await tools.call('tasks_list', { status: 'done' });
    expect(seen[2]).toEqual({ includeDone: false, status: 'done', sort: 'completed' });
    await tools.call('tasks_list', { completedSince: '2026-09-26', sort: 'file' });
    expect(seen[3]).toEqual({
      includeDone: false,
      status: 'done',
      completedSince: '2026-09-26',
      sort: 'file',
    });
    await tools.call('tasks_list', { status: 'nope', completedSince: 'recently' });
    expect(seen[4]).toEqual({ includeDone: false });
  });
});

describe('vault_search mode semantic (SDK 1.18)', () => {
  const semanticHits = [
    {
      path: 'daily/a.md',
      heading: 'Kaffee',
      line: 3,
      snippet: 'Kaffee trinken …',
      text: 'Kaffee trinken morgens',
      vaultId: 'vtest',
      score: 0.87,
    },
  ];

  function semanticTools(provider: SemanticSearchProvider | null): VaultTools {
    return new VaultTools(
      fakeVault({}),
      () => fakeProvider(),
      () => null,
      () => config(),
      async () => true,
      () => undefined,
      () => provider,
    );
  }

  it('routes the question to the semantic provider with scope and limit', async () => {
    const seen: unknown[] = [];
    const tools = semanticTools({
      search: async (question, scope, limit) => {
        seen.push({ question, scope, limit });
        return semanticHits;
      },
    });
    const res = await tools.call('vault_search', {
      mode: 'semantic',
      text: 'was trinke ich morgens?',
      maxResults: 5,
      vault: 'all',
    });
    expect(res.isError).not.toBe(true);
    expect(seen[0]).toEqual({
      question: 'was trinke ich morgens?',
      scope: { kind: 'all' },
      limit: 5,
    });
    expect(res.content[0].text).toContain('vtest:daily/a.md:3 — Kaffee (score 0.87)');
    expect(res.content[0].text).toContain('Kaffee trinken …');
  });

  it('degrades with a clear error when no semantic provider is registered', async () => {
    const tools = semanticTools(null);
    const res = await tools.call('vault_search', { mode: 'semantic', text: 'frage' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("assistant's retrieval is disabled");
  });

  it('requires text and refuses tags/regex in semantic mode', async () => {
    const tools = semanticTools({
      search: async () => semanticHits,
    });
    const noText = await tools.call('vault_search', { mode: 'semantic' });
    expect(noText.isError).toBe(true);
    expect(noText.content[0].text).toContain('non-empty text');
    const withTags = await tools.call('vault_search', { mode: 'semantic', text: 'q', tags: ['x'] });
    expect(withTags.isError).toBe(true);
    expect(withTags.content[0].text).toContain('apply to the default text mode');
    const withRegex = await tools.call('vault_search', { mode: 'semantic', text: 'q', regex: 'x' });
    expect(withRegex.isError).toBe(true);
  });

  it("an absent or unknown mode stays the exact text search (default 'text')", async () => {
    let called = false;
    const tools = new VaultTools(
      fakeVault({}),
      () => fakeProvider([{ path: 'a.md', heading: 'H', line: 1, snippet: 's', text: 't' }]),
      () => null,
      () => config(),
      async () => true,
      () => undefined,
      () => {
        throw new Error('semantic provider must not be asked in text mode');
      },
    );
    const res = await tools.call('vault_search', { text: 'terms', mode: 'nonsense' });
    expect(res.isError).not.toBe(true);
    expect(res.content[0].text).toContain('a.md:1');
    called = true;
    expect(called).toBe(true);
  });
});
