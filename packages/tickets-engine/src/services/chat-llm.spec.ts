import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from '../contracts/chat';
import { createChatBridge, MISSION_SYSTEM_PROMPT } from './chat-llm';

/**
 * The Mission Control bridge (E5a): one POST against the OpenAI-compatible
 * chat/completions endpoint (or, for the Anthropic-Messages providers,
 * /v1/messages), live text deltas off the SSE stream, and the final
 * say/thought/commands from the strict envelope. Every failure —
 * unconfigured, unsupported provider, unreachable, refused, stalled —
 * resolves an outcome with a named `failure` and never throws; an
 * unreadable answer resolves an honest say. A fake fetch proves the wire
 * shape (D-1, milestone 131).
 */

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch stand-in that serves one scripted SSE body and records the call. */
function fakeFetch(calls: RecordedCall[], frames: string[], status = 200): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (status !== 200) {
      return new Response('boom', { status });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

/** A fetch stand-in whose body never yields and that aborts with the signal. */
function hangingFetch(calls: RecordedCall[]): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init && (init as RequestInit).signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
}

function chatConfig(values: Record<string, string>): { get<T>(key: string): Promise<T | undefined> } {
  return { get: async <T,>(key: string) => values[key] as T | undefined };
}

const BOARD = '## Board digest\n- inbox: T-0086 (normal)\n- build: T-0091 (high)';

/** The OpenAI-style SSE frame for one content delta. */
function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

function collect(): { events: ChatStreamEvent[]; emit(event: ChatStreamEvent): void } {
  const events: ChatStreamEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

describe('createChatBridge', () => {
  it('posts the wire shape the OpenAI-compatible dialect expects', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1/', 'chat.apiKey': 'sk-test-1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [frame('{"say":"Hi."}'), 'data: [DONE]\n\n']),
    });
    const { events, emit } = collect();
    await bridge.runTurn({
      text: 'What is on the board?',
      history: [
        { role: 'owner', text: 'morning' },
        { role: 'mission', text: 'good morning' },
      ],
      board: BOARD,
      emit,
    });

    expect(calls).toHaveLength(1);
    // The trailing slash of the base URL is folded away.
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test-1');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('glm-5');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain(MISSION_SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain(BOARD);
    expect(body.messages.slice(1)).toEqual([
      { role: 'user', content: 'morning' },
      { role: 'assistant', content: 'good morning' },
      { role: 'user', content: 'What is on the board?' },
    ]);
    expect(events.length).toBeGreaterThan(0);
  });

  it('omits the bearer header when no api key is configured', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [frame('{"say":"Hi."}')]),
    });
    await bridge.runTurn({ text: 'hi', history: [], board: BOARD, emit: () => undefined });
    expect(calls[0].init.headers).not.toHaveProperty('authorization');
  });

  it('streams live text deltas while accumulating, then answers from the envelope', async () => {
    const part1 = '{"say":"Moving it.","thought":"T-0086 sits in build; review is next.",';
    const part2 = '"commands":[{"kind":"transition","id":"T-0086","from":"build","to":"review"}]}';
    const calls: RecordedCall[] = [];
    // The first frame is split mid-line to prove the SSE buffer reassembles it.
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.apiKey': 'k', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part1 } }] })}\n\nda`, `ta: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part2 } }] })}\n\n`, 'data: [DONE]\n\n']),
    });
    const { events, emit } = collect();
    const result = await bridge.runTurn({ text: 'Move T-0086 to review', history: [], board: BOARD, emit });

    expect(events).toEqual([
      { kind: 'text', text: part1 },
      { kind: 'text', text: part2 },
    ]);
    expect(result).toEqual({
      say: 'Moving it.',
      thought: 'T-0086 sits in build; review is next.',
      commands: [{ kind: 'transition', id: 'T-0086', from: 'build', to: 'review' }],
    });
  });

  it('resolves a not-configured failure without calling the model — and never throws', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1' }), // no model
      fetch: fakeFetch(calls, []),
    });
    const { events, emit } = collect();
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit });

    expect(calls).toHaveLength(0);
    expect(result.commands).toEqual([]);
    expect(result.thought).toBeNull();
    expect(result.failure).toMatchObject({ code: 'not-configured', baseUrl: 'http://127.0.0.1:1234/v1', model: null });
    expect(result.say).toBe(result.failure?.message);
    expect(result.say).toMatch(/no model is selected/);
    // The failure is the service's to report (error card), not a streamed reply.
    expect(events).toEqual([]);
  });

  it('treats a blank base URL as unconfigured too', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': '   ', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, []),
    });
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit: () => undefined });
    expect(calls).toHaveLength(0);
    expect(result.failure?.code).toBe('not-configured');
    expect(result.say).toMatch(/no endpoint is set/);
    expect(result.commands).toEqual([]);
  });

  it('answers honestly when the provider answers non-OK', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.apiKey': 'k', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [], 500),
    });
    const { events, emit } = collect();
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit });

    expect(result.commands).toEqual([]);
    expect(result.failure).toMatchObject({ code: 'refused', providerLabel: 'OpenAI-compatible server', baseUrl: 'http://127.0.0.1:1234/v1', model: 'glm-5' });
    expect(result.say).toMatch(/HTTP 500/);
    expect(events).toEqual([]);
  });

  it('answers honestly when the transport itself fails', async () => {
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: (async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
    });
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit: () => undefined });
    expect(result.commands).toEqual([]);
    expect(result.failure?.code).toBe('unreachable');
    expect(result.say).toMatch(/connection refused/);
    expect(result.say).toContain('http://127.0.0.1:1234/v1');
  });

  it('names the cause node hides behind "fetch failed" (nothing listening)', async () => {
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://localhost:1234/v1', 'chat.model': 'glm-5.3-flash' }),
      fetch: (async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      }) as typeof fetch,
    });
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit: () => undefined });
    expect(result.failure?.reason).toMatch(/nothing is listening/);
    expect(result.say).not.toMatch(/fetch failed/);
    expect(result.say).toContain('http://localhost:1234/v1');
  });

  it('speaks the Anthropic Messages dialect for zai-glm and anthropic', async () => {
    const calls: RecordedCall[] = [];
    const text = '{"say":"Hello from Pia.","thought":"","commands":[]}';
    const bridge = createChatBridge({
      config: chatConfig({
        'chat.provider': 'zai-glm',
        'chat.baseUrl': 'https://api.z.ai/api/anthropic/',
        'chat.apiKey': 'zk',
        'chat.model': 'glm-5.3-flash',
      }),
      fetch: fakeFetch(calls, [
        'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start' }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + '\n\n',
        'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
      ]),
    });
    const { events, emit } = collect();
    const result = await bridge.runTurn({
      text: 'Anyone there?',
      history: [{ role: 'owner', text: 'Hi' }, { role: 'mission', text: 'Hello.' }],
      board: BOARD,
      emit,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('zk');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['authorization']).toBeUndefined();
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; stream: boolean; max_tokens: number; system: string; messages: { role: string }[] };
    expect(body).toMatchObject({ model: 'glm-5.3-flash', stream: true, max_tokens: 4096 });
    expect(body.system).toContain('You are Mission Control');
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(events).toEqual([{ kind: 'text', text }]);
    expect(result.say).toBe('Hello from Pia.');
    expect(result.failure).toBeUndefined();
  });

  it('refuses a provider it cannot speak by name, without calling anything', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.provider': 'copilot-cli', 'chat.baseUrl': 'http://localhost:1234/v1', 'chat.model': 'gpt' }),
      fetch: fakeFetch(calls, []),
    });
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit: () => undefined });
    expect(calls).toHaveLength(0);
    expect(result.failure).toMatchObject({ code: 'unsupported', providerLabel: 'GitHub Copilot CLI' });
    expect(result.say).toMatch(/cannot talk to this provider/);
  });

  it('is switched off with the assistant master switch', async () => {
    const calls: RecordedCall[] = [];
    const values: Record<string, unknown> = { 'chat.baseUrl': 'http://x/v1', 'chat.model': 'm', 'chat.enabled': false };
    const bridge = createChatBridge({
      config: { get: async <T,>(key: string) => values[key] as T | undefined },
      fetch: fakeFetch(calls, []),
    });
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit: () => undefined });
    expect(calls).toHaveLength(0);
    expect(result.failure?.reason).toMatch(/switched off/);
  });

  it('answers honestly when the reply holds no envelope', async () => {
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch([], [frame('plain prose, no envelope at all')]),
    });
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit: () => undefined });
    expect(result.commands).toEqual([]);
    expect(result.say).toMatch(/outside its envelope/);
  });

  it('gives up honestly when the model stalls past the 120 s turn timeout', async () => {
    vi.useFakeTimers();
    try {
      const calls: RecordedCall[] = [];
      const bridge = createChatBridge({
        config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
        fetch: hangingFetch(calls),
      });
      const { events, emit } = collect();
      const pending = bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit });
      await vi.advanceTimersByTimeAsync(121_000);
      const result = await pending;

      expect(calls).toHaveLength(1);
      expect(result.commands).toEqual([]);
      expect(result.failure?.code).toBe('timeout');
      expect(result.say).toMatch(/too long/);
      expect(events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the tickets the owner named after the digest, before any desktop reference (D-7a)', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [frame('{"say":"Done."}')]),
    });
    await bridge.runTurn({
      text: 'what is T-0091?',
      history: [],
      board: BOARD,
      named: '## Tickets the owner named\n\n### T-0091\n\nThe DONE ticket body.',
      reference: 'VAULT CONTEXT',
      emit: () => undefined,
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]!.content;
    expect(system.indexOf(BOARD)).toBeLessThan(system.indexOf('The DONE ticket body.'));
    expect(system.indexOf('The DONE ticket body.')).toBeLessThan(system.indexOf('VAULT CONTEXT'));
    expect(system).toContain('Tickets the owner named');
  });

  it('prompts the promote intent — the scout → ship promotion is one of the six intents', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [frame('{"say":"Understood."}')]),
    });
    await bridge.runTurn({ text: 'promote T-0004', history: [], board: BOARD, emit: () => undefined });

    const body = JSON.parse(String(calls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]!.content;
    expect(system).toContain('exactly six intents');
    expect(system).toContain('- promote —');
    expect(system).toContain('scout');
    expect(system).toMatch(/createTicket, transition, setPriority, promote, setChain, setBlockedBy/);
  });

  it('prompts the blocked intent with the setBlockedBy grammar — the sixth intent', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [frame('{"say":"Understood."}')]),
    });
    await bridge.runTurn({ text: 'T-0002 waits until T-0001 and T-0003 are done', history: [], board: BOARD, emit: () => undefined });

    const body = JSON.parse(String(calls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]!.content;
    expect(system).toContain('- blocked —');
    expect(system).toContain("setBlockedBy replaces the ticket's whole blocked-by list");
    expect(system).toContain('An empty list clears the blockers');
    expect(system).toContain('{"kind":"setBlockedBy","id":"T-0002","blockedBy":["T-0001","T-0003"]}');
    // Priorities come from the board's configured vocabulary, never a hard-coded list.
    expect(system).toContain('the digest\'s "priorities (weight order)" line is the whole vocabulary');
  });

  it('prompts the chain intent with the setChain grammar — the fifth intent', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [frame('{"say":"Understood."}')]),
    });
    await bridge.runTurn({ text: 'notify me when the build gate completes', history: [], board: BOARD, emit: () => undefined });

    const body = JSON.parse(String(calls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]!.content;
    expect(system).toContain('- chain —');
    expect(system).toContain('setChain replaces the ticket\'s whole chain delta');
    expect(system).toContain('insert <phase>[(<persona>[, notify] | notify)] after|before <anchor>');
    expect(system).toContain('skip <phase>');
    expect(system).toContain('notify <phase>');
    expect(system).toContain('An empty list returns the ticket to the standard flow');
    expect(system).toContain('{"kind":"setChain","id":"T-0086","chain":["insert security(ralf, notify) after review","skip verify"]}');
  });

  it('round-trips a promote command from the strict envelope', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [
        frame('{"say":"Promoted — the ticket enters the normal pipeline on its next run.","thought":"The scout report on T-0004 is ready and the owner accepted it.","commands":[{"kind":"promote","id":"T-0004"}]}'),
      ]),
    });
    const result = await bridge.runTurn({ text: 'promote T-0004', history: [], board: BOARD, emit: () => undefined });

    expect(result).toEqual({
      say: 'Promoted — the ticket enters the normal pipeline on its next run.',
      thought: 'The scout report on T-0004 is ready and the owner accepted it.',
      commands: [{ kind: 'promote', id: 'T-0004' }],
    });
  });

  it('round-trips a setChain command from the strict envelope', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [
        frame('{"say":"The chain now skips verify and notifies you after design.","thought":"The owner wants verify bypassed and a Bescheid on the inserted design gate.","commands":[{"kind":"setChain","id":"T-0086","chain":["insert security(ralf, notify) after review","skip verify"]}]}'),
      ]),
    });
    const result = await bridge.runTurn({ text: 'skip verify and tell me when design is done', history: [], board: BOARD, emit: () => undefined });

    expect(result).toEqual({
      say: 'The chain now skips verify and notifies you after design.',
      thought: 'The owner wants verify bypassed and a Bescheid on the inserted design gate.',
      commands: [
        {
          kind: 'setChain',
          id: 'T-0086',
          chain: ['insert security(ralf, notify) after review', 'skip verify'],
        },
      ],
    });
  });

  it('round-trips a setBlockedBy command and validates priorities against the vocabulary the turn carries', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [
        frame('{"say":"T-0002 waits for T-0001 and T-0003 now.","thought":"The owner wants the dependency, and p0 as the class.","commands":[{"kind":"setBlockedBy","id":"T-0002","blockedBy":["T-0001","T-0003"]},{"kind":"setPriority","id":"T-0002","priority":"p0"},{"kind":"setPriority","id":"T-0002","priority":"low"}]}'),
      ]),
    });
    const result = await bridge.runTurn({
      text: 'block T-0002 behind T-0001 and T-0003',
      history: [],
      board: BOARD,
      priorities: { order: ['p0', 'p1', 'p2'], default: 'p1' },
      emit: () => undefined,
    });

    expect(result).toEqual({
      say: 'T-0002 waits for T-0001 and T-0003 now.',
      thought: 'The owner wants the dependency, and p0 as the class.',
      commands: [
        { kind: 'setBlockedBy', id: 'T-0002', blockedBy: ['T-0001', 'T-0003'] },
        // `p0` is the vault's word; the default vocabulary's `low` drops.
        { kind: 'setPriority', id: 'T-0002', priority: 'p0' },
      ],
    });
  });
});
