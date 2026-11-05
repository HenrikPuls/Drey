import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDkVersion, DkProcess } from '../store/dk-process';
import { DricketTicketStore } from '../store/dricket-ticket-store';
import { applyPlan, assertScratchStore, initScratchStore, scratchConfigToml } from './apply';
import { buildPlan, DEFAULT_MIGRATION_CONFIG, rewriteAttachmentLinks, type ConversionPlan } from './convert';
import { stubDocument } from './dricket-doc';
import { parseLegacyTicket, readLegacyVault, type LegacyTicket } from './legacy-vault';
import { reverseTicket } from './reverse';
import { collectStoreRows, rowsFromLegacy, rowsFromRecords, shadowDiff } from './shadow-diff';

/**
 * The rollback proof (migration-plan §5 step 4): legacy -> dricket ->
 * reverse converter -> legacy' equals legacy, apart from the DECLARED
 * differences (live state, a dangling blocker, an unconfigured priority,
 * rewritten attachment links, a shortened title). The pure half runs on a
 * dk-shaped stub document; the dk half runs the real apply into a scratch
 * store (skipped, with the reason printed, without `dk` >= 0.6.0).
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'legacy-vault');
const vault = readLegacyVault(FIXTURE);
const SELECTED = ['T-0010', 'T-0012', 'T-0014', 'T-0017', 'T-0020', 'T-0066', 'T-0085'];
const DK_SELECTED = SELECTED;
const dkPlan: ConversionPlan = buildPlan(vault, { ...DEFAULT_MIGRATION_CONFIG, selected: DK_SELECTED });
const plan: ConversionPlan = buildPlan(vault, { ...DEFAULT_MIGRATION_CONFIG, selected: SELECTED });
const PHASES = DEFAULT_MIGRATION_CONFIG.stages;
const PHASE_DIRS = { inbox: '10-inbox', prioritized: '20-prioritized', build: '50-build', commit: '60-commit', done: '80-done' };

/** What the legacy header must look like after the round trip: the original minus the declared differences. */
function expectedHeader(t: LegacyTicket, p: ConversionPlan): Record<string, unknown> {
  const h: Record<string, unknown> = { ...t.header };
  for (const live of ['claimed-by', 'claimed-at', 'run']) {
    delete h[live];
  }
  if (h['priority'] === 'whenever') {
    h['priority'] = 'normal';
  }
  const target = p.conversions.find((c) => c.legacyId === t.id)!.target!;
  h['title'] = target.title;
  return sortKeys(h) as Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

function expectRoundTrip(legacy: LegacyTicket, reversedText: string, relPath: string, p: ConversionPlan = plan): void {
  const back = parseLegacyTicket(reversedText, relPath, legacy.id, 'x');
  if ('reason' in back) {
    throw new Error(`${legacy.id}: reverse output does not parse: ${back.reason}`);
  }
  expect(sortKeys(back.header), `${legacy.id} header`).toEqual(expectedHeader(legacy, p));
  const target = p.conversions.find((c) => c.legacyId === legacy.id)!.target!;
  expect(back.body, `${legacy.id} body`).toBe(target.body);
  if (target.title === (legacy.header['title'] as string)) {
    expect(back.body).toBe(rewriteAttachmentLinks(legacy.body).text);
  }
}

describe('reverse converter -- pure round trip over a dk-shaped document', () => {
  for (const id of SELECTED) {
    it(`${id}: legacy -> dricket -> legacy' equals legacy modulo the declared differences`, () => {
      const legacy = vault.tickets.find((t) => t.id === id)!;
      const target = plan.conversions.find((c) => c.legacyId === id)!.target!;
      const reversed = reverseTicket({ content: stubDocument(target) }, { phases: PHASES, phaseDirs: PHASE_DIRS });
      expect(reversed.relPath).toBe(`tickets/${PHASE_DIRS[target.stage as keyof typeof PHASE_DIRS]}/${id}.md`);
      expectRoundTrip(legacy, reversed.text, reversed.relPath);
    });
  }

  it('writes comments into the Log as one line each and reports what the legacy format cannot hold', () => {
    const target = plan.conversions.find((c) => c.legacyId === 'T-0010')!.target!;
    const content = stubDocument(target).replace('labels: ', 'labels: a, b').replace('owner: ', 'owner: ben.run-1');
    const r = reverseTicket({ content, comments: [{ at: '2026-11-05T08:00:00.123Z', author: 'owner@legion', text: 'Looks good.\nShip it.' }] }, { phases: PHASES });
    expect(r.text.trimEnd().split('\n').pop()).toBe("- '2026-11-05T08:00:00Z' owner@legion — comment: Looks good. Ship it.");
    expect(r.lost.join('\n')).toMatch(/labels \(a, b\)/);
    expect(r.lost.join('\n')).toMatch(/claim by ben\.run-1/);
    expect(r.lost.join('\n')).toMatch(/1 comment/);
  });

  it('restores a blocked-by that the migration moved to x-legacy-blocked-by (a done ticket outside the set)', () => {
    const doc = ['---', 'id: t-17', 'title: A', 'stage: inbox', 'depends: t-10', 'x-legacy-blocked-by: T-0010, T-0049', '---', '', 'x', ''].join('\n');
    const r = reverseTicket({ content: doc }, { phases: PHASES });
    expect(r.text).toContain('blocked-by:\n  - T-0010\n  - T-0049');
  });

  it('writes an archived ticket back into tickets/archive/ without calling the label lost', () => {
    const p = buildPlan(vault, { ...DEFAULT_MIGRATION_CONFIG, selected: ['T-0049'], includeArchive: true });
    const archived = p.conversions[0]!.target!;
    const r = reverseTicket({ content: stubDocument(archived) }, { phases: PHASES, phaseDirs: PHASE_DIRS });
    expect(r.relPath).toBe('tickets/archive/T-0049.md');
    expect(r.lost.join('\n')).not.toMatch(/labels/);
  });

  it('reads a ticket created after the cut-over (no x-legacy fields): default rank, branch from the id, folder by position', () => {
    const doc = ['---', 'id: t-92', 'title: New one', 'stage: build', 'priority: high', 'depends: t-10', '---', '', '## Description', '', 'x', ''].join('\n');
    const r = reverseTicket({ content: doc }, { phases: PHASES });
    expect(r.relPath).toBe('tickets/30-build/T-0092.md');
    expect(r.text).toContain('rank: 5000');
    expect(r.text).toContain('branch: t/T-0092');
    expect(r.text).toContain('blocked-by:\n  - T-0010');
  });
});

describe('shadow diff input', () => {
  const legacyRows = rowsFromLegacy(vault.tickets.filter((t) => SELECTED.includes(t.id)));

  it('is identical for a board and its faithful copy, listing the declared dangling blocker', () => {
    const store = plan.conversions.map((c) => c.target!).map((t) => ({
      id: t.legacyId,
      stage: t.stage,
      title: t.title,
      priority: t.priority,
      dependsOn: t.depends.map((d) => `T-${d.slice(2).padStart(4, '0')}`),
      rank: Number(t.extensions['x-rank'] ?? 5000),
    }));
    const diff = shadowDiff(legacyRows.map((r) => (r.id === 'T-0014' ? { ...r, priority: 'normal' } : r)).map((r) => (r.id === 'T-0085' ? { ...r, title: store.find((s) => s.id === 'T-0085')!.title } : r)), store);
    expect(diff.differences).toEqual([]);
    expect(diff.identical).toBe(true);
    expect(diff.declared).toContainEqual({ id: 'T-0017', what: 'blocked-by T-0049 is not in the store (dangling rule)' });
  });

  it('reports a moved ticket, a changed title, a lost dependency, a foreign ticket and a different column order', () => {
    const a = [row('T-0010', 'inbox', 1), row('T-0011', 'inbox', 2, ['T-0010']), row('T-0012', 'build', 1)];
    const b = [row('T-0010', 'inbox', 2), { ...row('T-0011', 'inbox', 1), title: 'other' }, row('T-0012', 'done', 1), row('T-0013', 'inbox', 1)];
    const diff = shadowDiff(a, b);
    expect(diff.identical).toBe(false);
    expect(diff.differences.map((d) => `${d.kind}:${d.id ?? ''}`).sort()).toEqual(['depends:T-0011', 'only-in-store:T-0013', 'order:', 'stage:T-0012', 'title:T-0011']);
  });

  it('declares an archived ticket (archive/ -> done + label) and a shortened title instead of reporting them', () => {
    const long = 'x'.repeat(230);
    const legacy = [{ ...row('T-0001', 'archive', 1), archived: true }, { ...row('T-0002', 'inbox', 1), title: long }];
    const store = [{ ...row('T-0001', 'done', 1), archived: true }, { ...row('T-0002', 'inbox', 1), title: `…` }];
    const diff = shadowDiff(legacy, store);
    expect(diff.differences).toEqual([]);
    expect(diff.declared.map((d) => d.id)).toEqual(['T-0002']);
  });

  it('leaves import placeholders out of the store rows', () => {
    const rows = rowsFromRecords([
      { id: 'T-0001', stage: 'cancelled', title: 'Unused', owner: null, priority: 'normal', kind: 'human', epoch: 0, rev: 1, labels: ['placeholder'], dependsOn: [], parent: null, claimedAt: null, leaseUntil: null, size: null, branch: null, repos: [], extensions: {} },
      { id: 'T-0010', stage: 'inbox', title: 'Real', owner: null, priority: 'normal', kind: 'agent', epoch: 0, rev: 1, labels: [], dependsOn: [], parent: null, claimedAt: null, leaseUntil: null, size: null, branch: null, repos: [], extensions: { 'x-rank': '7' } },
    ]);
    expect(rows).toEqual([{ id: 'T-0010', stage: 'inbox', title: 'Real', priority: 'normal', dependsOn: [], rank: 7, archived: false }]);
  });
});

function row(id: string, stage: string, rank: number, dependsOn: string[] = []) {
  return { id, stage, title: id, priority: 'normal', dependsOn, rank };
}

describe('scratch store guard and configuration', () => {
  it('refuses the legacy vault itself, a store inside it and a store around it', () => {
    const legacy = path.resolve('somewhere', 'drey-tickets');
    expect(() => assertScratchStore(legacy, { legacyRoot: legacy })).toThrow(/legacy vault itself/);
    expect(() => assertScratchStore(path.join(legacy, 'tickets', 'x'), { legacyRoot: legacy })).toThrow(/overlap/);
    expect(() => assertScratchStore(path.resolve('somewhere'), { legacyRoot: legacy })).toThrow(/overlap/);
    expect(() => assertScratchStore(path.resolve('elsewhere', 'scratch'), { legacyRoot: legacy })).not.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('refuses a store path too long for git on Windows', () => {
    const long = path.resolve('x'.repeat(130), 'store');
    expect(() => assertScratchStore(long, { legacyRoot: path.resolve('elsewhere', 'legacy') })).toThrow(/keep it under/);
  });

  it('writes Drey stages, priorities, no quota', () => {
    const toml = scratchConfigToml(DEFAULT_MIGRATION_CONFIG, 'owner@legion');
    expect(toml).toContain('values = ["inbox", "prioritized", "build", "commit", "done"]');
    expect(toml).toContain('claim = ["build", "commit"]');
    expect(toml).toContain('quota_tickets_per_day = 0');
    expect(toml).toContain('values = ["urgent", "high", "normal", "low"]');
  });
});

// ---------------------------------------------------------------------------
// The real thing: dk v0.6.0 and a scratch store in a temp dir with a temp HOME.

const bin = process.env['DREY_DK_BIN'] ?? 'dk';

function probe(): { ok: true; version: string } | { ok: false; reason: string } {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    const version = /version:\s*(\S+)/.exec(out)?.[1] ?? out.trim();
    try {
      assertDkVersion(version, bin);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const m = /(\d+)\.(\d+)/.exec(version);
    if (m === null || Number(m[1]) === 0 && Number(m[2]) < 6) {
      return { ok: false, reason: `dk ${version} is older than 0.6.0 (put --claim, [stages])` };
    }
    return { ok: true, version };
  } catch {
    return { ok: false, reason: `dk was not found ("${bin}"); set DREY_DK_BIN to a dk >= 0.6.0` };
  }
}

const found = probe();
if (!found.ok) {
  console.warn(`[migrate apply] SKIPPED: ${found.reason}`);
}

describe.skipIf(!found.ok)('apply into a scratch dricket store (real dk)', () => {
  let root = '';
  let env: NodeJS.ProcessEnv = {};
  let storeDir = '';
  let dk: DkProcess;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-migrate-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    storeDir = path.join(root, 'store');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Migrate Test',
      GIT_AUTHOR_EMAIL: 'migrate@test.invalid',
      GIT_COMMITTER_NAME: 'Migrate Test',
      GIT_COMMITTER_EMAIL: 'migrate@test.invalid',
    };
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses to apply a plan with a live run or a build claim unless told to', async () => {
    await initScratchStore({ bin, storeDir, env, config: DEFAULT_MIGRATION_CONFIG, admin: 'owner@legion' });
    dk = new DkProcess({ bin, store: storeDir, dataDir: path.join(root, 'data'), env });
    await expect(applyPlan(dkPlan, { storeDir, env, actor: 'owner@legion' })).rejects.toThrow(/refusing to apply: T-0012/);
  }, 60_000);

  it('applies the plan: ids keep their numbers, gaps stay gaps, dk validate is clean', async () => {
    const lines: string[] = [];
    const result = await applyPlan(dkPlan, { storeDir, env, actor: 'owner@legion', allowBlocking: true, onProgress: (l) => lines.push(l) });
    expect(result.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(result.complete).toBe(true);
    const created = result.outcomes.filter((o) => o.status === 'created').map((o) => o.id);
    expect(created).toEqual(['t-10', 't-12', 't-14', 't-17', 't-20', 't-66', 't-85']);
    expect(result.commits).toBe(7);

    const out = execFileSync(bin, ['validate'], { env: { ...env, DK_STORE: storeDir, DK_DATA_DIR: path.join(root, 'data'), DK_OWNER: 'owner@legion' }, encoding: 'utf8', windowsHide: true });
    expect(out).toBeDefined(); // execFileSync throws on a non-zero exit
  }, 600_000);

  it('the stored tickets carry stage, depends, x- fields and the legacy body', async () => {
    const store = new DricketTicketStore(dk);
    const t20 = await store.show('T-0020');
    expect(t20).toMatchObject({ stage: 'prioritized', priority: 'high', dependsOn: ['T-0010', 'T-0012'], repos: ['drey', 'drey-tickets'], branch: 't/T-0020' });
    expect(t20.extensions).toMatchObject({ 'x-persona': 'build-default', 'x-chain': 'plan; build; review', 'x-rank': '2500', 'x-legacy-id': 'T-0020' });
    expect(t20.body).toBe(dkPlan.conversions.find((c) => c.legacyId === 'T-0020')!.target!.body);
    expect((await store.show('T-0014')).priority).toBe('normal');
    expect((await store.list()).map((r) => r.id)).toEqual(['T-0010', 'T-0012', 'T-0014', 'T-0017', 'T-0020', 'T-0066', 'T-0085']);
  }, 120_000);

  it('keeps the legacy creation data, writes one commit per ticket on a linear branch and updates the checkout', () => {
    const git = (args: string[]): string => execFileSync('git', ['-C', storeDir, ...args], { env, encoding: 'utf8', windowsHide: true });
    const t10 = git(['show', 'refs/heads/tickets:tickets/t/0000/t-10/ticket.md']);
    expect(t10).toContain('\ncreated_at: 2026-10-18T11:12:11Z\ncreated_by: agent@legion\n');
    expect(t10).not.toContain('x-created-');
    const subjects = git(['log', '--first-parent', '--reverse', '--format=%s', 'refs/heads/tickets']).trim().split('\n');
    expect(subjects.slice(-7).map((s) => s.replace(/ \(migrated.*$/, ''))).toEqual(['t-10', 't-12', 't-14', 't-17', 't-20', 't-66', 't-85'].map((id) => `dricket: add ${id}`));
    expect(git(['rev-list', '--merges', '--count', 'refs/heads/tickets']).trim()).toBe('0');
    expect(git(['status', '--porcelain']).trim()).toBe('');
    expect(git(['show', 'refs/heads/tickets:tickets/t/0000/t-17/comments/' + git(['ls-tree', '--name-only', 'refs/heads/tickets:tickets/t/0000/t-17/comments/']).trim()])).toMatch(/^---\nticket: t-17\nauthor: owner@legion\ncreated_at: .*\n---\n\nMigration: legacy blocked-by was T-0049/);
    expect(git(['for-each-ref', 'refs/dricket-migrate']).trim()).toBe('');
  });

  it('shadow diff: the store board equals the legacy board (declared: the dangling blocker)', async () => {
    const storeRows = await collectStoreRows(new DricketTicketStore(dk));
    const diff = shadowDiff(rowsFromLegacy(vault.tickets.filter((t) => DK_SELECTED.includes(t.id))), storeRows);
    expect(diff.differences.map((d) => `${d.kind}:${d.id}`)).toEqual(['priority:T-0014']); // declared by the converter: an unconfigured priority
    expect(diff.declared.map((d) => d.id)).toEqual(['T-0017', 'T-0085']); // the dangling blocker, the title over 200 characters
    expect(diff.declared[0]).toEqual({ id: 'T-0017', what: 'blocked-by T-0049 is not in the store (dangling rule)' });
  }, 120_000);

  it("round trip through the REAL store: dk's own document reverses to the legacy ticket", async () => {
    const store = new DricketTicketStore(dk);
    for (const id of DK_SELECTED) {
      const legacy = vault.tickets.find((t) => t.id === id)!;
      const detail = await store.show(id);
      const reversed = reverseTicket({ content: detail.text }, { phases: PHASES, phaseDirs: PHASE_DIRS });
      expectRoundTrip(legacy, reversed.text, reversed.relPath, dkPlan);
    }
  }, 120_000);

  it('a second apply into the same store refuses', async () => {
    await expect(applyPlan(dkPlan, { storeDir, env, actor: 'owner@legion', allowBlocking: true })).rejects.toThrow(/already holds tickets/);
  }, 60_000);

  it('initScratchStore refuses a directory that is not empty', async () => {
    await expect(initScratchStore({ bin, storeDir, env, config: DEFAULT_MIGRATION_CONFIG, admin: 'owner@legion' })).rejects.toThrow(/not empty/);
  }, 60_000);
});
