import { describe, expect, it, vi } from 'vitest';
import { kimiAdapter, type KimiUsageRecord } from './kimi';
import { parseKimiWire } from './kimi-usage';
import type { NormalizedEvent, ProviderStart } from './providers';
import type { RunnerProcess } from './procs';

/**
 * The Kimi adapter against a scripted `kimi acp`: the JSON shapes below are
 * the ones recorded from kimi 2.4.1 (docs/design/kimi-worker.md).
 */

interface Rpc {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

function fakeAcp(): {
  proc: RunnerProcess;
  sent: Rpc[];
  stdout: (message: unknown) => void;
  killTree: ReturnType<typeof vi.fn>;
  ended: () => boolean;
  exit: (code: number | null) => void;
  /** The next request of that method the adapter sent, once it did. */
  request: (method: string) => Promise<Rpc>;
  /** Answers a request of the adapter. */
  reply: (request: Rpc, result?: unknown) => Promise<void>;
  fail: (request: Rpc, message: string) => Promise<void>;
  sentMethods: () => string[];
} {
  const sent: Rpc[] = [];
  let out: (chunk: string) => void = () => undefined;
  const exits: Array<(code: number | null) => void> = [];
  const killTree = vi.fn(async () => undefined);
  let ended = false;
  const proc: RunnerProcess = {
    pid: 777,
    write: (text) => {
      for (const line of text.split('\n')) {
        if (line.trim() !== '') {
          sent.push(JSON.parse(line) as Rpc);
        }
      }
    },
    endInput: () => {
      ended = true;
    },
    onStdout: (cb) => {
      out = cb;
    },
    onStderr: () => undefined,
    onExit: (cb) => {
      exits.push(cb);
    },
    killTree,
  };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const stdout = (message: unknown): void => out(`${JSON.stringify(message)}\n`);
  const request = async (method: string): Promise<Rpc> => {
    for (let i = 0; i < 200; i++) {
      const found = sent.find((m) => m.method === method && !handled.has(m));
      if (found !== undefined) {
        handled.add(found);
        return found;
      }
      await tick();
    }
    throw new Error(`no ${method} was sent; got ${sent.map((m) => m.method).join(', ')}`);
  };
  const handled = new Set<Rpc>();
  return {
    proc,
    sent,
    stdout,
    killTree,
    ended: () => ended,
    exit: (code) => exits.forEach((cb) => cb(code)),
    request,
    reply: async (req, result = {}) => {
      stdout({ jsonrpc: '2.0', id: req.id, result });
      await tick();
    },
    fail: async (req, message) => {
      stdout({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message } });
      await tick();
    },
    sentMethods: () => sent.map((m) => m.method ?? '(reply)'),
  };
}

function collect(overrides: Partial<ProviderStart> = {}): { events: NormalizedEvent[]; sessions: string[]; start: ProviderStart } {
  const events: NormalizedEvent[] = [];
  const sessions: string[] = [];
  return {
    events,
    sessions,
    start: {
      cwd: 'C:/scratch',
      instruction: 'do the thing',
      model: null,
      permissionMode: 'accept-edits',
      resumeRef: null,
      ticketId: 'T-0001',
      onEvent: (e) => events.push(e),
      onSessionRef: (r) => sessions.push(r),
      ...overrides,
    },
  };
}

const update = (u: Record<string, unknown>): unknown => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_1', update: u } });
const textChunk = (kind: string, t: string): unknown => update({ sessionUpdate: kind, content: { type: 'text', text: t } });
const record = (over: Partial<KimiUsageRecord> = {}): KimiUsageRecord => ({ model: 'kimi-code/k3', inputOther: 700, output: 100, cacheRead: 300, cacheCreation: 0, ...over });

/** Drives the handshake to the first `session/prompt`; returns that request. */
async function handshake(rpc: ReturnType<typeof fakeAcp>): Promise<Rpc> {
  await rpc.reply(await rpc.request('initialize'), { protocolVersion: 1 });
  await rpc.reply(await rpc.request('session/new'), { sessionId: 'ses_1' });
  await rpc.reply(await rpc.request('session/set_mode'));
  return rpc.request('session/prompt');
}

describe('kimiAdapter', () => {
  it('starts a session, prompts the brief and ends the run on end_turn with the wire log usage', async () => {
    const rpc = fakeAcp();
    const { events, sessions, start } = collect({ model: 'kimi-code/k3' });
    const handle = kimiAdapter(() => rpc.proc, async () => [record(), record({ inputOther: 100, output: 50, cacheRead: 900 })]).spawn(start);
    await rpc.reply(await rpc.request('initialize'), { protocolVersion: 1 });
    const create = await rpc.request('session/new');
    expect(create.params).toMatchObject({ cwd: 'C:/scratch', mcpServers: [] });
    await rpc.reply(create, { sessionId: 'ses_1' });
    expect(sessions).toEqual(['ses_1']);
    const mode = await rpc.request('session/set_mode');
    expect(mode.params).toMatchObject({ sessionId: 'ses_1', modeId: 'auto' });
    await rpc.reply(mode);
    const model = await rpc.request('session/set_config_option');
    expect(model.params).toMatchObject({ configId: 'model', value: 'kimi-code/k3' });
    await rpc.reply(model);
    const prompt = await rpc.request('session/prompt');
    expect(prompt.params).toMatchObject({ sessionId: 'ses_1', prompt: [{ type: 'text', text: 'do the thing' }] });

    rpc.stdout(textChunk('agent_thought_chunk', 'Look first.'));
    rpc.stdout(update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write', kind: 'edit', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: '{"path":"a.txt","content":"x\\ny"}' } }] }));
    rpc.stdout(update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'Wrote 3 bytes to a.txt' }));
    rpc.stdout(textChunk('agent_message_chunk', 'All '));
    rpc.stdout(textChunk('agent_message_chunk', 'done.'));
    rpc.stdout(update({ sessionUpdate: 'usage_update', used: 1200, size: 1000000 }));
    await rpc.reply(prompt, { stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(events.filter((e) => e.kind === 'note').map((e) => e.text)).toEqual(['thinking › Look first.', 'Write a.txt', 'result › Wrote 3 bytes to a.txt']);
    expect(events.find((e) => e.tool === 'Write')?.changes).toEqual({ added: 2, removed: 0 });
    expect(events.some((e) => e.contextWindow === 1_000_000 && e.contextTokens === 1200)).toBe(true);
    expect(events.filter((e) => e.turnUsage !== undefined)).toHaveLength(2);
    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ text: 'All done.', blocked: null, tokensIn: 2000, tokensOut: 150, cacheReadTokens: 1200 });
    expect(result?.costUsd).toBeCloseTo((2000 * 0.6 + 150 * 2.5) / 1_000_000, 4);
    expect(rpc.ended()).toBe(true);
    expect(rpc.killTree).toHaveBeenCalled();
    rpc.exit(0);
    await expect(handle.exited).resolves.toBe(0);
  });

  it('maps bypass to yolo and omits the model when none is set', async () => {
    const rpc = fakeAcp();
    const { start } = collect({ permissionMode: 'bypass' });
    kimiAdapter(() => rpc.proc).spawn(start);
    await rpc.reply(await rpc.request('initialize'));
    await rpc.reply(await rpc.request('session/new'), { sessionId: 'ses_1' });
    const mode = await rpc.request('session/set_mode');
    expect(mode.params).toMatchObject({ modeId: 'yolo' });
    await rpc.reply(mode);
    await rpc.request('session/prompt');
    expect(rpc.sentMethods()).not.toContain('session/set_config_option');
  });

  it('reports a failed resume instead of prompting', async () => {
    const rpc = fakeAcp();
    const failed: string[] = [];
    const { start } = collect({ resumeRef: 'ses_old', onResumeFailed: (r) => failed.push(r) });
    kimiAdapter(() => rpc.proc).spawn(start);
    await rpc.reply(await rpc.request('initialize'));
    const load = await rpc.request('session/load');
    expect(load.params).toMatchObject({ sessionId: 'ses_old', cwd: 'C:/scratch' });
    await rpc.fail(load, 'session not found');
    expect(failed).toEqual(['session not found']);
    expect(rpc.sentMethods()).not.toContain('session/prompt');
    expect(rpc.ended()).toBe(true);
  });

  it('resumes with session/load, skips the usage the session had spent and compacts first', async () => {
    const rpc = fakeAcp();
    const { events, start } = collect({ resumeRef: 'ses_old', compactFirst: true });
    const reads: KimiUsageRecord[][] = [[record(), record()], [record(), record(), record({ inputOther: 50, output: 10, cacheRead: 0 })]];
    kimiAdapter(() => rpc.proc, async () => reads.shift() ?? reads[0] ?? []).spawn(start);
    await rpc.reply(await rpc.request('initialize'));
    await rpc.reply(await rpc.request('session/load'));
    await rpc.reply(await rpc.request('session/set_mode'));
    const compact = await rpc.request('session/prompt');
    expect(compact.params).toMatchObject({ prompt: [{ type: 'text', text: '/compact' }] });
    await rpc.reply(compact, { stopReason: 'end_turn' });
    const brief = await rpc.request('session/prompt');
    expect(brief.params).toMatchObject({ prompt: [{ type: 'text', text: 'do the thing' }] });
    await rpc.reply(brief, { stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ tokensIn: 50, tokensOut: 10 });
  });

  it('holds an approval request as the run wait and answers it with the chosen option', async () => {
    const rpc = fakeAcp();
    const { events, start } = collect();
    const handle = kimiAdapter(() => rpc.proc).spawn(start);
    const prompt = await handshake(rpc);
    rpc.stdout({
      jsonrpc: '2.0',
      id: 0,
      method: 'session/request_permission',
      params: {
        sessionId: 'ses_1',
        options: [
          { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: { toolCallId: 't2', title: 'Bash', content: [{ type: 'content', content: { type: 'text', text: 'Requesting approval to Running: npm test' } }] },
      },
    });
    const wait = events.find((e) => e.waiting?.kind === 'permission');
    expect(wait?.waiting).toMatchObject({ kind: 'permission', requestId: '0', text: 'Bash — Running: npm test' });
    expect(await handle.answerPermission?.('0', 'always')).toBe(true);
    expect(rpc.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'approve_always' } } });
    expect(await handle.answerPermission?.('0', 'once')).toBe(false);
    await rpc.reply(prompt, { stopReason: 'end_turn' });
  });

  it('turns AskUserQuestion into a question wait; a label picks the option, free text skips and rides next', async () => {
    const rpc = fakeAcp();
    const { events, start } = collect();
    const handle = kimiAdapter(() => rpc.proc).spawn(start);
    const prompt = await handshake(rpc);
    rpc.stdout(update({ sessionUpdate: 'tool_call', toolCallId: 'q1', title: 'AskUserQuestion', kind: 'other', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ questions: [{ header: 'Colour', question: 'Which colour?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }] }) } }] }));
    const ask = (id: number): void =>
      rpc.stdout({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          options: [
            { optionId: 'q0_opt_0', name: 'Red', kind: 'allow_once' },
            { optionId: 'q0_opt_1', name: 'Blue', kind: 'allow_once' },
            { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
          ],
          toolCall: { toolCallId: 'q1', title: 'AskUserQuestion', content: [{ type: 'content', content: { type: 'text', text: 'Which colour?' } }] },
        },
      });
    ask(1);
    const wait = events.find((e) => e.waiting?.kind === 'question')?.waiting;
    expect(wait?.questions).toEqual([{ key: 'q0', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }], multiple: false }]);
    expect(await handle.answerQuestion?.('1', { q0: 'blue' })).toBe(true);
    expect(rpc.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'selected', optionId: 'q0_opt_1' } } });

    ask(2);
    expect(await handle.answerQuestion?.('2', { q0: 'green, please' })).toBe(true);
    expect(rpc.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 2, result: { outcome: { outcome: 'selected', optionId: 'q0_skip' } } });
    await rpc.reply(prompt, { stopReason: 'end_turn' });
    const next = await rpc.request('session/prompt');
    expect(next.params).toMatchObject({ prompt: [{ type: 'text', text: 'green, please' }] });
    expect(rpc.ended()).toBe(false);
  });

  it('a turn that ends with QUESTION: stands for the owner instead of ending the run', async () => {
    const rpc = fakeAcp();
    const { events, start } = collect();
    const handle = kimiAdapter(() => rpc.proc).spawn(start);
    const prompt = await handshake(rpc);
    rpc.stdout(textChunk('agent_message_chunk', 'Checked.\nQUESTION: which branch?'));
    await rpc.reply(prompt, { stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.some((e) => e.waiting?.kind === 'question' && e.waiting.text === 'which branch?')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(rpc.ended()).toBe(false);
    expect(await handle.steer('main')).toBe('inject');
    const answer = await rpc.request('session/prompt');
    expect(answer.params).toMatchObject({ prompt: [{ type: 'text', text: 'main' }] });
  });

  it('records BLOCKED: on the result', async () => {
    const rpc = fakeAcp();
    const { events, start } = collect();
    kimiAdapter(() => rpc.proc).spawn(start);
    const prompt = await handshake(rpc);
    rpc.stdout(textChunk('agent_message_chunk', 'BLOCKED: merge conflict'));
    await rpc.reply(prompt, { stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.find((e) => e.kind === 'result')?.blocked).toBe('merge conflict');
  });

  it('steer while a turn runs cancels it and prompts the message next; interrupt only cancels', async () => {
    const rpc = fakeAcp();
    const { start } = collect();
    const handle = kimiAdapter(() => rpc.proc).spawn(start);
    const prompt = await handshake(rpc);
    expect(await handle.steer('Change course')).toBe('inject');
    expect(rpc.sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'ses_1' } });
    await rpc.reply(prompt, { stopReason: 'cancelled' });
    const next = await rpc.request('session/prompt');
    expect(next.params).toMatchObject({ prompt: [{ type: 'text', text: 'Change course' }] });
    expect(await handle.interrupt?.()).toBe(true);
    expect(rpc.sent.at(-1)).toMatchObject({ method: 'session/cancel' });
    await rpc.reply(next, { stopReason: 'cancelled' });
    expect(rpc.ended()).toBe(false);
    expect(await handle.interrupt?.()).toBe(false);
  });

  it('a held worker keeps its process past a finished turn; releasing it ends the run', async () => {
    const rpc = fakeAcp();
    const { start } = collect();
    const handle = kimiAdapter(() => rpc.proc).spawn(start);
    handle.setHold?.(true);
    const prompt = await handshake(rpc);
    await rpc.reply(prompt, { stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rpc.ended()).toBe(false);
    handle.setHold?.(false);
    expect(rpc.ended()).toBe(true);
  });

  it('turns a failing prompt into an error event and ends the run', async () => {
    const rpc = fakeAcp();
    const { events, start } = collect();
    kimiAdapter(() => rpc.proc).spawn(start);
    const prompt = await handshake(rpc);
    await rpc.fail(prompt, 'rate limit exceeded (429)');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.find((e) => e.kind === 'error')?.text).toContain('rate limit exceeded (429)');
    expect(rpc.ended()).toBe(true);
  });

  it('refuses requests it cannot serve and stop kills the tree', async () => {
    const rpc = fakeAcp();
    const { start } = collect();
    const handle = kimiAdapter(() => rpc.proc).spawn(start);
    await handshake(rpc);
    rpc.stdout({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: {} });
    expect(rpc.sent.at(-1)).toMatchObject({ id: 9, error: { code: -32601 } });
    await handle.stop();
    expect(rpc.killTree).toHaveBeenCalled();
    expect(await handle.steer('late')).toBe('refused');
  });
});

describe('parseKimiWire', () => {
  it('reads the usage.record lines in order and skips the rest', () => {
    const wire = [
      '{"type":"metadata","protocol_version":"1.5"}',
      '{"type":"usage.record","agentId":"main","model":"zai-coding-plan/glm-5.3-flash","usage":{"inputOther":16734,"output":668,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn"}',
      '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":1}}}',
      '{"type":"usage.record","model":"x","usage":{"inputOther":745,"output":165,"inputCacheRead":16704,"inputCacheCreation":2}}',
      '{"type":"usage.record","model":"x","usa',
    ].join('\n');
    expect(parseKimiWire(wire)).toEqual([
      { model: 'zai-coding-plan/glm-5.3-flash', inputOther: 16734, output: 668, cacheRead: 0, cacheCreation: 0 },
      { model: 'x', inputOther: 745, output: 165, cacheRead: 16704, cacheCreation: 2 },
    ]);
  });
});
