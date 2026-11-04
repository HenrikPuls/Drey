import { describe, expect, it } from 'vitest';
import { CASE_FORMAT, DEVICE_LIST_CASES } from './device-list.cases';
import { deviceHeading, deviceListOf, relativeAgo } from './device-list';

describe('deviceHeading', () => {
  it('states the total with singular and none', () => {
    expect(deviceHeading(4)).toBe('4 paired devices');
    expect(deviceHeading(1)).toBe('1 paired device');
    expect(deviceHeading(0)).toBe('No paired devices');
  });
});

describe('relativeAgo', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  it('reads minutes, hours and days', () => {
    expect(relativeAgo('2026-11-04T11:59:40Z', now)).toBe('just now');
    expect(relativeAgo('2026-11-04T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeAgo('2026-11-04T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeAgo('2026-11-01T12:00:00Z', now)).toBe('3 d ago');
    expect(relativeAgo('nonsense', now)).toBe('');
  });
});

describe('deviceListOf', () => {
  for (const c of DEVICE_LIST_CASES) {
    it(c.name, () => {
      const list = deviceListOf(c.devices, c.now, CASE_FORMAT);
      expect(list.heading).toBe(c.heading);
      expect(list.rows.map((r) => [r.id, r.label, r.line, r.current, r.inactive])).toEqual(c.rows);
    });
  }
});
