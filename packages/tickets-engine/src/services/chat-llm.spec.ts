import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from '../contracts/chat';
import { createChatBridge, MISSION_SYSTEM_PROMPT } from './chat-llm';

/**
 * The Mission Control bridge (E5a): one POST against the OpenAI-compatible
 * chat/completions endpoint, live text deltas off the SSE stream, and the
 * final say/thought/commands from the strict envelope. Every failure —
 * unconfigured, unreachable, unreadable, stalled — resolves an honest
 * envelope and never throws. A fake fetch proves the wire shape.
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

  it('resolves an honest unconfigured envelope without calling the model — and never throws', async () => {
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
    expect(result.say).toMatch(/not set up yet/);
    expect(events).toEqual([{ kind: 'text', text: result.say }]);
  });

  it('treats a blank base URL as unconfigured too', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': '   ', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, []),
    });
    const result = await bridge.runTurn({ text: 'hello?', history: [], board: BOARD, emit: () => undefined });
    expect(calls).toHaveLength(0);
    expect(result.say).toMatch(/not set up yet/);
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
    expect(result.say).toMatch(/500/);
    expect(events).toEqual([{ kind: 'text', text: result.say }]);
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
    expect(result.say).toMatch(/connection refused/);
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
      expect(result.say).toMatch(/too long/);
      expect(events).toEqual([{ kind: 'text', text: result.say }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prompts the promote intent — the scout → ship promotion is one of the five intents', async () => {
    const calls: RecordedCall[] = [];
    const bridge = createChatBridge({
      config: chatConfig({ 'chat.baseUrl': 'http://127.0.0.1:1234/v1', 'chat.model': 'glm-5' }),
      fetch: fakeFetch(calls, [frame('{"say":"Understood."}')]),
    });
    await bridge.runTurn({ text: 'promote T-0004', history: [], board: BOARD, emit: () => undefined });

    const body = JSON.parse(String(calls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]!.content;
    expect(system).toContain('exactly five intents');
    expect(system).toContain('- promote —');
    expect(system).toContain('scout');
    expect(system).toMatch(/createTicket, transition, setPriority, promote, setChain/);
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
    expect(system).toContain('{"kind":"setChain","id":"T-0086","chain":["insert design(pia, notify) after review","skip verify"]}');
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
        frame('{"say":"The chain now skips verify and notifies you after design.","thought":"The owner wants verify bypassed and a Bescheid on the inserted design gate.","commands":[{"kind":"setChain","id":"T-0086","chain":["insert design(pia, notify) after review","skip verify"]}]}'),
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
          chain: ['insert design(pia, notify) after review', 'skip verify'],
        },
      ],
    });
  });
});
