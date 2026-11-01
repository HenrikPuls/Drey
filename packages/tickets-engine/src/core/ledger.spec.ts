import { describe, expect, it } from 'vitest';
import { appendLedgerEvent, isLedgerEvent, parseLedger, type LedgerEntry } from './ledger';

const BASE: LedgerEntry = {
  ts: '2026-11-01T14:30:00Z',
  ticket: 'T-0086',
  persona: 'ben',
  model: 'glm-5.2',
  event: 'dispatched',
};

describe('parseLedger', () => {
  it('parses one event per line, oldest first', () => {
    const text = [
      '{"ts":"2026-11-01T14:30:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"dispatched"}',
      '{"ts":"2026-11-01T15:12:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"phase","detail":"build -> review","cost":0.61}',
    ].join('\n');

    expect(parseLedger(text)).toEqual([
      BASE,
      { ...BASE, ts: '2026-11-01T15:12:00Z', event: 'phase', detail: 'build -> review', cost: 0.61 },
    ]);
  });

  it('skips malformed and unknown lines without failing', () => {
    const text = [
      'not json at all',
      '{"ts":"2026-11-01T14:30:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"exploded"}',
      '{"ticket":"missing fields"}',
      '',
      '{"ts":"2026-11-01T14:30:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"merged"}',
    ].join('\n');

    expect(parseLedger(text)).toEqual([{ ...BASE, event: 'merged' }]);
  });

  it('refuses a negative cost', () => {
    const text = '{"ts":"t","ticket":"T-1","persona":"p","model":"m","event":"phase","cost":-0.5}';

    expect(parseLedger(text)).toEqual([]);
  });
});

describe('appendLedgerEvent', () => {
  it('appends one stable-key-order line and round-trips', () => {
    let text = appendLedgerEvent('', BASE);
    text = appendLedgerEvent(text, { ...BASE, event: 'archived', cost: 0 });

    expect(text.split('\n')).toEqual([
      '{"ts":"2026-11-01T14:30:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"dispatched"}',
      '{"ts":"2026-11-01T14:30:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"archived","cost":0}',
    ]);
    expect(parseLedger(text)).toHaveLength(2);
  });

  it('throws on an invalid entry instead of poisoning the file', () => {
    expect(() => appendLedgerEvent('', { ...BASE, event: 'exploded' as never })).toThrow('invalid ledger entry');
    expect(() => appendLedgerEvent('', { ...BASE, cost: Number.NaN })).toThrow('invalid ledger entry');
  });
});

describe('isLedgerEvent', () => {
  it('knows the five events', () => {
    for (const event of ['dispatched', 'phase', 'proof_ready', 'merged', 'archived']) {
      expect(isLedgerEvent(event)).toBe(true);
    }
    expect(isLedgerEvent('working')).toBe(false);
  });
});
