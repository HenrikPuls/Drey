import { describe, expect, it } from 'vitest';
import { createChatBridge, FLOW_SYSTEM_PROMPT } from './chat-llm';

/**
 * E10-5: Paul's flow draft on the OpenAI-compatible wire -- the flow
 * prompt replaces the board digest, the flow context rides in the system
 * message, and the reply is the usual envelope with one setChain command.
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

describe('the flow draft turn', () => {
  it('sends the flow prompt with the context and returns the setChain command', async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const bridge = createChatBridge({
      config,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as never);
        return sse(JSON.stringify({ say: 'A security pass fits.', commands: [{ kind: 'setChain', id: 'T-0130', chain: ['insert security(ralf, notify) after review'] }] }));
      }) as typeof fetch,
    });
    const out = await bridge.runTurn({ text: 'Draft the flow.', history: [], board: 'BOARD', flow: { context: 'Standard flow: build -> review' }, emit: () => undefined });
    expect(bodies[0]!.messages[0]!.content).toContain(FLOW_SYSTEM_PROMPT.slice(0, 60));
    expect(bodies[0]!.messages[0]!.content).toContain('Standard flow: build -> review');
    expect(bodies[0]!.messages[0]!.content).not.toContain('BOARD');
    expect(out.commands).toEqual([{ kind: 'setChain', id: 'T-0130', chain: ['insert security(ralf, notify) after review'] }]);
  });

  it('names the new grammar entries', () => {
    expect(FLOW_SYSTEM_PROMPT).toContain('move <phase>');
    expect(FLOW_SYSTEM_PROMPT).toContain('assign <phase>');
  });
});
