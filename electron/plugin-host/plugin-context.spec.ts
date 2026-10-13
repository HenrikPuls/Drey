import { describe, expect, it, vi } from 'vitest';
import { defaultToolsConfig } from '../../shared/app-config';
import type { ToolSpec } from '../../shared/llm';
import type { LlmChatOptions } from '../llm';
import { buildLlmContext, runVaultTool } from './plugin-context';

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
      toolSpecs: () => ['vault_search', 'vault_read', 'vault_write', 'tasks_list'].map(spec),
      call: vaultCall,
    },
    assistantToolbox: { specs: () => [spec('web_fetch')], run: toolboxRun },
  };
  const llm = buildLlmContext(deps as never, (unsubscribe) => unsubscribe);
  return { llm, sent, tools, vaultCall, toolboxRun };
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
      'vault_write',
      'web_fetch',
    ]);
    const run = h.sent[0]!.onToolCall!;
    expect(await run('vault_read', '{}')).toBe('plugin ran vault_read');
    expect(await run('vault_search', '{}')).toBe('vault ran vault_search');
    expect(await run('web_fetch', '{}')).toBe('toolbox ran web_fetch');
  });

  it('never offers the base tasks_list to a plugin call', async () => {
    const h = harness();

    await h.llm.chat([], { vaultTools: true });

    expect(names(h.sent[0])).not.toContain('tasks_list');
    expect(await h.sent[0]!.onToolCall!('tasks_list', '{}')).toMatch(/^Error: there is no tool/);
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

  it('does not run a read tool the scope dropped', async () => {
    const h = harness({ activeVaultId: 'active' });

    await h.llm.chat([], { vaultTools: true, vaultToolsScope: ['docs'] });

    expect(names(h.sent[0])).toEqual(['vault_write']);
    expect(await h.sent[0]!.onToolCall!('vault_read', '{"path":"a.md"}')).toMatch(/^Error:/);
    expect(h.vaultCall).not.toHaveBeenCalled();
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

  it('passes the write rule of the vault group to the vault tools', async () => {
    const h = harness();
    h.tools.vault.write = 'auto';

    await h.llm.chat([], { vaultTools: true });
    await h.sent[0]!.onToolCall!('vault_write', '{"path":"a.md","content":"x"}');

    expect(h.vaultCall).toHaveBeenCalledWith(
      'vault_write',
      { path: 'a.md', content: 'x' },
      { confirmWrites: false },
    );
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
