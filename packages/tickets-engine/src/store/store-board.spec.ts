import { describe, expect, it } from 'vitest';
import { assembleBoard } from '../core/ticket-board';
import { parseTicketFile } from '../core/ticket-files';
import type { TicketDetail } from '../ports/ticket-store';
import { diffBoards } from './board-diff';
import { assembleBoardFromRecords, recordToBoardFile, resolvePhase } from './store-board';

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: build, title: Build, wip: 2, claim: true, handover: agent build-default }
  - { id: commit, title: Commit, claim: true, handover: manual }
  - { id: done, title: Done, handover: none }
---
Prose.
`;

const BASE = {
  vaultId: 'v',
  vaultName: 'tickets',
  activeVaultName: 'tickets',
  isGitRepo: true,
  defaultWorker: 'opencode',
  pipelineText: PIPELINE,
  reposText: `---\nrepos:\n  drey: { url: 'E:/projects/Drey' }\n---\n`,
};

function det(over: Partial<TicketDetail> & { id: string }): TicketDetail {
  return {
    stage: 'inbox',
    title: over.id,
    owner: null,
    priority: 'normal',
    kind: 'human',
    epoch: 0,
    rev: 1,
    labels: [],
    dependsOn: [],
    parent: null,
    claimedAt: null,
    leaseUntil: null,
    size: null,
    branch: null,
    repos: [],
    extensions: {},
    text: '',
    body: '\n## Description\n\nBody.\n',
    ...over,
  };
}

const phases = assembleBoard({ ...BASE, files: [] }).pipeline;

describe('resolvePhase', () => {
  it('uses the stage when it is a pipeline phase (variant A)', () => {
    expect(resolvePhase(det({ id: 'T-0001', stage: 'build' }), phases)).toEqual({ phase: 'build', unmapped: false });
  });

  it('lets x-phase win over the stage (variant B)', () => {
    const r = det({ id: 'T-0001', stage: 'in-progress', extensions: { 'x-phase': 'prioritized' } });
    expect(resolvePhase(r, phases)).toEqual({ phase: 'prioritized', unmapped: false });
  });

  it('maps dricket built-in stages by role', () => {
    const at = (stage: string): string => resolvePhase(det({ id: 'T-0001', stage }), phases).phase;
    expect(at('open')).toBe('inbox');
    expect(at('blocked')).toBe('inbox');
    expect(at('in-progress')).toBe('build');
    expect(at('review')).toBe('commit');
    expect(at('done')).toBe('done');
    expect(at('cancelled')).toBe('done');
  });

  it('leaves an unknown stage unmapped', () => {
    expect(resolvePhase(det({ id: 'T-0001', stage: 'needs-input' }), phases)).toEqual({ phase: 'needs-input', unmapped: true });
  });
});

describe('recordToBoardFile', () => {
  it('maps the header and reads back through the legacy parser', () => {
    const record = det({
      id: 'T-0063',
      title: 'Fix: the colon title',
      stage: 'build',
      priority: 'high',
      owner: 'ben.run-3',
      claimedAt: '2026-11-04T10:00:00Z',
      dependsOn: ['T-0040', 'T-0041'],
      parent: 'T-0060',
      repos: ['drey', 'tickets'],
      extensions: {
        'x-rank': '1500',
        'x-worker': 'claude-code',
        'x-persona': 'ben',
        'x-track': 'shape',
        'x-form': 'scout',
        'x-proof': 'tests',
        'x-awaiting': 'henrik',
        'x-interactive': 'true',
        'x-chain': 'skip review; insert design after build',
        'x-references': 'attachments/a.png, https://x.test/y',
        'x-entered-inbox': '2026-11-01T08:00:00Z',
        'x-entered-build': '2026-11-03T09:00:00Z',
      },
    });
    const file = recordToBoardFile(record, 'build');
    expect(file.path).toBe('tickets/build/T-0063.md');
    const { meta, issues } = parseTicketFile(file.text, file.path);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(meta).toMatchObject({
      id: 'T-0063',
      title: 'Fix: the colon title',
      priority: 'high',
      rank: 1500,
      repos: ['drey', 'tickets'],
      repo: 'drey',
      worker: 'claude-code',
      persona: 'ben',
      track: 'shape',
      form: 'scout',
      proof: 'tests',
      awaiting: 'henrik',
      interactive: true,
      parent: 'T-0060',
      claimedBy: 'ben.run-3',
      claimedAt: '2026-11-04T10:00:00Z',
      blockedBy: ['T-0040', 'T-0041'],
      references: ['attachments/a.png', 'https://x.test/y'],
      entered: { inbox: '2026-11-01T08:00:00Z', build: '2026-11-03T09:00:00Z' },
    });
    expect(meta.chain).toHaveLength(2);
    expect(file.text.endsWith('## Description\n\nBody.\n')).toBe(true);
  });

  it('writes nothing for absent fields', () => {
    const file = recordToBoardFile(det({ id: 'T-0001', priority: null }), 'inbox');
    expect(file.text).toBe('---\nid: T-0001\ntitle: T-0001\n---\n\n## Description\n\nBody.\n');
  });
});

describe('assembleBoardFromRecords', () => {
  const records = [
    det({ id: 'T-0001', stage: 'inbox', priority: 'low', extensions: { 'x-entered-inbox': '2026-11-01T00:00:00Z' } }),
    det({ id: 'T-0002', stage: 'inbox', priority: 'high' }),
    det({ id: 'T-0003', stage: 'inbox', priority: 'high', extensions: { 'x-rank': '10' } }),
    det({ id: 'T-0004', stage: 'build', dependsOn: ['T-0005'] }),
    det({ id: 'T-0005', stage: 'prioritized' }),
    det({ id: 'T-0006', stage: 'build', dependsOn: ['T-0007', 'T-0099'] }),
    det({ id: 'T-0007', stage: 'done' }),
  ];

  it('builds columns in pipeline order with the derived ticket order', () => {
    const board = assembleBoardFromRecords({ ...BASE, records });
    expect(board.columns.map((c) => c.phase.id)).toEqual(['inbox', 'prioritized', 'build', 'commit', 'done']);
    const ids = (phase: string): string[] => board.columns.find((c) => c.phase.id === phase)!.tickets.map((t) => t.id);
    // priority first, then rank (T-0003 has x-rank 10, the default is above it), then id
    expect(ids('inbox')).toEqual(['T-0003', 'T-0002', 'T-0001']);
    expect(ids('done')).toEqual(['T-0007']);
  });

  it('derives blocked and blocks from depends, done and unknown ids do not block', () => {
    const board = assembleBoardFromRecords({ ...BASE, records });
    const card = (id: string) => board.columns.flatMap((c) => c.tickets).find((t) => t.id === id)!;
    expect(card('T-0004').blocked).toEqual(['T-0005']);
    expect(card('T-0005').blocks).toEqual(['T-0004']);
    // T-0007 is done and T-0099 does not exist: neither blocks (the dependency pass's rule)
    expect(card('T-0006').blocked).toEqual([]);
  });

  it('leaves import placeholders (number gaps) and archived tickets off the board', () => {
    const board = assembleBoardFromRecords({
      ...BASE,
      records: [
        det({ id: 'T-0001', stage: 'inbox' }),
        det({ id: 'T-0002', stage: 'cancelled', title: 'Unused number T-0002', labels: ['placeholder'] }),
        det({ id: 'T-0003', stage: 'done', labels: ['archived'] }),
        det({ id: 'T-0004', stage: 'build', dependsOn: ['T-0002'] }),
      ],
    });
    const ids = board.columns.flatMap((c) => c.tickets.map((t) => t.id));
    expect(ids.sort()).toEqual(['T-0001', 'T-0004']);
    expect(board.columns.find((c) => c.phase.id === 'build')!.tickets[0]!.blocked).toEqual([]);
  });

  it('lists the tickets archived this week under recentDone, like tickets/archive/ does (E13-21)', () => {
    const log = (stamp: string): string => `## Log

- '${stamp}' owner@desk — archived
`;
    const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const board = assembleBoardFromRecords({
      ...BASE,
      records: [
        det({ id: 'T-0001', stage: 'inbox' }),
        det({ id: 'T-0003', stage: 'done', labels: ['archived'], title: 'Shipped', body: log(recent) }),
        det({ id: 'T-0004', stage: 'done', labels: ['archived'], body: log(old) }),
      ],
    });
    expect(board.recentDone).toEqual([{ id: 'T-0003', title: 'Shipped', at: recent }]);
  });

  it('shows an unmapped stage as an unknown column with a warning', () => {
    const board = assembleBoardFromRecords({ ...BASE, records: [det({ id: 'T-0001', stage: 'needs-input' })] });
    const column = board.columns.find((c) => c.phase.id === 'needs-input');
    expect(column?.unknown).toBe(true);
    expect(board.issues.some((i) => i.message.includes('needs-input'))).toBe(true);
  });

  it('is equal to the files board over the same tickets (the shadow criterion)', () => {
    const legacy = (id: string, dir: string, extra = ''): { path: string; text: string } => ({
      path: `tickets/${dir}/${id}.md`,
      text: `---\nid: ${id}\ntitle: ${id}\npriority: normal\n${extra}---\n\n## Description\n\nBody.\n`,
    });
    const files = [
      legacy('T-0001', 'inbox', 'entered-inbox: 2026-11-01T00:00:00Z\n'),
      legacy('T-0002', 'build', 'blocked-by: [T-0001]\nrank: 20\n'),
      legacy('T-0003', 'build', 'rank: 10\nchain: [skip review]\npersona: ben\n'),
      legacy('T-0004', 'done'),
    ];
    const fromFiles = assembleBoard({ ...BASE, files });
    const fromStore = assembleBoardFromRecords({
      ...BASE,
      records: [
        det({ id: 'T-0001', stage: 'inbox', extensions: { 'x-entered-inbox': '2026-11-01T00:00:00Z' } }),
        det({ id: 'T-0002', stage: 'build', dependsOn: ['T-0001'], extensions: { 'x-rank': '20' } }),
        det({ id: 'T-0003', stage: 'build', extensions: { 'x-rank': '10', 'x-chain': 'skip review', 'x-persona': 'ben' } }),
        det({ id: 'T-0004', stage: 'done' }),
      ],
    });
    const diff = diffBoards(fromFiles, fromStore);
    expect(diff.differing).toEqual([]);
    expect(diff.equal).toBe(true);
    expect(diff.identical).toBe(4);
  });
});
