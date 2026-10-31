// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RunInfo } from '../main/fleet/protocol';
import { workerCards, workersNode } from './workers-view';

const NOW = Date.parse('2026-10-31T12:00:00Z');

const run = (over: Partial<RunInfo>): RunInfo =>
  ({
    id: 'R-1',
    ticketId: 'T-0001',
    provider: 'claude-code',
    state: 'running',
    startedAt: '2026-10-31T11:30:00Z',
    lastActivity: '2026-10-31T11:59:50Z',
    tokensIn: 1_200_000,
    tokensOut: 4_000,
    turn: 'busy',
    activity: 'bash npm test',
    ...over,
  }) as RunInfo;

describe('workerCards', () => {
  it('puts the runs that need a look first and names the state in words', () => {
    const cards = workerCards(
      [
        run({ id: 'R-ok', ticketId: 'T-0002' }),
        run({ id: 'R-stuck', ticketId: 'T-0003', stuck: true, lastActivity: '2026-10-31T11:40:00Z' }),
        run({ id: 'R-paused', ticketId: 'T-0001', paused: true, held: true, turn: 'idle' }),
      ],
      NOW,
    );
    expect(cards.map((c) => c.runId)).toEqual(['R-stuck', 'R-paused', 'R-ok']);
    expect(cards.map((c) => c.state)).toEqual(['Looks stuck', 'Paused', expect.any(String)]);
  });

  it('shows what the worker does now and offers Continue only on a paused run', () => {
    const [busy] = workerCards([run({})], NOW);
    expect(busy!.now).toBe('bash npm test');
    expect(busy!.actions).toEqual(['pause', 'stop']);
    const [paused] = workerCards([run({ paused: true, held: true, turn: 'idle' })], NOW);
    expect(paused!.actions).toEqual(['continue', 'stop']);
    expect(paused!.now).toContain('Continue picks the step up');
  });

  it('a waiting worker shows its question as the Now line', () => {
    const [card] = workerCards(
      [run({ waiting: { kind: 'question', text: 'Move the section?\nTicket: x', since: '2026-10-31T11:59:00Z' }, turn: 'idle' })],
      NOW,
    );
    expect(card!.now).toBe('Move the section?');
    expect(card!.state).toBe('Waits for your answer');
  });
});

describe('workersNode', () => {
  const api = { ui: { icon: () => document.createElement('span') } } as unknown as DreyPluginApi;

  it('is null without workers; cards carry working actions', () => {
    const deps = { api, open: vi.fn(), act: vi.fn() };
    expect(workersNode(deps, [], NOW)).toBeNull();
    const node = workersNode(deps, [run({})], NOW)!;
    expect(node.querySelector('.tickets-workers-head')?.textContent).toBe('Workers · 1');
    node.querySelector<HTMLButtonElement>('.icon-btn')!.click();
    expect(deps.act).toHaveBeenCalledWith('R-1', 'pause');
    node.querySelector<HTMLButtonElement>('.tickets-worker-ticket')!.click();
    expect(deps.open).toHaveBeenCalledWith('T-0001');
  });
});
