import { describe, expect, it } from 'vitest';
import { registerChatIpc } from './chat-ipc';

const FILE = 'tickets/_meta/chat/20261104-100000-demo.md';

function setup() {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const calls: { method: string; payload: unknown }[] = [];
  registerChatIpc(
    { ipc: { handle: (name: string, fn: (payload: unknown) => unknown) => handlers.set(name, fn) } } as never,
    (method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({ ok: true });
    },
  );
  return { call: (name: string, payload?: unknown) => handlers.get(name)!(payload), calls };
}

describe('registerChatIpc', () => {
  it('forwards a well-formed send, start and decision to the engine chat', async () => {
    const { call, calls } = setup();
    await call('mcSessions');
    await call('mcOpen', { file: FILE });
    await call('mcStart', { text: 'Hi' });
    await call('mcSend', { file: FILE, text: 'More' });
    await call('mcDecide', { file: FILE, id: 'p-2', decision: 'dismiss' });
    await call('mcShapeDecide', { file: FILE, choice: 'split' });
    await call('mcStart', { text: 'Shape', ticket: 'T-0130' });
    await call('mcPlanStatus', { ticket: 'T-0130' });
    await call('mcSend', { file: FILE, text: 'With notes', context: 'VAULT CONTEXT' });
    expect(calls.map((c) => c.method)).toEqual([
      'chatSessions',
      'chatOpen',
      'chatStart',
      'chatSend',
      'chatDismiss',
      'chatShapeDecide',
      'chatStart',
      'chatPlanStatus',
      'chatSend',
    ]);
    expect(calls[8]?.payload).toEqual({ file: FILE, text: 'With notes', context: 'VAULT CONTEXT' });
    expect(calls[6]?.payload).toEqual({ text: 'Shape', ticket: 'T-0130' });
    expect(calls[7]?.payload).toBe('T-0130');
    expect(calls[1]?.payload).toBe(FILE);
  });

  it('refuses a session file outside the chat folder, a bad card id and an unknown decision', () => {
    const { call, calls } = setup();
    expect(call('mcOpen', { file: 'tickets/evil.md' })).toEqual({ ok: false, error: 'bad session payload' });
    expect(call('mcSend', { file: '../x.md', text: 'x' })).toEqual({ ok: false, error: 'bad message payload' });
    expect(call('mcDecide', { file: FILE, id: 'x-1', decision: 'confirm' })).toEqual({ ok: false, error: 'bad decision payload' });
    expect(call('mcDecide', { file: FILE, id: 'p-1', decision: 'delete' })).toEqual({ ok: false, error: 'bad decision payload' });
    expect(call('mcStart', { text: '  ' })).toEqual({ ok: false, error: 'bad message payload' });
    expect(call('mcStart', { text: 'x', ticket: 'nope' })).toEqual({ ok: false, error: 'bad ticket payload' });
    expect(call('mcPlanStatus', { ticket: '../x' })).toEqual({ ok: false, error: 'bad ticket payload' });
    expect(calls).toEqual([]);
  });
});
