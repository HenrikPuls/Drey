import { describe, expect, it } from 'vitest';
import type { ChainStatus, RunInfo } from '../main/fleet/protocol';
import { phaseWithoutPoolKeys, type BoardColumn, type BoardSnapshot, type PipelinePhase, type TicketCard } from '../shared/tickets';
import { chainAlertsOf, newChainAlerts } from './chain-alerts';

/**
 * The chain alerts fix (2026-10-31): T-0061's three quota failures
 * tripped the build breaker and the Work panel showed nothing. These
 * pin what the panel now puts on top, over the default pipeline.
 */

const phase = (id: string, handover: string): PipelinePhase =>
  phaseWithoutPoolKeys({ id, title: id[0]!.toUpperCase() + id.slice(1), wip: null, claim: false, handover });

const PIPELINE: readonly PipelinePhase[] = [
  phase('inbox', 'manual'),
  phase('plan', 'agent plan-default'),
  phase('plan-review', 'manual'),
  phase('build', 'agent build-default'),
  phase('review', 'manual'),
  phase('done', 'none'),
];

const card = (id: string, at: string): TicketCard =>
  ({ id, path: `tickets/${at}/${id}.md`, phase: at, meta: { title: id, interactive: false, entered: {} } }) as unknown as TicketCard;

const board = (placed: Record<string, readonly TicketCard[]>): BoardSnapshot =>
  ({
    columns: PIPELINE.map((p): BoardColumn => ({ phase: p, unknown: false, tickets: placed[p.id] ?? [] })),
    checkpoints: ['plan-review', 'review', 'done'],
    recentDone: [],
  }) as unknown as BoardSnapshot;

const chain = (patch: Partial<ChainStatus>): ChainStatus => ({
  configured: true,
  master: 'run',
  columns: {},
  redStreak: {},
  cooldownUntil: {},
  tripped: {},
  quotaPausedUntil: {},
  ...patch,
});

const NOW = Date.parse('2026-10-31T14:00:00Z');

describe('chainAlertsOf', () => {
  it('a tripped breaker is an alert with Resume, naming why and what waits', () => {
    const alerts = chainAlertsOf(
      chain({
        columns: { build: 'held' },
        redStreak: { build: 3 },
        tripped: { build: { reason: '3 red gates in a row', at: '2026-10-31T11:48:08Z' } },
      }),
      board({ build: [card('T-0084', 'build'), card('T-0085', 'build')] }),
      [],
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('breaker');
    expect(alerts[0]!.title).toBe('Build stopped by the circuit breaker');
    expect(alerts[0]!.text).toContain('3 red gates in a row');
    expect(alerts[0]!.text).toContain('2 tickets wait (T-0084, T-0085)');
    expect(alerts[0]!.action).toEqual({ kind: 'play-column', phase: 'build', label: 'Resume' });
  });

  it('an older runner without trips: a hold with a full red streak still reads as the breaker', () => {
    const { tripped: _t, ...old } = chain({ columns: { build: 'held' }, redStreak: { build: 3 } });
    const alerts = chainAlertsOf(old, board({}), [], NOW);
    expect(alerts.map((a) => a.kind)).toEqual(['breaker']);
  });

  it('a plain hold alerts only while tickets wait there without a run', () => {
    const held = chain({ columns: { build: 'held' } });
    expect(chainAlertsOf(held, board({}), [], NOW)).toEqual([]);
    const live = [{ ticketId: 'T-0001', state: 'running' } as RunInfo];
    expect(chainAlertsOf(held, board({ build: [card('T-0001', 'build')] }), live, NOW)).toEqual([]);
    const alerts = chainAlertsOf(held, board({ build: [card('T-0002', 'build')] }), [], NOW);
    expect(alerts.map((a) => a.kind)).toEqual(['held']);
    expect(alerts[0]!.title).toBe('Build is on hold');
  });

  it('a hold on a manual column is the owner checkpoint, never an alert', () => {
    expect(chainAlertsOf(chain({ columns: { review: 'held' } }), board({ review: [card('T-0003', 'review')] }), [], NOW)).toEqual([]);
  });

  it('a halted chain alerts with Run when work waits in a playing machine column', () => {
    const halted = chain({ master: 'halted' });
    expect(chainAlertsOf(halted, board({}), [], NOW)).toEqual([]);
    const alerts = chainAlertsOf(halted, board({ plan: [card('T-0004', 'plan')] }), [], NOW);
    expect(alerts[0]!.kind).toBe('halted');
    expect(alerts[0]!.action).toEqual({ kind: 'run-chain', label: 'Run' });
  });

  it('a running quota pause alerts without a button; an ended one is gone', () => {
    const paused = chain({ quotaPausedUntil: { opencode: '2026-10-31T14:30:00Z' } });
    const alerts = chainAlertsOf(paused, board({}), [], NOW);
    expect(alerts[0]!.title).toBe('OpenCode is out of quota');
    expect(alerts[0]!.action).toBeNull();
    expect(chainAlertsOf(paused, board({}), [], Date.parse('2026-10-31T14:31:00Z'))).toEqual([]);
  });

  it('no chain, no alerts', () => {
    expect(chainAlertsOf(null, board({}), [], NOW)).toEqual([]);
    expect(chainAlertsOf(chain({ configured: false, master: 'halted' }), board({ plan: [card('T-0005', 'plan')] }), [], NOW)).toEqual([]);
  });
});

describe('newChainAlerts', () => {
  it('announces a breaker trip and a quota pause once each, never a hold', () => {
    const alerts = chainAlertsOf(
      chain({
        columns: { build: 'held', plan: 'held' },
        tripped: { build: { reason: '3 red gates in a row', at: '2026-10-31T11:48:08Z' } },
        quotaPausedUntil: { opencode: '2026-10-31T14:30:00Z' },
      }),
      board({ plan: [card('T-0006', 'plan')] }),
      [],
      NOW,
    );
    const seen = new Set<string>();
    expect(newChainAlerts(alerts, seen).map((a) => a.kind)).toEqual(['breaker', 'quota']);
    expect(newChainAlerts(alerts, seen)).toEqual([]);
  });
});
