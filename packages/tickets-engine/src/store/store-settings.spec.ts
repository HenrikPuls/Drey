import { describe, expect, it } from 'vitest';

import { parseTicketBackend, type TicketRecord } from '../ports/ticket-store';
import { groupByStage, readStoreSettings } from './store-settings';

const rec = (id: string, stage: string): TicketRecord => ({
  id, stage, title: id, owner: null, priority: null, kind: null, epoch: null, rev: null, labels: [], dependsOn: [],
  claimedAt: null, leaseUntil: null, size: null, branch: null, repos: [], extensions: {},
});

describe('tickets.backend', () => {
  it('is files unless the value says dricket', () => {
    expect(parseTicketBackend(undefined)).toBe('files');
    expect(parseTicketBackend('')).toBe('files');
    expect(parseTicketBackend('nonsense')).toBe('files');
    expect(parseTicketBackend('dricket')).toBe('dricket');
  });

  it('reads the four keys, trimmed', async () => {
    const values: Record<string, string> = { backend: 'dricket', 'dk.path': ' C:\\x\\dk.exe ', 'dk.store': 'E:\\scratch' };
    const settings = await readStoreSettings(<T>(key: string) => Promise.resolve(values[key] as T | undefined));
    expect(settings).toEqual({ backend: 'dricket', dkPath: 'C:\\x\\dk.exe', dkStore: 'E:\\scratch', dkDataDir: '' });
  });

  it('defaults to files with nothing set', async () => {
    const settings = await readStoreSettings(() => Promise.resolve(undefined));
    expect(settings.backend).toBe('files');
  });
});

describe('groupByStage', () => {
  it('orders known stages as a ticket travels, the rest alphabetically, tickets by id', () => {
    const cols = groupByStage([rec('T-0003', 'zeta'), rec('T-0002', 'review'), rec('T-0001', 'open'), rec('T-0004', 'alpha'), rec('T-0000', 'open')]);
    expect(cols.map((c) => c.stage)).toEqual(['open', 'review', 'alpha', 'zeta']);
    expect(cols[0]!.tickets.map((t) => t.id)).toEqual(['T-0000', 'T-0001']);
  });
});
