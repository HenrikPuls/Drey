/**
 * The cases both device-list presentations must agree on (D-2): the
 * engine contract's spec and Mission Control's lib spec (which holds a
 * local copy of `device-list.ts`) run the same table, in UTC and en-GB.
 * Not production code — only specs import it.
 */
import type { ListedDevice } from './device-list';

export const CASE_FORMAT = { locale: 'en-GB', timeZone: 'UTC' } as const;

export interface DeviceListCase {
  readonly name: string;
  readonly now: number;
  readonly devices: readonly ListedDevice[];
  readonly heading: string;
  /** [id, label, line, current, inactive] per row, in order. */
  readonly rows: readonly (readonly [string, string, string, boolean, boolean])[];
}

const NOW = Date.parse('2026-11-04T12:00:00Z');

export const DEVICE_LIST_CASES: readonly DeviceListCase[] = [
  {
    name: 'no devices',
    now: NOW,
    devices: [],
    heading: 'No paired devices',
    rows: [],
  },
  {
    name: 'one device that never connected',
    now: NOW,
    devices: [{ id: 'aaaa1111', name: 'iPad', readOnly: false, pairedAt: '2026-11-04T10:15:00Z', lastSeen: null }],
    heading: '1 paired device',
    rows: [['aaaa1111', 'iPad', 'Paired 04/11/2026, 10:15, not connected yet', false, false]],
  },
  {
    name: "the owner's four devices: a doubled name gets an id suffix, the dead one is inactive, newest first",
    now: NOW,
    devices: [
      { id: 'b2c3d4e5', name: 'Phone', readOnly: false, pairedAt: '2026-10-01T08:00:00Z', lastSeen: '2026-10-05T08:00:00Z' },
      { id: 'f6a7b8c9', name: 'Phone', readOnly: false, pairedAt: '2026-11-03T08:00:00Z', lastSeen: '2026-11-04T09:00:00Z', current: true },
      { id: '1234abcd', name: 'iPad', readOnly: true, pairedAt: '2026-10-20T08:00:00Z', lastSeen: '2026-11-04T11:55:00Z' },
      { id: '9999ffff', name: 'Claude', readOnly: false, pairedAt: '2026-10-25T08:00:00Z', lastSeen: '2026-10-25T09:30:00Z' },
    ],
    heading: '4 paired devices',
    rows: [
      ['1234abcd', 'iPad', 'Last connected 04/11/2026, 11:55 · 5 min ago', false, false],
      ['f6a7b8c9', 'Phone · f6a7', 'Last connected 04/11/2026, 09:00 · 3 h ago', true, false],
      ['9999ffff', 'Claude', 'Last connected 25/10/2026, 09:30 · 10 d ago', false, false],
      ['b2c3d4e5', 'Phone · b2c3', 'Last connected 05/10/2026, 08:00 · 30 d ago', false, true],
    ],
  },
  {
    name: 'inactive from exactly 14 days, also for a device that never connected',
    now: NOW,
    devices: [
      { id: 'edge0001', name: 'Edge', readOnly: false, pairedAt: '2026-10-01T00:00:00Z', lastSeen: '2026-10-21T12:00:00Z' },
      { id: 'edge0002', name: 'Edge two', readOnly: false, pairedAt: '2026-10-21T12:00:01Z', lastSeen: '2026-10-21T12:00:01Z' },
      { id: 'edge0003', name: 'Old', readOnly: false, pairedAt: '2026-10-01T10:00:00Z', lastSeen: null },
    ],
    heading: '3 paired devices',
    rows: [
      ['edge0002', 'Edge two', 'Last connected 21/10/2026, 12:00 · 13 d ago', false, false],
      ['edge0001', 'Edge', 'Last connected 21/10/2026, 12:00 · 14 d ago', false, true],
      ['edge0003', 'Old', 'Paired 01/10/2026, 10:00, not connected yet', false, true],
    ],
  },
];
