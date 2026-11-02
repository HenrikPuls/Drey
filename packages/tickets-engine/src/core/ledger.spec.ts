import { describe, expect, it } from 'vitest';
import { parseLedger, parseLedgerLine, personaDailyCosts, renderLedgerLine, settledUsageByTicket } from './ledger';

describe('ledger line round-trip', () => {
  it('renders and parses the strict one-line shape', () => {
    const line = renderLedgerLine('2026-11-02T09:00:00Z', {
      kind: 'phase',
      ticket: 'T-0002',
      persona: 'pia',
      from: 'build',
      to: 'review',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(parseLedgerLine(line.trim())).toEqual({
      kind: 'phase',
      ts: '2026-11-02T09:00:00Z',
      ticket: 'T-0002',
      persona: 'pia',
      model: null,
      cost: null,
      tokensIn: null,
      tokensOut: null,
      from: 'build',
      to: 'review',
    });
  });

  it('omits absent optionals entirely', () => {
    const line = renderLedgerLine('2026-11-02T09:45:00Z', { kind: 'proof_ready', ticket: 'T-0001' });
    expect(line.trim()).toBe('{"v":1,"ts":"2026-11-02T09:45:00Z","event":"proof_ready","ticket":"T-0001"}');
  });

  it('round-trips the settled run line with its counters (run_settled)', () => {
    const line = renderLedgerLine('2026-11-02T09:41:00Z', {
      kind: 'run_settled',
      ticket: 'T-0002',
      persona: 'pia',
      model: 'opus',
      tokensIn: 48_000,
      tokensOut: 6_000,
      cost: 1.17,
    });
    expect(line.trim()).toBe(
      '{"v":1,"ts":"2026-11-02T09:41:00Z","event":"run_settled","ticket":"T-0002","persona":"pia","model":"opus","cost":1.17,"tokensIn":48000,"tokensOut":6000}',
    );
    expect(parseLedgerLine(line.trim())).toEqual({
      kind: 'run_settled',
      ts: '2026-11-02T09:41:00Z',
      ticket: 'T-0002',
      persona: 'pia',
      model: 'opus',
      cost: 1.17,
      tokensIn: 48_000,
      tokensOut: 6_000,
      from: null,
      to: null,
    });
  });

  it('accepts a settled line without cost — unknown is not zero', () => {
    const event = parseLedgerLine(
      '{"v":1,"ts":"1","event":"run_settled","ticket":"T-0001","persona":"pia","model":"glm-5.3","tokensIn":5000,"tokensOut":500}',
    );
    expect(event).toMatchObject({ kind: 'run_settled', cost: null, tokensIn: 5000, tokensOut: 500 });
  });

  it('refuses nonsense counters', () => {
    expect(parseLedgerLine('{"v":1,"ts":"1","event":"run_settled","ticket":"T-0001","tokensIn":-5}')).toMatchObject({
      tokensIn: null,
    });
    expect(parseLedgerLine('{"v":1,"ts":"1","event":"run_settled","ticket":"T-0001","tokensOut":"many"}')).toMatchObject({
      tokensOut: null,
    });
  });
});

describe('parseLedger', () => {
  it('reads a file tolerantly and skips torn lines', () => {
    const events = parseLedger(
      [
        renderLedgerLine('1', { kind: 'dispatched', ticket: 'T-0001', persona: 'pia', model: 'opus', cost: 0.23456 }).trimEnd(),
        '{"v":1,"ts":"2","event":"broken"',
        renderLedgerLine('3', { kind: 'archived', ticket: 'T-0001' }).trimEnd(),
      ].join('\n'),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.cost).toBe(0.2346); // rounded to four digits
    expect(events.map((e) => e.kind)).toEqual(['dispatched', 'archived']);
  });

  it('refuses wrong versions and unknown events', () => {
    expect(parseLedgerLine('{"v":2,"ts":"1","event":"dispatched","ticket":"T-0001"}')).toBeNull();
    expect(parseLedgerLine('{"v":1,"ts":"1","event":"hacked","ticket":"T-0001"}')).toBeNull();
    expect(parseLedgerLine('not json')).toBeNull();
  });
});

describe('settledUsageByTicket — the ticket card’s usage figure (concept §4.3)', () => {
  it('sums only the run_settled lines per ticket', () => {
    const events = parseLedger(
      [
        renderLedgerLine('1', { kind: 'dispatched', ticket: 'T-0001', persona: 'pia', model: 'opus' }).trimEnd(),
        renderLedgerLine('2', { kind: 'run_settled', ticket: 'T-0001', persona: 'pia', model: 'opus', tokensIn: 48_000, tokensOut: 6_000, cost: 1.17 }).trimEnd(),
        renderLedgerLine('3', { kind: 'phase', ticket: 'T-0001', from: 'plan', to: 'build' }).trimEnd(),
        renderLedgerLine('4', { kind: 'run_settled', ticket: 'T-0001', persona: 'ben', model: 'glm-5.3', tokensIn: 50_000, tokensOut: 2_500, cost: 0.113 }).trimEnd(),
        renderLedgerLine('5', { kind: 'run_settled', ticket: 'T-0002', persona: 'pia', model: 'opus', tokensIn: 1_000, tokensOut: 10 }).trimEnd(),
        renderLedgerLine('6', { kind: 'archived', ticket: 'T-0002' }).trimEnd(),
      ].join('\n'),
    );
    expect(settledUsageByTicket(events)).toEqual({
      'T-0001': { tokensIn: 98_000, tokensOut: 8_500, cost: 1.283, runs: 2 },
      'T-0002': { tokensIn: 1_000, tokensOut: 10, cost: null, runs: 1 },
    });
  });

  it('cost sums only what is known; an empty ledger aggregates nothing', () => {
    const events = parseLedger(
      [
        renderLedgerLine('1', { kind: 'run_settled', ticket: 'T-0001', tokensIn: 10, tokensOut: 0, cost: 0.5 }).trimEnd(),
        renderLedgerLine('2', { kind: 'run_settled', ticket: 'T-0001', tokensIn: 0, tokensOut: 20 }).trimEnd(),
      ].join('\n'),
    );
    expect(settledUsageByTicket(events)['T-0001']).toEqual({ tokensIn: 10, tokensOut: 20, cost: 0.5, runs: 2 });
    expect(settledUsageByTicket([])).toEqual({});
  });
});

describe('personaDailyCosts — the Team view’s Tageskosten (concept §4.3)', () => {
  it('sums one UTC day per persona, costless lines excluded', () => {
    const events = parseLedger(
      [
        renderLedgerLine('2026-11-02T09:00:00Z', { kind: 'run_settled', ticket: 'T-0001', persona: 'pia', cost: 1.17, tokensIn: 10, tokensOut: 10 }).trimEnd(),
        renderLedgerLine('2026-11-02T11:00:00Z', { kind: 'run_settled', ticket: 'T-0002', persona: 'pia', cost: 0.23, tokensIn: 10, tokensOut: 10 }).trimEnd(),
        renderLedgerLine('2026-11-01T09:00:00Z', { kind: 'run_settled', ticket: 'T-0003', persona: 'pia', cost: 9, tokensIn: 10, tokensOut: 10 }).trimEnd(),
        renderLedgerLine('2026-11-02T12:00:00Z', { kind: 'run_settled', ticket: 'T-0004', persona: 'ben', tokensIn: 10, tokensOut: 10 }).trimEnd(),
        renderLedgerLine('2026-11-02T13:00:00Z', { kind: 'dispatched', ticket: 'T-0005', persona: 'pia', model: 'opus' }).trimEnd(),
      ].join('\n'),
    );
    expect(personaDailyCosts(events, '2026-11-02')).toEqual({ pia: 1.4 });
  });

  it('runs without a persona aggregate nowhere', () => {
    const events = parseLedger([
      renderLedgerLine('2026-11-02T09:00:00Z', { kind: 'run_settled', ticket: 'T-0001', cost: 5, tokensIn: 10, tokensOut: 10 }).trimEnd(),
    ].join('\n'));
    expect(personaDailyCosts(events, '2026-11-02')).toEqual({});
  });
});
