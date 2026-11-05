import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DkProcess } from './dk-process';
import { DricketTicketStore } from './dricket-ticket-store';
import { applyLeaseExpiry, FileStoreReader, TAKEOVER_GRACE_MS } from './file-store-reader';
import { detailFromContent } from './dricket-ticket-store';
import { StoreReader } from './store-reader';

function ticket(fields: Record<string, string>, body = '## Description\n\nText\n'): string {
  const base: Record<string, string> = { id: 't-1', title: 'T', stage: 'inbox', owner: '', kind: 'human', size: 'M', claimed_at: '', lease_until: '', epoch: '0', rev: '1', ...fields };
  return `---\n${Object.entries(base).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;
}

describe('FileStoreReader', () => {
  let root = '';
  const put = (id: string, text: string): string => {
    const [prefix, n] = id.split('-') as [string, string];
    const dir = path.join(root, 'tickets', prefix, String(Math.floor(Number(n) / 1000)).padStart(4, '0'), id);
    mkdirSync(path.join(dir, 'comments'), { recursive: true });
    writeFileSync(path.join(dir, 'ticket.md'), text);
    return dir;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-reader-'));
    put('t-1', ticket({ id: 't-1', title: 'First: with a colon', labels: 'a, b', 'x-rank': '10' }));
    put('t-2', ticket({ id: 't-2', stage: 'build', owner: 'ben.run-1', kind: 'agent', size: 'S', claimed_at: '2026-11-01T08:00:00Z', lease_until: '2026-11-01T10:00:00Z', epoch: '3', rev: '5', depends: 't-1' }));
    const d = put('t-1500', ticket({ id: 't-1500', title: 'Second shard' }));
    writeFileSync(path.join(d, 'comments', '2026-11-03T11-30-00Z-bob.md'), '---\nticket: t-1500\nauthor: bob\ncreated_at: 2026-11-03T11:30:00Z\n---\n\nSecond\n');
    writeFileSync(path.join(d, 'comments', '2026-11-03T10-04-24Z-henrik.md'), '---\nticket: t-1500\nauthor: henrik\ncreated_at: 2026-11-03T10:04:24Z\n---\n\nFirst\n\nwith two paragraphs\n');
    mkdirSync(path.join(root, 'tickets', 't', '0000', 'stray-dir'), { recursive: true });
    writeFileSync(path.join(root, 'tickets', 'README.md'), 'not a ticket');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const at = (iso: string) => new FileStoreReader({ root, now: () => Date.parse(iso) });

  it('reads every ticket with display ids, sorted, skipping what is not a ticket', async () => {
    const all = await at('2026-11-01T09:00:00Z').readAll();
    expect(all.map((t) => t.id)).toEqual(['T-0001', 'T-0002', 'T-1500']);
    expect(all[0]).toMatchObject({ title: 'First: with a colon', labels: ['a', 'b'], extensions: { 'x-rank': '10' }, rev: 1 });
    expect(all[1]).toMatchObject({ owner: 'ben.run-1', epoch: 3, dependsOn: ['T-0001'], size: 'S' });
  });

  it('shows one ticket by path and reports a missing one', async () => {
    const r = at('2026-11-01T09:00:00Z');
    expect((await r.show('T-1500')).title).toBe('Second shard');
    await expect(r.show('T-0099')).rejects.toMatchObject({ kind: 'not-found' });
    await expect(r.show('nonsense')).rejects.toMatchObject({ kind: 'usage' });
  });

  it('filters like dk ls', async () => {
    const r = at('2026-11-01T09:00:00Z');
    expect((await r.list({ stage: 'build' })).map((t) => t.id)).toEqual(['T-0002']);
    expect((await r.list({ owner: 'ben.run-1' })).map((t) => t.id)).toEqual(['T-0002']);
  });

  it('applies the lease-expiry rule: dead only after lease_until plus the 20 minute grace', async () => {
    const until = Date.parse('2026-11-01T10:00:00Z');
    const live = (await at(new Date(until + TAKEOVER_GRACE_MS).toISOString()).show('T-0002'));
    expect(live.owner).toBe('ben.run-1');
    const dead = await at(new Date(until + TAKEOVER_GRACE_MS + 1000).toISOString()).show('T-0002');
    expect(dead).toMatchObject({ owner: null, leaseUntil: null, claimedAt: null, size: null, epoch: 3 });
    expect(dead.text).toContain('owner: ben.run-1');
  });

  it('leaves a claim without a lease, and an unclaimed ticket, alone', () => {
    const noLease = detailFromContent(ticket({ owner: 'x' }));
    expect(applyLeaseExpiry(noLease, Date.now())).toBe(noLease);
  });

  it('lists comments oldest first, bodies trimmed; none is an empty list', async () => {
    const r = at('2026-11-01T09:00:00Z');
    expect(await r.comments('T-1500')).toEqual([
      { author: 'henrik', at: '2026-11-03T10:04:24Z', text: 'First\n\nwith two paragraphs' },
      { author: 'bob', at: '2026-11-03T11:30:00Z', text: 'Second' },
    ]);
    expect(await r.comments('T-0001')).toEqual([]);
  });

  it('reads a store without a tickets directory as empty', async () => {
    const empty = new FileStoreReader({ root: path.join(root, 'nowhere') });
    expect(await empty.exists()).toBe(false);
    expect(await empty.readAll()).toEqual([]);
  });

  it('stops when the call is cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(at('2026-11-01T09:00:00Z').readAll({ signal: ac.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

/**
 * Equality with the `dk` read path on a real store: set DREY_E144_STORE to a
 * checkout of a dricket store (the 91-ticket migrated one, a copy) and
 * DREY_DK_BIN to dk. Every ticket's whole document must read identically.
 */
const storeDir = process.env['DREY_E144_STORE'] ?? '';
describe.skipIf(storeDir === '' || !existsSync(storeDir))('FileStoreReader equals the dk read path', { timeout: 300_000 }, () => {
  it('reads the same tickets as ls + show', async () => {
    const bin = process.env['DREY_DK_BIN'] ?? 'dk';
    execFileSync(bin, ['--version'], { windowsHide: true });
    const dk = new DricketTicketStore(new DkProcess({ bin, store: storeDir, readConcurrency: 1 }));
    const t0 = Date.now();
    const viaFiles = await new FileStoreReader({ root: storeDir, now: () => Date.parse('2000-01-01T00:00:00Z') }).readAll();
    const filesMs = Date.now() - t0;
    const t1 = Date.now();
    const viaDk = await new StoreReader(dk).readAll();
    const dkMs = Date.now() - t1;
    process.stderr.write(`[E14-4 equality] ${viaFiles.length} tickets: files ${filesMs} ms, dk ${dkMs} ms\n`);
    expect(viaFiles.length).toBeGreaterThan(0);
    expect(viaFiles).toEqual([...viaDk].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
