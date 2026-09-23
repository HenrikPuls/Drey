import { McpServer } from '../../../electron/mcp/server';
import { VaultTools } from '../../../electron/mcp/vault-tools';
import type { AppConfig } from '../../../shared/app-config';
import type { SectionSearchProvider } from '../../../shared/plugin-api';
import type { VaultManager } from '../../../electron/vault-manager';

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


describe('McpServer.handle', () => {
  const tools = {
    list: () => [
      { name: 'vault_read', description: 'x', inputSchema: { type: 'object', properties: {} } },
    ],
    call: async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }],
    }),
  };
  const server = new McpServer(tools as unknown as VaultTools, '9.9.9');

  it('answers initialize with a protocol version and the tools capability', async () => {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res?.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: {} },
      serverInfo: { name: 'drey-vault', version: '9.9.9' },
    });
  });

  it('lists tools and runs a tools/call through VaultTools', async () => {
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((list?.result as { tools: unknown[] }).tools).toHaveLength(1);

    const call = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'vault_read', arguments: { path: 'a.md' } },
    });
    expect(call?.result).toEqual({
      content: [{ type: 'text', text: 'vault_read:{"path":"a.md"}' }],
    });
  });

  it('returns null for a notification and an error for an unknown method', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const res = await server.handle({ jsonrpc: '2.0', id: 4, method: 'no/such' });
    expect(res?.error?.code).toBe(-32601);
  });
});

describe('VaultTools', () => {
  it('rejects an invalid regex', async () => {
    const tools = new VaultTools(
      fakeVault({}),
      () => fakeProvider(),
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

  it('degrades vault_search with a clear error when no provider is registered', async () => {
    const tools = new VaultTools(
      fakeVault({}),
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
    const tools = new VaultTools(vault, () => fakeProvider(), () => config(), async (req) => {
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
      () => config(),
      async () => true,
    );
    const bare = await tools.call('vault_search', { tags: ['x'] });
    expect(bare.content[0].text).toContain('a.md:3');
    expect(bare.content[0].text).not.toContain('v9:');

    const scoped = await tools.call('vault_search', { tags: ['x'], vault: 'all' });
    expect(scoped.content[0].text).toContain('v9:a.md:3');
  });
});
