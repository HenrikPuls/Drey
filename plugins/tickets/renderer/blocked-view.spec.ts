import { describe, expect, it } from 'vitest';
import type { TicketCard } from '../shared/tickets';
import { needsBlockedConfirm } from './blocked-view';

/** The blocked-move predicate (T-0050) — pure, so the spec needs no DOM. */

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
      track: null,
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

