import { describe, expect, it } from 'vitest';
import type { PersonaView } from '../../shared/remote-protocol';
import {
  createConversationProvider,
  MISSION_CONTROL_TARGET,
  PERSONA_GROUP,
  personaTargetId,
  type ConversationDeps,
} from './targets';

const persona = (id: string, title: string, kind?: 'human'): PersonaView =>
  ({ id, title, ...(kind !== undefined ? { kind } : {}) }) as unknown as PersonaView;

const FILE = 'tickets/_meta/chat/20261104-100000-demo.md';

function deps(over: Partial<ConversationDeps> = {}) {
  const calls: { method: string; payload: unknown }[] = [];
  const full: ConversationDeps = {
    invoke: (method, payload) => {
      calls.push({ method, payload });
      if (method === 'mcSessions') {
        return Promise.resolve([{ file: FILE, title: 'Demo', createdAt: 'a', updatedAt: 'b', pending: 1 }]);
      }
      if (method === 'mcOpen') {
        return Promise.resolve({ file: FILE, title: 'Demo', createdAt: 'a', messages: [], proposals: [] });
      }
      if (method === 'mcStart' || method === 'mcSend') {
        return Promise.resolve({ ok: true, file: FILE });
      }
      return Promise.resolve({ ok: true, messages: [] });
    },
    personas: () => [persona('paul', 'Paul'), persona('owner', 'You', 'human'), persona('ben', 'Ben')],
    subscribePersonas: () => () => undefined,
    ...over,
  };
  return { deps: full, calls };
}

describe('createConversationProvider', () => {
  it('offers Mission Control first, then one 1:1 per agent persona', () => {
    const targets = createConversationProvider(deps().deps).targets();
    expect(targets.map((t) => t.id)).toEqual([MISSION_CONTROL_TARGET, personaTargetId('paul'), personaTargetId('ben')]);
    expect(targets[1]?.group).toBe(PERSONA_GROUP);
  });

  it('keeps a persona target stable between calls', () => {
    const provider = createConversationProvider(deps().deps);
    expect(provider.targets()[1]).toBe(provider.targets()[1]);
  });
});

describe('the Mission Control target', () => {
  it('opens the newest session, sends into it and starts a fresh one on a new thread', async () => {
    const { deps: d, calls } = deps();
    const mission = createConversationProvider(d).targets()[0]!;
    const opened = await mission.thread();
    expect(opened.id).toBe(FILE);
    await mission.send('Hello');
    expect(calls.map((c) => c.method)).toEqual(['mcSessions', 'mcOpen', 'mcSend', 'mcOpen']);
    expect(calls[2]?.payload).toEqual({ file: FILE, text: 'Hello' });
    await mission.newThread();
    await mission.send('Fresh');
    expect(calls.some((c) => c.method === 'mcStart' && (c.payload as { text: string }).text === 'Fresh')).toBe(true);
  });

  it('shows a refused turn as the failure card, not as a message', async () => {
    const { deps: d } = deps({
      invoke: (method) =>
        Promise.resolve(
          method === 'mcSend' || method === 'mcStart'
            ? {
                ok: false,
                error: 'no model',
                failure: {
                  code: 'unsupported',
                  provider: 'claude-code',
                  providerLabel: 'Claude Code',
                  baseUrl: null,
                  model: null,
                  reason: 'the Claude Code CLI cannot drive the chat; pick an HTTP provider',
                  message: 'm',
                },
              }
            : method === 'mcSessions'
              ? []
              : { ok: true },
        ),
    });
    const mission = createConversationProvider(d).targets()[0]!;
    const after = await mission.send('Hi');
    const last = after.messages.at(-1);
    expect(last?.error?.title).toBe('Claude Code could not answer');
    expect(last?.error?.lines[0]).toContain('pick an HTTP provider');
  });

  it('routes a card button to confirm / dismiss and a split card to the shape decision', async () => {
    const { deps: d, calls } = deps();
    const mission = createConversationProvider(d).targets()[0]!;
    await mission.thread();
    await mission.act('p-1', 'confirm');
    await mission.act('s-3', 'keep');
    const decide = calls.find((c) => c.method === 'mcDecide');
    expect(decide?.payload).toEqual({ file: FILE, id: 'p-1', decision: 'confirm' });
    expect(calls.find((c) => c.method === 'mcShapeDecide')?.payload).toEqual({ file: FILE, choice: 'keep' });
  });
});

describe('a persona target', () => {
  it('reads and appends the persona thread', async () => {
    const { deps: d, calls } = deps();
    const ben = createConversationProvider(d).targets()[2]!;
    await ben.thread();
    const thread = await ben.send('Prefer small commits');
    expect(calls.map((c) => [c.method, c.payload])).toEqual([
      ['personaThread', { persona: 'ben' }],
      ['personaThreadAppend', { persona: 'ben', text: 'Prefer small commits' }],
    ]);
    expect(thread.notice).toBe('Ben reads this thread before the next run.');
  });
});
