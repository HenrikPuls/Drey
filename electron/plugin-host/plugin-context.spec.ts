import { describe, expect, it, vi } from 'vitest';
import { defaultToolsConfig } from '../../shared/app-config';
import type { VaultChangeEvent } from '../../shared/plugin-api';
import type { ToolSpec } from '../../shared/llm';
import type { LlmChatOptions } from '../llm';
import type { VaultCallOptions } from '../mcp';
import { ManagedVaults } from './managed-vaults';
import { assistantVaultOptions, buildLlmContext, buildVaultContext, runVaultTool } from './plugin-context';

/**
 * What a plugin's `ctx.llm.chat` hands the provider (ADR-0071): the merged
 * tool set, and a dispatcher that runs a name only where it was offered
 * from — the gap that let a model call a vault tool the group switch or
 * the scope had left out.
 */

const spec = (name: string): ToolSpec => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
});

function harness(over: { activeVaultId?: string | null } = {}) {
  const tools = defaultToolsConfig();
  const sent: LlmChatOptions[] = [];
  const vaultCall = vi.fn(async (name: string) => ({
    content: [{ type: 'text' as const, text: `vault ran ${name}` }],
  }));
  const toolboxRun = vi.fn(async (name: string) => `toolbox ran ${name}`);
  const offered: VaultCallOptions[] = [];
  const deps = {
    appConfig: { get: () => ({ llm: { enabled: true }, tools }) },
    llm: {
      chat: async (_messages: unknown, options: LlmChatOptions) => {
        sent.push(options);
        return { text: 'ok' };
      },
      capabilities: () => ({}),
    },
    llmTasks: {
      run: <T>(_taskId: string | undefined, fn: (signal: AbortSignal) => Promise<T>) =>
        fn(new AbortController().signal),
    },
    tagSuggester: {},
    llmDebug: { onEntry: () => () => undefined },
    vaultManager: { getActiveVaultId: () => over.activeVaultId ?? 'active' },
    vaultTools: {
      // The base set decides what a caller is offered: no changing tools
      // while its write rule is "off".
      toolSpecs: (options: VaultCallOptions) => {
        offered.push(options);
        return [
          'vault_search',
          'vault_read',
          ...(options.write === 'off' ? [] : ['vault_edit', 'vault_write']),
        ].map(spec);
      },
      call: vaultCall,
    },
    assistantToolbox: { specs: () => [spec('web_fetch')], run: toolboxRun },
  };
  const llm = buildLlmContext(deps as never, (unsubscribe) => unsubscribe, async () => ({
    templates: [],
    triggers: [],
  }));
  return { llm, sent, tools, vaultCall, toolboxRun, offered };
}

const names = (options: LlmChatOptions | undefined): string[] =>
  (options?.tools ?? []).map((tool) => tool.name);

describe('buildLlmContext — the tool set of a plugin call', () => {
  it('attaches nothing unless the call opts in', async () => {
    const h = harness();

    await h.llm.chat([], {});

    expect(h.sent[0]?.tools).toBeUndefined();
    expect(h.sent[0]?.onToolCall).toBeUndefined();
  });

  it('merges plugin, vault and external tools, the plugin winning a name', async () => {
    const h = harness();

    await h.llm.chat([], {
      tools: [spec('vault_read'), spec('own_tool')],
      onToolCall: async (name) => `plugin ran ${name}`,
      vaultTools: true,
      externalTools: true,
    });

    expect(names(h.sent[0])).toEqual([
      'vault_read',
      'own_tool',
      'vault_search',
      'vault_edit',
      'vault_write',
      'web_fetch',
    ]);
    const run = h.sent[0]!.onToolCall!;
    expect(await run('vault_read', '{}')).toBe('plugin ran vault_read');
    expect(await run('vault_search', '{}')).toBe('vault ran vault_search');
    expect(await run('web_fetch', '{}')).toBe('toolbox ran web_fetch');
  });

  it('offers the vault tools the write rule allows, and runs no other', async () => {
    const h = harness();
    h.tools.vault.write = 'off';

    await h.llm.chat([], { vaultTools: true });

    expect(names(h.sent[0])).toEqual(['vault_search', 'vault_read']);
    expect(await h.sent[0]!.onToolCall!('vault_write', '{}')).toMatch(/^Error: there is no tool/);
    expect(h.vaultCall).not.toHaveBeenCalled();
  });

  it('does not run a vault tool the call did not opt into', async () => {
    const h = harness();

    await h.llm.chat([], { tools: [spec('own_tool')], onToolCall: async () => 'x' });

    expect(await h.sent[0]!.onToolCall!('vault_write', '{"path":"a.md","content":"x"}')).toMatch(
      /^Error: there is no tool "vault_write"/,
    );
    expect(h.vaultCall).not.toHaveBeenCalled();
  });

  it("hands every vault call the caller's scope and the assistant's rules", async () => {
    const h = harness();
    h.tools.vault.write = 'auto';

    await h.llm.chat([], { vaultTools: true, vaultToolsScope: ['docs'] });
    await h.sent[0]!.onToolCall!('vault_read', '{"path":"a.md"}');

    const expected = { scope: ['docs'], write: 'auto', origin: 'assistant', protectAppFolders: true };
    expect(h.offered[0]).toEqual(expected);
    expect(h.vaultCall).toHaveBeenCalledWith('vault_read', { path: 'a.md' }, expected);
  });

  it('passes the files of the call on, an unnamed vault being the active one', async () => {
    const h = harness();
    const onVaultChange = vi.fn();

    await h.llm.chat([], {
      vaultTools: true,
      vaultToolsScope: [],
      vaultToolsFiles: [{ path: 'a.md', live: true }, { vaultId: 'docs', path: 'b.md' }],
      onVaultChange,
    });

    expect(h.offered[0]).toEqual({
      scope: [],
      write: 'confirm',
      origin: 'assistant',
      protectAppFolders: true,
      files: [
        { vaultId: 'active', path: 'a.md', live: true },
        { vaultId: 'docs', path: 'b.md' },
      ],
      onChange: onVaultChange,
    });
  });

  it('does not run an external tool the call did not opt into', async () => {
    const h = harness();

    await h.llm.chat([], { vaultTools: true });

    expect(await h.sent[0]!.onToolCall!('web_fetch', '{}')).toMatch(/^Error:/);
    expect(h.toolboxRun).not.toHaveBeenCalled();
  });

  it("applies the user's round budget unless the call names its own", async () => {
    const h = harness();
    h.tools.maxRounds = 7;

    await h.llm.chat([], { vaultTools: true });
    await h.llm.chat([], { vaultTools: true, maxToolRounds: 20 });

    expect(h.sent[0]?.maxToolRounds).toBe(7);
    expect(h.sent[1]?.maxToolRounds).toBe(20);
  });

  it('forwards the progress callback', async () => {
    const h = harness();
    const onToolEvent = vi.fn();

    await h.llm.chat([], { vaultTools: true, onToolEvent });

    expect(h.sent[0]?.onToolEvent).toBe(onToolEvent);
  });
});

describe('runVaultTool', () => {
  it('marks a failed call so the model and the loop can tell', async () => {
    const tools = {
      call: async () => ({ content: [{ type: 'text', text: 'The user declined the write.' }], isError: true }),
    };

    expect(await runVaultTool(tools as never, 'vault_write', '{}')).toBe(
      'Error: The user declined the write.',
    );
  });

  it('refuses arguments that are not JSON', async () => {
    const call = vi.fn();

    expect(await runVaultTool({ call } as never, 'vault_read', '{"path":')).toMatch(
      /^Error: the arguments of vault_read are not valid JSON/,
    );
    expect(call).not.toHaveBeenCalled();
  });
});

describe('assistantVaultOptions - what a plugin call hands the base', () => {
  it('carries origin, protection and the write rule; scope only when set', () => {
    expect(assistantVaultOptions(undefined, 'confirm')).toEqual({
      write: 'confirm',
      origin: 'assistant',
      protectAppFolders: true,
    });
    expect(assistantVaultOptions(['docs'], 'off')).toEqual({
      scope: ['docs'],
      write: 'off',
      origin: 'assistant',
      protectAppFolders: true,
    });
  });

  it('passes files and onChange through only when set', () => {
    const files = [{ vaultId: 'v1', path: 'note.md' }];
    const onChange = () => undefined;
    expect(assistantVaultOptions(undefined, 'confirm', { files })).toMatchObject({ files });
    expect(assistantVaultOptions(undefined, 'confirm', { files: [] })).not.toHaveProperty('files');
    expect(assistantVaultOptions(undefined, 'confirm', { onChange })).toMatchObject({ onChange });
  });
});

describe('buildVaultContext - the ctx.vault of a plugin', () => {
  function vaultHarness() {
    const announcer = {
      announceExternal: vi.fn(),
      announceFullRefresh: vi.fn(),
    };
    const vaultManager = {
      listVaults: vi.fn(async () => [{ id: 'v1', name: 'V', active: true }]),
      readFile: vi.fn(async () => ({ content: 'body' })),
      writeFile: vi.fn(async () => 42),
      resolveVaultId: vi.fn((id?: string | null) => id ?? 'active'),
      deleteEntry: vi.fn(async () => ({ trashed: true })),
      saveAsset: vi.fn(async () => 'attachments/x.png'),
      listFiles: vi.fn(async () => ['note.md']),
      listMarkdownFiles: vi.fn(async () => ['note.md']),
      resolveAssetPath: vi.fn(() => null),
      pickSavePath: vi.fn(async () => null),
    };
    let subscribed: ((event: unknown) => void) | null = null;
    const confirmWrite = vi.fn(async (request: { path: string }) => request.path === 'ok.md');
    const managedVaults = new ManagedVaults();
    const ctx = buildVaultContext(
      'my-plugin',
      {
        vaultManager: vaultManager as never,
        vaultAnnouncer: () => announcer as never,
        confirmWrite,
        managedVaults,
      },
      'My Plugin',
      (cb: (event: VaultChangeEvent) => void) => {
        subscribed = cb as never;
        return () => {
          subscribed = null;
        };
      },
    );
    return { ctx, vaultManager, announcer, confirmWrite, managedVaults, subscribed: () => subscribed };
  }

  it('reads and writes with the plugin id as the history origin', async () => {
    const h = vaultHarness();
    await expect(h.ctx.read('a.md', { vaultId: 'v1' })).resolves.toBe('body');
    expect(h.vaultManager.readFile).toHaveBeenCalledWith('a.md', 'v1');
    await expect(h.ctx.write('a.md', 'new', { vaultId: 'v1' })).resolves.toBe(42);
    expect(h.vaultManager.writeFile).toHaveBeenCalledWith('a.md', 'new', 'v1', { origin: 'my-plugin' });
  });

  it('writeAnnounced resolves the vault and announces the changed path', async () => {
    const h = vaultHarness();
    await expect(h.ctx.writeAnnounced('chat/x.md', 'hi')).resolves.toBe(42);
    expect(h.vaultManager.resolveVaultId).toHaveBeenCalledWith(undefined);
    expect(h.vaultManager.writeFile).toHaveBeenCalledWith('chat/x.md', 'hi', 'active', {
      origin: 'my-plugin',
    });
    expect(h.announcer.announceExternal).toHaveBeenCalledWith({
      vaultId: 'active',
      changedPaths: ['chat/x.md'],
      deletedPaths: [],
    });
  });

  it('delete answers whether it trashed and announces the deletion', async () => {
    const h = vaultHarness();
    await expect(h.ctx.delete('old.md', { vaultId: 'v1' })).resolves.toBe(true);
    expect(h.announcer.announceExternal).toHaveBeenCalledWith({
      vaultId: 'v1',
      changedPaths: [],
      deletedPaths: ['old.md'],
    });
  });

  it('confirmWrite marks the request as an assistant overwrite', async () => {
    const h = vaultHarness();
    await expect(h.ctx.confirmWrite({ path: 'ok.md' } as never)).resolves.toBe(true);
    expect(h.confirmWrite).toHaveBeenCalledWith({ path: 'ok.md', mode: 'overwrite', origin: 'assistant' });
    await expect(h.ctx.confirmWrite({ path: 'no.md' } as never)).resolves.toBe(false);
  });

  it('confirmWrite answers false when no bridge is wired', async () => {
    const ctx = buildVaultContext(
      'my-plugin',
      {
        vaultManager: {} as never,
        vaultAnnouncer: () => null as never,
        confirmWrite: undefined,
        managedVaults: new ManagedVaults(),
      },
      'My Plugin',
      () => () => undefined,
    );
    await expect(ctx.confirmWrite({ path: 'x.md' } as never)).resolves.toBe(false);
  });

  it('markManaged claims under the manifest name; null clears the claim', () => {
    const h = vaultHarness();
    expect(h.ctx.managedBy('v1')).toBeNull();
    h.ctx.markManaged('v1');
    expect(h.managedVaults.managedBy('v1')).toBe('My Plugin');
    expect(h.ctx.managedBy('v1')).toBe('My Plugin');
    // The claim follows detection: moving it leaves nothing behind.
    h.ctx.markManaged('v2');
    expect(h.managedVaults.managedBy('v1')).toBeNull();
    expect(h.managedVaults.managedBy('v2')).toBe('My Plugin');
    h.ctx.markManaged(null);
    expect(h.ctx.managedBy('v2')).toBeNull();
  });

  it('announceChanges sends an empty round as a full refresh', () => {
    const h = vaultHarness();
    h.ctx.announceChanges({ vaultId: 'v1' });
    expect(h.announcer.announceFullRefresh).toHaveBeenCalledWith('v1');
    expect(h.announcer.announceExternal).not.toHaveBeenCalled();
  });

  it('announceChanges splits notes from other files', () => {
    const h = vaultHarness();
    h.ctx.announceChanges({
      vaultId: 'v1',
      changedPaths: ['a.md', 'b.png'],
      deletedPaths: ['c.md', 'd.pdf'],
    });
    expect(h.announcer.announceExternal).toHaveBeenCalledWith({
      vaultId: 'v1',
      changedPaths: ['a.md'],
      deletedPaths: ['c.md'],
      otherPaths: ['b.png', 'd.pdf'],
    });
  });

  it('hands the change callback to onChanged and unsubscribes', () => {
    const h = vaultHarness();
    const cb = () => undefined;
    const unsub = h.ctx.onChanged(cb);
    expect(h.subscribed()).toBe(cb);
    unsub();
    expect(h.subscribed()).toBeNull();
  });

  it('lists vaults and markdown files through the manager', async () => {
    const h = vaultHarness();
    await expect(h.ctx.listVaults()).resolves.toEqual([{ id: 'v1', name: 'V', active: true }]);
    await expect(h.ctx.listMarkdownFiles({ vaultId: 'v1' })).resolves.toEqual(['note.md']);
    expect(h.vaultManager.listMarkdownFiles).toHaveBeenCalledWith('v1');
  });
});
