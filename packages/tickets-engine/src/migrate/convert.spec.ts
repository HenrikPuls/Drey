import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildPlan, DEFAULT_MIGRATION_CONFIG, firstLogEntry, flatten, rewriteAttachmentLinks, type ConversionPlan, type MigrationConfig } from './convert';
import { patchDricketDocument, stubDocument } from './dricket-doc';
import { readLegacyVault } from './legacy-vault';

const FIXTURE = path.join(__dirname, 'fixtures', 'legacy-vault');
const vault = readLegacyVault(FIXTURE);

function plan(selected: string[], extra: Partial<MigrationConfig> = {}): ConversionPlan {
  return buildPlan(vault, { ...DEFAULT_MIGRATION_CONFIG, selected, ...extra });
}

function target(p: ConversionPlan, id: string) {
  const c = p.conversions.find((x) => x.legacyId === id);
  expect(c?.target, `${id} has a target`).toBeTruthy();
  return c!.target!;
}

describe('readLegacyVault', () => {
  it('reads phase folders and the archive, strips the NN- prefix and reports unreadable files', () => {
    const phases = Object.fromEntries(vault.tickets.map((t) => [t.id, t.phase]));
    expect(phases).toMatchObject({ 'T-0010': 'inbox', 'T-0020': 'prioritized', 'T-0012': 'build', 'T-0014': 'done', 'T-0049': 'archive' });
    expect(vault.unreadable).toEqual([{ relPath: 'tickets/10-inbox/T-0099.md', reason: 'no front matter fence' }]);
  });

  it('keeps the body verbatim (starts right after the closing fence line)', () => {
    const t = vault.tickets.find((x) => x.id === 'T-0010')!;
    expect(t.body.startsWith('\n## Description\n')).toBe(true);
    expect(t.text.endsWith(t.body)).toBe(true);
  });

  it('refuses a folder that is not a tickets vault', () => {
    expect(() => readLegacyVault(path.join(FIXTURE, 'tickets', '_meta'))).toThrow(/not a tickets vault/);
  });
});

describe('buildPlan -- field mapping', () => {
  const p = plan(['T-0010', 'T-0012', 'T-0020']);

  it('maps id, stage, title, priority, branch, repos and the plain extension fields', () => {
    const t = target(p, 'T-0010');
    expect(t).toMatchObject({ id: 't-10', number: 10, stage: 'inbox', title: 'Tags at scale — pre-filter and near-duplicate finder', priority: 'normal', kind: 'agent', branch: 't/T-0010', repos: ['drey'] });
    expect(t.extensions).toEqual({
      'x-legacy-id': 'T-0010',
      'x-legacy-phase': 'inbox',
      'x-created-at': '2026-10-18T11:12:11Z',
      'x-created-by': 'agent@legion',
      'x-rank': '5000',
      'x-entered-inbox': '2026-10-18T11:12:11Z',
    });
  });

  it('carries the body byte for byte', () => {
    const legacy = vault.tickets.find((x) => x.id === 'T-0010')!;
    expect(target(p, 'T-0010').body).toBe(legacy.body);
  });

  it('takes the kind from the creator: owner@ is human', () => {
    expect(target(plan(['T-0066']), 'T-0066')).toMatchObject({ kind: 'human', priority: 'low' });
  });

  it('maps Drey-only keys to x- fields: lists `;` for chain, `,` for the rest, booleans and parked-*', () => {
    const t = target(p, 'T-0020');
    expect(t.extensions).toMatchObject({
      'x-persona': 'build-default',
      'x-chain': 'plan; build; review',
      'x-references': 'docs/design/a.md, docs/design/b.md',
      'x-track': 'feature',
      'x-proof': 'tests',
      'x-worker': 'opencode',
      'x-interactive': 'true',
      'x-parked-reason': 'waiting for the design round',
      'x-rank': '2500',
      'x-entered-prioritized': '2026-10-21T09:30:00Z',
    });
    expect(t).toMatchObject({ stage: 'prioritized', priority: 'high', repos: ['drey', 'drey-tickets'], depends: ['t-10', 't-12'], parent: 't-12' });
  });

  it('rewrites ../attachments/ links and says so', () => {
    expect(target(p, 'T-0020').body).toContain('](attachments/2026-10-31-175203-fc07e1.png)');
    expect(p.conversions.find((c) => c.legacyId === 'T-0020')!.warnings.join('\n')).toMatch(/2 attachment link/);
    expect(rewriteAttachmentLinks('![a](../attachments/x.png) ![b](attachments/y.png)')).toEqual({ text: '![a](attachments/x.png) ![b](attachments/y.png)', count: 1 });
  });
});

describe('buildPlan -- what it cannot carry', () => {
  it('removes a dangling blocked-by, keeps it in x-legacy-blocked-by and warns (T-0017 -> T-0049)', () => {
    const p = plan(['T-0017']);
    const t = target(p, 'T-0017');
    expect(t.depends).toEqual([]);
    expect(t.extensions['x-legacy-blocked-by']).toBe('T-0049');
    expect(p.conversions[0]!.warnings.join('\n')).toMatch(/T-0049 not in the migrated set/);
  });

  it('drops depends/parent outside the selection but keeps them inside it', () => {
    const t = target(plan(['T-0010', 'T-0020']), 'T-0020');
    expect(t.depends).toEqual(['t-10']);
    expect(t.parent).toBeNull();
    expect(t.extensions['x-legacy-parent']).toBe('T-0012');
    expect(t.extensions['x-legacy-blocked-by']).toBe('T-0010, T-0012');
  });

  it('drops live state and blocks the apply: a run stamp, a claim in build', () => {
    const p = plan(['T-0030', 'T-0012']);
    const run = p.conversions.find((c) => c.legacyId === 'T-0030')!;
    expect(run.dropped).toContainEqual({ key: 'run', reason: 'live execution state is not migrated' });
    expect(run.blocking[0]).toMatch(/run stamp/);
    expect(run.target!.extensions['x-interactive']).toBe('true');
    const claimed = p.conversions.find((c) => c.legacyId === 'T-0012')!;
    expect(claimed.dropped.map((d) => d.key)).toEqual(['claimed-by', 'claimed-at']);
    expect(claimed.blocking[0]).toMatch(/claimed in build/);
  });

  it('keeps an unknown priority out of the board: default + x-legacy-priority + warning', () => {
    const p = plan(['T-0014']);
    expect(target(p, 'T-0014')).toMatchObject({ priority: 'normal', stage: 'done' });
    expect(target(p, 'T-0014').extensions['x-legacy-priority']).toBe('whenever');
    expect(p.conversions[0]!.warnings.join('\n')).toMatch(/priority "whenever" is not configured/);
  });

  it('shortens a title over 200 characters and prepends the full text to the description', () => {
    const p = plan(['T-0085']);
    const t = target(p, 'T-0085');
    expect(t.title.length).toBeLessThanOrEqual(200);
    expect(t.title.endsWith('…')).toBe(true);
    expect(t.body).toContain('## Description\n\nFull title: Bug: it says it is finished');
    expect(t.body).toContain('Der Titel ist zu lang.');
    expect(p.conversions[0]!.warnings.join('\n')).toMatch(/shortened/);
  });

  it('skips archived tickets, unknown phases and reports missing allow-list ids', () => {
    const p = plan(['T-0049', 'T-0555'], { stages: ['inbox', 'done'] });
    expect(p.conversions[0]).toMatchObject({ legacyId: 'T-0049', status: 'skip' });
    expect(p.conversions[0]!.skipReason).toMatch(/archived/);
    expect(p.missingSelected).toEqual(['T-0555']);
    const q = plan(['T-0020'], { stages: ['inbox', 'done'] });
    expect(q.conversions[0]!.skipReason).toMatch(/not one of the configured stages/);
  });

  it('lists the number gaps a fixed-id import would not need (R-26)', () => {
    expect(plan(['T-0010', 'T-0014']).placeholderNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
    expect(plan(['T-0010']).conversions[0]!.target!.number).toBe(10);
  });

  it('reports the unreadable files of the vault in the plan', () => {
    expect(plan(['T-0010']).unreadable).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('flatten makes one clean line of a scalar', () => {
    expect(flatten('a\nb\u0007 c')).toBe('a b  c');
    expect(flatten(5000)).toBe('5000');
    expect(flatten({})).toBeNull();
    expect(flatten('  ')).toBeNull();
  });

  it('firstLogEntry reads the creator of a Log line', () => {
    expect(firstLogEntry("## Log\n\n- '2026-10-18T11:12:11Z' agent@legion:opencode — created in inbox")).toEqual({ stamp: '2026-10-18T11:12:11Z', actor: 'agent@legion' });
    expect(firstLogEntry('nothing')).toBeNull();
  });
});

describe('dricket document patch', () => {
  it('sets header keys, replaces x- fields and swaps the body, leaving dk-owned fields alone', () => {
    const t = target(plan(['T-0020', 'T-0010', 'T-0012']), 'T-0020');
    const base = stubDocument(t, '2026-11-04T10:00:00Z', 'owner@legion').replace('x-persona: build-default', 'x-persona: stale');
    const doc = patchDricketDocument(base, t);
    expect(doc).toMatch(/^---\nid: t-20\ncreated_at: 2026-11-04T10:00:00Z\ncreated_by: owner@legion\n/);
    expect(doc).toContain('\nstage: prioritized\n');
    expect(doc).toContain('\ndepends: t-10, t-12\n');
    expect(doc).toContain('\nparent: t-12\n');
    expect(doc).toContain('\nrepos: drey, drey-tickets\n');
    expect(doc).not.toContain('stale');
    expect(doc.endsWith(t.body)).toBe(true);
    expect(doc.split('\n---\n')[0]).toContain('x-chain: plan; build; review');
  });

  it('refuses text that is not a dricket document', () => {
    expect(() => patchDricketDocument('no fence', target(plan(['T-0010']), 'T-0010'))).toThrow(/no front matter fence/);
  });
});
