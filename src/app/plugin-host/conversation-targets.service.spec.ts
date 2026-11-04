import { TestBed } from '@angular/core/testing';
import type { ConversationTarget, ConversationTargetProvider } from '../../../shared/plugin-api/renderer';
import { ViewService } from '../views';
import { ConversationTargetsService } from './conversation-targets.service';

const target = (id: string): ConversationTarget => {
  const empty = { id: null, title: '', messages: [] };
  return {
    id,
    label: id,
    thread: () => Promise.resolve(empty),
    send: () => Promise.resolve(empty),
    act: () => Promise.resolve(empty),
    newThread: () => Promise.resolve(empty),
  };
};

function provider(initial: readonly ConversationTarget[]) {
  let targets = initial;
  const listeners = new Set<() => void>();
  const p: ConversationTargetProvider = {
    targets: () => targets,
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    p,
    set: (next: readonly ConversationTarget[]) => {
      targets = next;
      listeners.forEach((l) => l());
    },
    listeners,
  };
}

describe('ConversationTargetsService', () => {
  let svc: ConversationTargetsService;
  beforeEach(() => {
    svc = TestBed.inject(ConversationTargetsService);
  });

  it('lists the targets of every provider in registration order, the first id winning', () => {
    svc.register('a', provider([target('x'), target('y')]).p);
    svc.register('b', provider([target('y'), target('z')]).p);
    expect(svc.targets().map((t) => t.id)).toEqual(['x', 'y', 'z']);
  });

  it('tells listeners when a provider changes or goes away', () => {
    const prov = provider([target('x')]);
    let heard = 0;
    svc.onTargetsChange(() => (heard += 1));
    const off = svc.register('a', prov.p);
    prov.set([target('x'), target('w')]);
    expect(svc.targets().map((t) => t.id)).toEqual(['x', 'w']);
    off();
    expect(svc.targets()).toEqual([]);
    expect(prov.listeners.size).toBe(0);
    expect(heard).toBe(3); // register, change, unregister
  });

  it('carries the active view default target', () => {
    const views = TestBed.inject(ViewService);
    views.registerPreset('acme', { id: 'acme.work', label: 'Work', assistantTarget: 'acme.agent' });
    expect(svc.viewTarget()).toBeNull();
    views.switchTo('acme.work');
    expect(svc.viewTarget()).toBe('acme.agent');
  });
});
