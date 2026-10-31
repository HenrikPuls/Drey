import { describe, expect, it } from 'vitest';
import type { TicketCard } from '../shared/tickets';
import {
  blockedBadge,
  blocksBadge,
  createHideBlockedStore,
  needsBlockedConfirm,
  type HideBlockedStorage,
} from './blocked-view';

/**
 * The board's blocked-by view helpers (T-0050): the badge lines, the
 * drop-confirmation predicate and the hide-blocked view state — pure
 * functions over the derived card state, so the spec needs no DOM.
 */

function card(over: Partial<TicketCard> = {}): TicketCard {
  return {
    id: 'T-0002',
    path: 'tickets/50-build/T-0002.md',
    phase: 'build',
    meta: {
      id: 'T-0002',
      title: null,
      repo: null,
      repos: [],
      worker: null,
      priority: 'normal',
      rank: 5000,
      branch: null,
      claimedBy: null,
      claimedAt: null,
      run: null,
      references: [],
      blockedBy: ['T-0001'],
      parkedReason: null,
      parkedAt: null,
      interactive: false,
      entered: {},
    },
    worker: 'opencode',
    blocked: [],
    blocks: [],
    issues: [],
    ...over,
  };
}

describe('badges', () => {
  it('blockedBadge names the open blockers in written order, null when unblocked', () => {
    expect(blockedBadge(card({ blocked: ['T-0048', 'T-0047'] }))).toBe('blocked by T-0048, T-0047');
    expect(blockedBadge(card({ blocked: ['T-0048'] }))).toBe('blocked by T-0048');
    expect(blockedBadge(card({ blocked: [] }))).toBeNull();
  });

  it('blocksBadge names the dependents, null when none (a done blocker shows nothing)', () => {
    expect(blocksBadge(card({ blocks: ['T-0049'] }))).toBe('blocks T-0049');
    expect(blocksBadge(card({ blocks: ['T-0049', 'T-0050'] }))).toBe('blocks T-0049, T-0050');
    expect(blocksBadge(card({ blocks: [] }))).toBeNull();
  });
});

describe('needsBlockedConfirm', () => {
  it('asks only for a blocked card dropped into an agent column', () => {
    expect(needsBlockedConfirm(card({ blocked: ['T-0001'] }), 'agent build-default')).toBe(true);
    expect(needsBlockedConfirm(card({ blocked: ['T-0001'] }), 'agent build-default@opencode')).toBe(true);
  });

  it('never asks for an unblocked card or a non-agent target', () => {
    expect(needsBlockedConfirm(card({ blocked: [] }), 'agent build-default')).toBe(false);
    expect(needsBlockedConfirm(card({ blocked: ['T-0001'] }), 'manual')).toBe(false);
    expect(needsBlockedConfirm(card({ blocked: ['T-0001'] }), 'ci')).toBe(false);
    expect(needsBlockedConfirm(card({ blocked: ['T-0001'] }), 'none')).toBe(false);
  });
});

describe('createHideBlockedStore', () => {
  const storageWith = (initial: Record<string, string> = {}): HideBlockedStorage & {
    data: Map<string, string>;
  } => {
    const data = new Map(Object.entries(initial));
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
  };

  it('defaults to showing blocked tickets', () => {
    expect(createHideBlockedStore(storageWith()).isHidden()).toBe(false);
    expect(createHideBlockedStore(storageWith({ 'drey.tickets.hideBlocked': 'junk' })).isHidden()).toBe(false);
  });

  it('persists the toggle under its own key and reads it back', () => {
    const storage = storageWith();
    const store = createHideBlockedStore(storage);
    store.setHidden(true);
    expect(store.isHidden()).toBe(true);
    expect(storage.data.get('drey.tickets.hideBlocked')).toBe(JSON.stringify({ hidden: true }));
    // A second store over the same storage resumes the state.
    expect(createHideBlockedStore(storage).isHidden()).toBe(true);

    store.setHidden(false);
    expect(store.isHidden()).toBe(false);
    expect(storage.data.get('drey.tickets.hideBlocked')).toBe(JSON.stringify({ hidden: false }));
  });

  it('a throwing storage degrades to a non-persisted session', () => {
    const store = createHideBlockedStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    store.setHidden(true);
    expect(store.isHidden()).toBe(true); // the session state still works
  });
});
