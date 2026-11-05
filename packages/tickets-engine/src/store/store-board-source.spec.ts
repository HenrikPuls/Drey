import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleBoard } from '../core/ticket-board';
import { TicketStoreError, type TicketDetail, type TicketRecord, type TicketStore } from '../ports/ticket-store';
import { StoreBoardSource } from './store-board-source';
import { StoreReader } from './store-reader';
import type { StoreSettings } from './store-settings';

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: done, title: Done, handover: none }
---
`;
const BASE = { vaultId: 'v', vaultName: 'v', activeVaultName: 'v', isGitRepo: true, defaultWorker: 'opencode', pipelineText: PIPELINE, reposText: null };
const SETTINGS: StoreSettings = { backend: 'files', shadow: true, dkPath: '', dkStore: 'https://example.invalid/t.git#tickets', dkDataDir: '', dkCheckout: '', dkSyncSeconds: 30 };

function detail(id: string, rev: number, extra: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id, stage: 'inbox', title: id, owner: null, priority: 'normal', kind: null, epoch: 0, rev, labels: [], dependsOn: [], parent: null,
    claimedAt: null, leaseUntil: null, size: null, branch: null, repos: [], extensions: {}, text: '', body: '', ...extra,
  };
}

function fakeStore(details: TicketDetail[]): TicketStore & { shows: string[] } {
  const shows: string[] = [];
  return {
    shows,
    backend: 'dricket',
    capabilities: () => Promise.resolve({ backend: 'dricket', comments: false, leases: true, version: 'v0.6.0' }),
    list: () => Promise.resolve(details.map<TicketRecord>((d) => ({ ...d }))),
    show: (id) => {
      shows.push(id);
      const found = details.find((d) => d.id === id);
      return found === undefined ? Promise.reject(new TicketStoreError('not-found', id)) : Promise.resolve(found);
    },
    claim: () => Promise.reject(new Error('read-only')),
    release: () => Promise.reject(new Error('read-only')),
    extend: () => Promise.reject(new Error('read-only')),
    comments: () => Promise.resolve([]),
  };
}

describe('StoreReader', () => {
  it('re-reads only tickets whose row changed', async () => {
    const details = [detail('T-0001', 1), detail('T-0002', 1)];
    const store = fakeStore(details);
    const reader = new StoreReader(store, 2);
    expect((await reader.readAll()).map((d) => d.id)).toEqual(['T-0001', 'T-0002']);
    expect(store.shows).toEqual(['T-0001', 'T-0002']);
    await reader.readAll();
    expect(store.shows).toHaveLength(2);
    details[1] = detail('T-0002', 2);
    await reader.readAll();
    expect(store.shows).toEqual(['T-0001', 'T-0002', 'T-0002']);
  });

  it('keeps the list order whatever the parallelism', async () => {
    const details = Array.from({ length: 20 }, (_, i) => detail(`T-${String(i + 1).padStart(4, '0')}`, 1));
    const out = await new StoreReader(fakeStore(details), 5).readAll();
    expect(out.map((d) => d.id)).toEqual(details.map((d) => d.id));
  });
});

describe('StoreBoardSource', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });
  const tmp = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'drey-shadow-'));
    dirs.push(d);
    return d;
  };

  it('writes a diff report in shadow mode and keeps the shown board untouched', async () => {
    const dir = tmp();
    const log = vi.fn();
    const source = new StoreBoardSource(dir, log, 0, () => fakeStore([detail('T-0001', 1, { title: 'Changed in the store' })]));
    const shown = assembleBoard({
      ...BASE,
      files: [{ path: 'tickets/inbox/T-0001.md', text: '---\nid: T-0001\ntitle: Original\npriority: normal\n---\n' }],
    });
    const before = JSON.stringify(shown);
    const diff = await source.runShadow(SETTINGS, BASE, shown);
    expect(JSON.stringify(shown)).toBe(before);
    expect(diff?.equal).toBe(false);
    const md = readFileSync(path.join(dir, 'board-diff.md'), 'utf8');
    expect(md).toContain('`meta.title`: `Original` -> `Changed in the store`');
    const json = JSON.parse(readFileSync(path.join(dir, 'board-diff.json'), 'utf8')) as { diff: { differing: unknown[] } };
    expect(json.diff.differing).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boards differ'), 'warn');
  });

  it('reports an unreadable store instead of throwing', async () => {
    const dir = tmp();
    const source = new StoreBoardSource(dir, vi.fn(), 0, () => ({
      ...fakeStore([]),
      list: () => Promise.reject(new TicketStoreError('unavailable', 'dk was not found')),
    }));
    const shown = assembleBoard({ ...BASE, files: [] });
    expect(await source.runShadow(SETTINGS, BASE, shown)).toBeNull();
    expect(readFileSync(path.join(dir, 'board-diff.md'), 'utf8')).toContain('dk was not found');
  });

  it('runs at most once per interval and one at a time', async () => {
    const dir = tmp();
    const store = fakeStore([detail('T-0001', 1)]);
    const source = new StoreBoardSource(dir, vi.fn(), 60_000, () => store);
    const shown = assembleBoard({ ...BASE, files: [] });
    source.scheduleShadow(SETTINGS, BASE, shown);
    source.scheduleShadow(SETTINGS, BASE, shown);
    await vi.waitFor(() => expect(existsSync(path.join(dir, 'board-diff.json'))).toBe(true));
    source.scheduleShadow(SETTINGS, BASE, shown);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.shows).toEqual(['T-0001']);
  });

  it('builds the dricket board, or an empty one with an error issue when the store fails', async () => {
    const dir = tmp();
    const ok = new StoreBoardSource(dir, vi.fn(), 0, () => fakeStore([detail('T-0001', 1)]));
    const board = await ok.board({ ...SETTINGS, backend: 'dricket' }, BASE);
    expect(board.columns[0]!.tickets.map((t) => t.id)).toEqual(['T-0001']);
    const broken = new StoreBoardSource(dir, vi.fn(), 0, () => ({ ...fakeStore([]), list: () => Promise.reject(new Error('boom')) }));
    const empty = await broken.board({ ...SETTINGS, backend: 'dricket' }, BASE);
    expect(empty.columns.flatMap((c) => c.tickets)).toEqual([]);
    expect(empty.issues[0]).toEqual({ level: 'error', message: 'dricket store: boom' });
    const unset = await new StoreBoardSource(dir, vi.fn(), 0).board({ ...SETTINGS, dkStore: '' }, BASE);
    expect(unset.issues[0]!.message).toContain('tickets.dk.store');
  });
});
