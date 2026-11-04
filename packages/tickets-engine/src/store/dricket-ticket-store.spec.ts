import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DkProcess, type ExecFn, type ExecResult } from './dk-process';
import { detailFromContent, DricketTicketStore } from './dricket-ticket-store';

/**
 * The store against the raw output of a real dk v0.5.0 (fixtures captured by
 * `dricket-contract.spec.ts` with DREY_CAPTURE_DK_FIXTURES=1) — runs
 * everywhere, with or without dk installed.
 */
const DIR = path.join(__dirname, 'fixtures', 'dk-v0.5.0');
const index = JSON.parse(readFileSync(path.join(DIR, 'index.json'), 'utf8')) as Record<string, { args: string[]; code: number }>;

function fixture(name: string): ExecResult {
  return { stdout: readFileSync(path.join(DIR, `${name}.json`), 'utf8'), stderr: '', code: index[name]!.code, failure: null };
}

function storeAnswering(...names: string[]): { store: DricketTicketStore; argv: string[][] } {
  const argv: string[][] = [];
  const queue = [...names];
  const exec: ExecFn = (_f, args) => {
    if (args[0] === '--version') {
      return Promise.resolve({ stdout: 'version: v0.5.0\n', stderr: '', code: 0, failure: null });
    }
    argv.push([...args]);
    return Promise.resolve(fixture(queue.shift()!));
  };
  return { store: new DricketTicketStore(new DkProcess({ bin: 'dk', store: '/fixture-store', exec })), argv };
}

describe('DricketTicketStore over captured dk v0.5.0 output', () => {
  it('lists header records with display ids', async () => {
    const { store, argv } = storeAnswering('01-ls-initial');
    const rows = await store.list();
    expect(argv).toEqual([['--json', 'ls']]);
    expect(rows.map((r) => r.id)).toEqual(['T-0001', 'T-0002', 'T-0003']);
    expect(rows[0]).toMatchObject({ stage: 'open', owner: null, kind: 'human', epoch: 0, rev: 0, labels: [] });
    expect(rows[1]).toMatchObject({ priority: 'high', labels: ['a', 'b'] });
    expect(rows[1]!.dependsOn).toEqual([]);
  });

  it('turns the null list of an empty stage into []', async () => {
    const { store, argv } = storeAnswering('16-ls-empty-stage');
    expect(await store.list({ stage: 'cancelled', owner: 'x' })).toEqual([]);
    expect(argv[0]).toEqual(['--json', 'ls', '-s', 'cancelled', '-o', 'x']);
  });

  it('shows a ticket from the raw file (flat reader, title with a colon)', async () => {
    const { store, argv } = storeAnswering('04-show-claimed');
    const t = await store.show('T-0001');
    expect(argv).toEqual([['--json', 'show', 't-1']]);
    expect(t).toMatchObject({ id: 'T-0001', title: 'First: a title with a colon', stage: 'in-progress', owner: 'ben.slice-1', epoch: 1, size: 'S', kind: 'agent' });
    expect(t.leaseUntil).toMatch(/^2026-/);
    expect(t.body).toContain('## Description');
    expect(t.text.startsWith('---\nid: t-1\n')).toBe(true);
  });

  it('claims with size and kind, the actor in the environment', async () => {
    const { store, argv } = storeAnswering('03-claim');
    const claim = await store.claim('T-0001', { actor: 'ben.slice-1', size: 'S' });
    expect(argv[0]).toEqual(['--json', 'claim', '--size', 'S', '--kind', 'agent', 't-1']);
    expect(claim).toMatchObject({ id: 'T-0001', epoch: 1, takeover: false });
  });

  it('maps the taken claim (11), the missing ticket (10) and the refused release (14)', async () => {
    await expect(storeAnswering('05-claim-taken').store.claim('T-0001', { actor: 'x' })).rejects.toMatchObject({ kind: 'claimed', exitCode: 11 });
    await expect(storeAnswering('12-claim-missing').store.claim('T-0099', { actor: 'x' })).rejects.toMatchObject({ kind: 'not-found', exitCode: 10 });
    await expect(storeAnswering('14-release-invalid').store.release('T-0002', { actor: 'x', stage: 'done' })).rejects.toMatchObject({ kind: 'invalid', exitCode: 14 });
  });

  it('releases with stage and message, and extends with a reason', async () => {
    const released = storeAnswering('08-release');
    expect(await released.store.release('T-0001', { actor: 'a', stage: 'review', message: 'done it' })).toEqual({ id: 'T-0001', stage: 'review' });
    expect(released.argv[0]).toEqual(['--json', 'release', '--stage', 'review', '-m', 'done it', 't-1']);
    const extended = storeAnswering('06-extend');
    expect(await extended.store.extend('T-0001', { actor: 'a', reason: 'tests take longer' })).toMatchObject({ id: 'T-0001', epoch: 1, extensions: 1, maxExtensions: 3 });
    expect(extended.argv[0]).toEqual(['--json', 'extend', '-m', 'tests take longer', 't-1']);
  });

  it('refuses ids that are not display ids before spawning anything', async () => {
    const { store, argv } = storeAnswering();
    await expect(store.show('t-1')).rejects.toMatchObject({ kind: 'usage' });
    expect(argv).toEqual([]);
  });

  it('says comments cannot be read yet and names the requirement', async () => {
    const { store } = storeAnswering();
    await expect(store.comments()).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('R-08') });
    expect(await store.capabilities()).toEqual({ backend: 'dricket', comments: false, leases: true, version: 'v0.5.0' });
  });

  it('reads extension keys and dependencies from a ticket document', () => {
    const t = detailFromContent('---\nid: t-63\ntitle: x\nstage: open\nowner: \nepoch: 0\nrev: 4\ndepends: t-48, t-49\nx-rank: 12\nrepos: drey, other\n---\nbody');
    expect(t).toMatchObject({ id: 'T-0063', dependsOn: ['T-0048', 'T-0049'], extensions: { 'x-rank': '12' }, repos: ['drey', 'other'], rev: 4, body: 'body' });
  });
});
