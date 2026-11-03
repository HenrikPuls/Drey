import { describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '../contracts/chat';
import { parseEnvelope } from '../core/chat-intents';
import { createChatBridge, SHAPE_SYSTEM_PROMPT } from './chat-llm';

/**
 * E10-3: a shape turn on the OpenAI-compatible wire. Paul's envelope
 * carries the plan, one question and a split reason; his `read` requests
 * are answered from the ticket's repository for a bounded few rounds
 * before the final reply.
 */

function sse(content: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const config = { get: async <T,>(key: string) => ({ 'chat.baseUrl': 'http://llm/v1', 'chat.model': 'm' })[key] as T | undefined };

describe('the shape envelope', () => {
  it('reads plan, question, split reason and read requests', () => {
    const envelope = parseEnvelope(
      JSON.stringify({
        say: 'Done',
        plan: '### Goal\n\nx',
        question: { text: 'Which?', options: [{ label: 'A', recommended: true }, 'B', { label: 'C', recommended: true }, 'D', 'E'] },
        split: { reason: 'Parts ship alone' },
        read: ['CLAUDE.md', 'CLAUDE.md', 'src/'],
      }),
    )!;
    expect(envelope.plan).toBe('### Goal\n\nx');
    expect(envelope.question).toEqual({
      text: 'Which?',
      options: [
        { label: 'A', recommended: true },
        { label: 'B', recommended: false },
        { label: 'C', recommended: false },
        { label: 'D', recommended: false },
      ],
    });
    expect(envelope.splitReason).toBe('Parts ship alone');
    expect(envelope.read).toEqual(['CLAUDE.md', 'src/']);
  });

  it('drops a question without two usable choices and an empty split', () => {
    const envelope = parseEnvelope(JSON.stringify({ say: 'x', question: { text: 'Which?', options: ['A'] }, split: {}, plan: '   ' }))!;
    expect(envelope.question).toBeUndefined();
    expect(envelope.splitReason).toBeUndefined();
    expect(envelope.plan).toBeUndefined();
    expect(envelope.read).toBeUndefined();
  });
});

describe('the shape turn', () => {
  it('embeds the ticket under Paul’s prompt and returns the shape reply', async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const bridge = createChatBridge({
      config,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as never);
        return sse(JSON.stringify({ say: 'Here.', plan: '### Goal\n\nx', split: { reason: 'One part' } }));
      }) as typeof fetch,
    });
    const events: ChatStreamEvent[] = [];
    const out = await bridge.runTurn({
      text: 'Shape it',
      history: [],
      board: 'digest',
      shape: { ticket: 'T-0130', ticketText: 'TICKET BODY', readFile: async () => ({ ok: false, error: 'unused' }) },
      emit: (e) => events.push(e),
    });
    expect(bodies[0]!.messages[0]!.content).toContain(SHAPE_SYSTEM_PROMPT);
    expect(bodies[0]!.messages[0]!.content).toContain('## Ticket T-0130\n\nTICKET BODY');
    expect(out.shape).toEqual({ plan: '### Goal\n\nx', question: null, splitReason: 'One part', sources: [] });
  });

  it('answers read requests from the repository, then returns the sources', async () => {
    const replies = [
      JSON.stringify({ say: 'Reading.', read: ['CLAUDE.md', 'missing.ts'] }),
      JSON.stringify({ say: 'Read it.', plan: '### Goal\n\nx' }),
    ];
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const bridge = createChatBridge({
      config,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as never);
        return sse(replies.shift()!);
      }) as typeof fetch,
    });
    const events: ChatStreamEvent[] = [];
    const out = await bridge.runTurn({
      text: 'Shape it',
      history: [],
      board: '',
      shape: {
        ticket: 'T-0130',
        ticketText: 't',
        readFile: async (p) => (p === 'CLAUDE.md' ? { ok: true, text: 'rules' } : { ok: false, error: 'does not exist' }),
      },
      emit: (e) => events.push(e),
    });
    expect(bodies).toHaveLength(2);
    // The finished envelope never streams as text; the screen sees what Paul reads.
    expect(events.filter((e) => e.kind === 'text')).toEqual([]);
    expect(events.filter((e) => e.kind === 'thought')).toEqual([{ kind: 'thought', text: 'Reading CLAUDE.md, missing.ts. ' }]);
    const followUp = bodies[1]!.messages.at(-1)!;
    expect(followUp.role).toBe('user');
    expect(followUp.content).toContain('### CLAUDE.md\nrules');
    expect(followUp.content).toContain('### missing.ts\nError: does not exist');
    expect(out.say).toBe('Read it.');
    expect(out.shape?.sources).toEqual(['CLAUDE.md']);
  });

  it('stops reading after a few rounds and takes the last reply as it is', async () => {
    let calls = 0;
    const bridge = createChatBridge({
      config,
      fetch: (async () => {
        calls += 1;
        return sse(JSON.stringify({ say: `round ${calls}`, read: ['a.ts'] }));
      }) as typeof fetch,
    });
    const out = await bridge.runTurn({
      text: 'x',
      history: [],
      board: '',
      shape: { ticket: 'T-0130', ticketText: 't', readFile: async () => ({ ok: true, text: 'a' }) },
      emit: () => undefined,
    });
    expect(calls).toBe(4);
    expect(out.say).toBe('round 4');
  });

  it('adds no shape reply to a plain turn', async () => {
    const bridge = createChatBridge({ config, fetch: (async () => sse(JSON.stringify({ say: 'hi', plan: 'ignored' }))) as typeof fetch });
    const out = await bridge.runTurn({ text: 'x', history: [], board: '', emit: () => undefined });
    expect(out.shape).toBeUndefined();
  });
});
