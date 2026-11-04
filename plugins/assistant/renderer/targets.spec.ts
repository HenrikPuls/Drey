import { describe, expect, it } from 'vitest';
import type { ConversationTarget, ConversationThread, DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { createTargetController } from './targets';

const thread = (title: string): ConversationThread => ({ id: title, title, messages: [] });

function fixture() {
  const sent: string[] = [];
  const target: ConversationTarget = {
    id: 't.mc',
    label: 'Mission Control',
    thread: () => Promise.resolve(thread('Chat')),
    send: (text) => {
      sent.push(text);
      return Promise.resolve({
        id: 'Chat',
        title: 'Chat',
        messages: [
          { id: 'a', role: 'user', text },
          {
            id: 'b',
            role: 'agent',
            text: 'which one?',
            cards: [{ id: 'q', kind: 'choices', text: 'which one?', choices: [{ label: 'One' }] }],
          },
        ],
      });
    },
    act: () => Promise.resolve(thread('Chat')),
    newThread: () => Promise.resolve(thread('New chat')),
  };
  let targets: readonly ConversationTarget[] = [];
  let viewTarget: string | null = null;
  const targetListeners = new Set<() => void>();
  const viewListeners = new Set<() => void>();
  const api = {
    conversations: {
      targets: () => targets,
      onTargetsChange: (l: () => void) => {
        targetListeners.add(l);
        return () => targetListeners.delete(l);
      },
      viewTarget: () => viewTarget,
      onViewTargetChange: (l: () => void) => {
        viewListeners.add(l);
        return () => viewListeners.delete(l);
      },
      registerTargets: () => () => undefined,
    },
  } as unknown as DreyPluginApi;
  return {
    api,
    sent,
    register: () => {
      targets = [target];
      targetListeners.forEach((l) => l());
    },
    setView: (id: string | null) => {
      viewTarget = id;
      viewListeners.forEach((l) => l());
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTargetController', () => {
  it('starts on the model and lists only it while nothing is registered', () => {
    const c = createTargetController(fixture().api);
    expect(c.activeId()).toBe('model');
    expect(c.segments()).toHaveLength(1);
  });

  it('follows the view default, also when the target registers later', async () => {
    const f = fixture();
    const c = createTargetController(f.api);
    f.setView('t.mc');
    expect(c.activeId()).toBe('model'); // not registered yet: waits
    f.register();
    await settle();
    expect(c.activeId()).toBe('t.mc');
    expect(c.thread()?.title).toBe('Chat');
    f.setView(null);
    expect(c.activeId()).toBe('model');
  });

  it('shows the owner words while the target answers and offers an open answer card', async () => {
    const f = fixture();
    const c = createTargetController(f.api);
    f.register();
    c.select('t.mc');
    await settle();
    const sending = c.send('hello');
    expect(c.busy()).toBe(true);
    expect(c.thread()?.messages.at(-1)).toMatchObject({ role: 'user', text: 'hello' });
    await sending;
    expect(c.busy()).toBe(false);
    expect(f.sent).toEqual(['hello']);
    expect(c.choices()?.choices?.[0]?.label).toBe('One');
  });

  it('refuses to send on the model target', async () => {
    const c = createTargetController(fixture().api);
    expect(await c.send('x')).toBe(false);
  });
});
