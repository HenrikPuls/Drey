import { describe, expect, it } from 'vitest';
import { defaultToolsConfig } from '../../shared/app-config';
import type { ChatMessage, ToolSpec } from '../../shared/llm';
import { LlmTaskRegistry, cancelledError } from './llm-tasks';
import { runToolLoop } from './tool-loop';
import { buildLlmContext } from '../plugin-host/plugin-context';
import type { VaultCallOptions } from '../mcp';

/**
 * The abort chain of a plugin call with vault tools (ADR-0071 later
 * change): the loop's signal travels through the host's merged
 * dispatcher into `VaultCallOptions`, a hanging tool call rejects as an
 * abort when the ask is cancelled, and a queued second call of the same
 * round never runs. The provider below is a fake that runs the REAL
 * `runToolLoop` — exactly what an HTTP provider does with the merged
 * options.
 */

const SPEC: ToolSpec = {
  name: 'vault_read',
  description: 'Reads a note',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

/** One scripted round: two tool calls, then the answer. */
const ROUND_ONE = {
  text: '',
  toolCalls: [
    { id: 'c1', type: 'function' as const, function: { name: 'vault_read', arguments: '{"path":"a.md"}' } },
    { id: 'c2', type: 'function' as const, function: { name: 'vault_read', arguments: '{"path":"b.md"}' } },
  ],
  truncated: false,
};
const ROUND_TWO = { text: 'done', toolCalls: [], truncated: false };

/**
 * A fake vault tool set: `onAbort` decides what a call does when the
 * signal fires — reject as an abort (the real tool set's behavior) or
 * resolve anyway (a tool that ignores the signal).
 */
function harness(onAbort: 'reject' | 'resolve') {
  const signals: Array<AbortSignal | undefined> = [];
  let started!: () => void;
  const firstCallStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const registry = new LlmTaskRegistry();

  const vaultCall = (
    _name: string,
    _args: Record<string, unknown>,
    options?: VaultCallOptions,
  ): Promise<{ content: [{ type: 'text'; text: string }] }> =>
    new Promise((resolve, reject) => {
      signals.push(options?.signal);
      started();
      const settle = (): void =>
        onAbort === 'reject'
          ? reject(cancelledError())
          : resolve({ content: [{ type: 'text', text: 'late' }] });
      if (options?.signal === undefined) {
        return;
      }
      if (options.signal.aborted) {
        settle();
        return;
      }
      options.signal.addEventListener('abort', settle, { once: true });
    });

  const deps = {
    appConfig: { get: () => ({ llm: { enabled: true }, tools: defaultToolsConfig() }) },
    llm: {
      chat: async (messages: ChatMessage[], options: Parameters<typeof runToolLoop>[1]) =>
        runToolLoop(messages, options, async (convo) =>
          convo.length > 1 ? ROUND_TWO : ROUND_ONE,
        ),
      capabilities: () => ({}),
    },
    llmTasks: registry,
    tagSuggester: {},
    llmDebug: { onEntry: () => () => undefined },
    vaultManager: { getActiveVaultId: () => 'vtest' },
    vaultTools: {
      toolSpecs: (): ToolSpec[] => [SPEC],
      call: vaultCall,
    },
  };
  const llm = buildLlmContext(deps as never, (unsubscribe) => unsubscribe, async () => ({
    templates: [],
    triggers: [],
  }));
  return { llm, registry, signals, firstCallStarted };
}

describe('the abort signal of a plugin call with vault tools', () => {
  it('reaches the vault tool: a cancel mid-call rejects the ask as an abort', async () => {
    const { llm, registry, signals, firstCallStarted } = harness('reject');
    const ask = llm.chat([{ role: 'user', content: 'question' }], {
      taskId: 'task-1',
      vaultTools: true,
    });

    await firstCallStarted;
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    registry.cancel('task-1');

    await expect(ask).rejects.toMatchObject({ name: 'AbortError' });
    // The queued second call of the round never started.
    expect(signals).toHaveLength(1);
  });

  it('stops a queued second call even when the first tool ignored the signal', async () => {
    const { llm, registry, signals, firstCallStarted } = harness('resolve');
    const ask = llm.chat([{ role: 'user', content: 'question' }], {
      taskId: 'task-2',
      vaultTools: true,
    });

    await firstCallStarted;
    registry.cancel('task-2');

    await expect(ask).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals).toHaveLength(1);
  });
});
