import { describe, expect, it } from 'vitest';
import { parseLedger, parseLedgerLine, renderLedgerLine } from './ledger';

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
      from: 'build',
      to: 'review',
    });
  });

  it('omits absent optionals entirely', () => {
    const line = renderLedgerLine('2026-11-02T09:45:00Z', { kind: 'proof_ready', ticket: 'T-0001' });
    expect(line.trim()).toBe('{"v":1,"ts":"2026-11-02T09:45:00Z","event":"proof_ready","ticket":"T-0001"}');
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
