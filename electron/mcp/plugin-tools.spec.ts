import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { PluginMcpTools } from './plugin-tools';
import { createVaultMcpServer } from './server';
import type { VaultTools } from './vault-tools';
import type { PluginMcpToolProvider } from '../../shared/plugin-api';

/**
 * The plugin-tool seam on the MCP server (M85, SDK 1.29): providers
 * registered through `ctx.mcp` are listed beside the vault tools and
 * routed by wire name — collisions keep the earlier registration, and a
 * failing provider call is `isError` text.
 */

function provider(over: Partial<PluginMcpToolProvider> = {}): PluginMcpToolProvider {
  return {
    tools: () => [
      {
        name: 'fleet_status',
        description: 'The fleet state.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    call: async () => ({ text: 'no runs' }),
    ...over,
  };
}

describe('PluginMcpTools', () => {
  it('lists the registered providers\' tools and routes by name', async () => {
    const registry = new PluginMcpTools(() => undefined);
    registry.register('tickets', provider());
    expect(registry.list().map((def) => def.name)).toEqual(['fleet_status']);
    expect(registry.has('fleet_status')).toBe(true);
    expect(registry.has('vault_read')).toBe(false);
    const result = await registry.call('fleet_status', {});
    expect(result.content).toEqual([{ type: 'text', text: 'no runs' }]);
  });

  it('a duplicate name keeps the earlier registration and logs the loser', async () => {
    const logs: string[] = [];
    const registry = new PluginMcpTools((message) => logs.push(message));
    registry.register('tickets', provider());
    registry.register('other', provider({ call: async () => ({ text: 'from the other plugin' }) }));
    expect(registry.list()).toHaveLength(1);
    expect((await registry.call('fleet_status', {})).content).toEqual([{ type: 'text', text: 'no runs' }]);
    expect(logs.some((line) => line.includes('collides'))).toBe(true);
  });

  it('a failing call and an unknown name are isError text', async () => {
    const registry = new PluginMcpTools(() => undefined);
    registry.register(
      'tickets',
      provider({
        call: async () => {
          throw new Error('the runner is gone');
        },
      }),
    );
    const failed = await registry.call('fleet_status', {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toContain('the runner is gone');
    const unknown = await registry.call('nope', {});
    expect(unknown.isError).toBe(true);
  });
});

describe('the MCP server with plugin tools', () => {
  const vaultTools = {
    list: () => [
      { name: 'vault_read', description: 'x', inputSchema: { type: 'object' as const, properties: {} } },
    ],
    call: async (name: string) => ({
      content: [{ type: 'text' as const, text: `vault:${name}` }],
    }),
  };

  async function connected(registry: PluginMcpTools): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createVaultMcpServer(vaultTools as unknown as VaultTools, '9.9.9', registry).connect(serverSide);
    const client = new Client({ name: 'spec', version: '1' }, { capabilities: {} });
    await client.connect(clientSide);
    return client;
  }

  it('lists plugin tools after the vault tools and routes their calls', async () => {
    const registry = new PluginMcpTools(() => undefined);
    registry.register('tickets', provider({ call: async () => ({ text: 'fleet: 1 run' }) }));
    const client = await connected(registry);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['vault_read', 'fleet_status']);
    const result = await client.callTool({ name: 'fleet_status', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'fleet: 1 run' }]);
    const vault = await client.callTool({ name: 'vault_read', arguments: {} });
    expect(vault.content).toEqual([{ type: 'text', text: 'vault:vault_read' }]);
  });

  it('the server stays unchanged without a registry', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createVaultMcpServer(vaultTools as unknown as VaultTools, '9.9.9').connect(serverSide);
    const client = new Client({ name: 'spec', version: '1' }, { capabilities: {} });
    await client.connect(clientSide);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['vault_read']);
  });

  it('registering after the server came up shows in the next listing', async () => {
    const registry = new PluginMcpTools(vi.fn());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createVaultMcpServer(vaultTools as unknown as VaultTools, '9.9.9', registry).connect(serverSide);
    const client = new Client({ name: 'spec', version: '1' }, { capabilities: {} });
    await client.connect(clientSide);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['vault_read']);
    registry.register('tickets', provider());
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['vault_read', 'fleet_status']);
  });
});
