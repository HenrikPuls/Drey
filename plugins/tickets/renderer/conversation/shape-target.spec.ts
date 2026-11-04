import { describe, expect, it, vi } from 'vitest';
import type { ShapeTarget } from '../ticket-document/shape';
import { createMissionControlTarget, type ConversationDeps, type ShapeBinding } from './targets';

const TICKET: ShapeTarget = { id: 'T-0130', path: 'tickets/ideas/T-0130.md', label: 'T-0130.md' };
const SHAPE_FILE = 'tickets/_meta/chat/20261104-100000-shape.md';
const OTHER_FILE = 'tickets/_meta/chat/20261104-090000-plain.md';

const session = (file: string, ticket?: string) => ({
  file,
  title: 'Demo',
  createdAt: 'a',
  messages: [{ role: 'owner', at: 'x', kind: 'text', text: 'Hello' }],
  proposals: [],
  ...(ticket === undefined ? {} : { ticket }),
});

function setup(options: { current?: ShapeTarget | null; sessions?: unknown[]; flush?: string | null } = {}) {
  const calls: { method: string; payload: unknown }[] = [];
  const order: string[] = [];
  let current: ShapeTarget | null = options.current === undefined ? TICKET : options.current;
  const listeners = new Set<() => void>();
  const shape: ShapeBinding = {
    current: () => current,
    flush: vi.fn(async () => {
      order.push('flush');
      return options.flush ?? null;
    }),
    lock: vi.fn((_target, locked) => {
      order.push(locked ? 'lock' : 'unlock');
    }),
    settled: vi.fn(() => {
      order.push('settled');
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const sessions = options.sessions ?? [
    { file: SHAPE_FILE, title: 'Shape', createdAt: 'a', updatedAt: 'b', pending: 0, ticket: 'T-0130' },
    { file: OTHER_FILE, title: 'Plain', createdAt: 'a', updatedAt: 'a', pending: 0 },
  ];
  const deps: ConversationDeps = {
    invoke: (method, payload) => {
      calls.push({ method, payload });
      order.push(method);
      if (method === 'mcSessions') {
        return Promise.resolve(sessions);
      }
      if (method === 'mcOpen') {
        const file = (payload as { file: string }).file;
        return Promise.resolve(session(file, file === SHAPE_FILE ? 'T-0130' : undefined));
      }
      return Promise.resolve({ ok: true, file: SHAPE_FILE });
    },
    personas: () => [],
    subscribePersonas: () => () => undefined,
    shape,
  };
  return {
    target: createMissionControlTarget(deps),
    calls,
    order,
    shape,
    focus: (next: ShapeTarget | null) => {
      current = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

describe('Mission Control with a ticket document in focus (E13-9)', () => {
  it("shows that ticket's shape session with the file attached", async () => {
    const { target, calls } = setup();
    const thread = await target.thread();
    expect(thread.id).toBe(SHAPE_FILE);
    expect(thread.attached).toEqual(['T-0130.md attached']);
    expect(calls.find((c) => c.method === 'mcOpen')?.payload).toEqual({ file: SHAPE_FILE });
  });

  it('waits with a fresh composer when the ticket has no session yet', async () => {
    const { target } = setup({ sessions: [{ file: OTHER_FILE, title: 'Plain', createdAt: 'a', updatedAt: 'a', pending: 0 }] });
    const thread = await target.thread();
    expect(thread.id).toBeNull();
    expect(thread.messages).toEqual([]);
    expect(thread.attached).toEqual(['T-0130.md attached']);
    expect(thread.notice).toBe('Shaping T-0130 with Paul');
  });

  it('saves the document first, locks it while Paul works and unlocks and refreshes after', async () => {
    const { target, order, calls } = setup();
    await target.thread();
    order.length = 0;
    await target.send('Make it three parts');
    expect(order.slice(0, 4)).toEqual(['flush', 'lock', 'mcSend', 'mcOpen']);
    expect(order.slice(-2)).toEqual(['unlock', 'settled']);
    expect(calls.find((c) => c.method === 'mcSend')?.payload).toEqual({ file: SHAPE_FILE, text: 'Make it three parts' });
  });

  it('starts the first message as a shape session of the ticket', async () => {
    const { target, calls } = setup({ sessions: [] });
    await target.thread();
    await target.send('Shape this');
    expect(calls.find((c) => c.method === 'mcStart')?.payload).toEqual({ text: 'Shape this', ticket: 'T-0130' });
  });

  it('sends nothing and shows the reason when the document could not be saved', async () => {
    const { target, calls, shape } = setup({ flush: 'T-0130.md still has unsaved changes. Save it, then send again.' });
    await target.thread();
    const thread = await target.send('Go');
    expect(calls.some((c) => c.method === 'mcSend' || c.method === 'mcStart')).toBe(false);
    expect(thread.messages.at(-1)?.error?.lines).toEqual(['T-0130.md still has unsaved changes. Save it, then send again.']);
    expect(shape.lock).not.toHaveBeenCalled();
  });

  it('unlocks even when the turn is refused', async () => {
    const { target, shape } = setup();
    await target.thread();
    const thread = await target.send('Go');
    expect(thread.messages).toBeDefined();
    expect(shape.lock).toHaveBeenLastCalledWith(TICKET, false);
  });

  it('reads again when another document comes into focus, and only then', async () => {
    const { target, focus } = setup();
    const heard = vi.fn();
    target.onThreadChange?.(heard);
    focus(TICKET);
    expect(heard).not.toHaveBeenCalled();
    focus(null);
    expect(heard).toHaveBeenCalledTimes(1);
    const plain = await target.thread();
    expect(plain.attached).toBeUndefined();
    // The newest session of the vault, not the ticket's.
    expect(plain.id).toBe(SHAPE_FILE);
  });

  it('routes the split decision to the open shape session and refreshes the board', async () => {
    const { target, calls, shape } = setup();
    await target.thread();
    await target.act('s-1', 'keep');
    expect(calls.find((c) => c.method === 'mcShapeDecide')?.payload).toEqual({ file: SHAPE_FILE, choice: 'keep' });
    expect(shape.settled).toHaveBeenCalledWith(TICKET);
  });

  it('offers no change notice without a binding', () => {
    const deps: ConversationDeps = { invoke: () => Promise.resolve([]), personas: () => [], subscribePersonas: () => () => undefined };
    expect(createMissionControlTarget(deps).onThreadChange).toBeUndefined();
  });
});
