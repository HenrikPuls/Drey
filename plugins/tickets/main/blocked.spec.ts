import { describe, expect, it } from 'vitest';
import { blockedRefusal, runDependencyPass } from './blocked';
import { assembleBoard } from './ticket-board';
import { parseTicketFile, patchTicketFile } from './ticket-files';
import type { TicketCard, TicketIssue } from '../shared/tickets';

/**
 * The blocked-by dependency pass (T-0050): parse shapes, the derived
 * blocked/blocks state, its validation findings, and the frontmatter
 * round-trip through a machine transition rewrite.
 */

// --- parse shapes -----------------------------------------------------------

function ticketText(id: string, extra: readonly string[] = []): string {
  return [
    '---',
    `id: ${id}`,
    `title: "Ticket ${id}"`,
    'priority: normal',
    'rank: 5000',
    `branch: t/${id}`,
    ...extra,
    "entered-inbox: '2026-10-18T10:00:00Z'",
    '---',
    '',
    '## Description',
    '',
    'It should work.',
    '',
    '## Log',
    '',
  ].join('\n');
}

describe('parseTicketFile: blocked-by', () => {
  const path = (id: string): string => `tickets/50-build/${id}.md`;

  it('reads the canonical flow list without findings', () => {
    const parsed = parseTicketFile(ticketText('T-0049', ['blocked-by: [T-0048]']), path('T-0049'));
    expect(parsed.meta.blockedBy).toEqual(['T-0048']);
    expect(parsed.issues).toEqual([]);
  });

  it('reads the two-element form and the block style', () => {
    const flow = parseTicketFile(
      ticketText('T-0049', ['blocked-by: [T-0048, T-0047]']),
      path('T-0049'),
    );
    expect(flow.meta.blockedBy).toEqual(['T-0048', 'T-0047']);
    expect(flow.issues).toEqual([]);

    const block = parseTicketFile(
      ticketText('T-0049', ['blocked-by:', '  - T-0048', '  - T-0047']),
      path('T-0049'),
    );
    expect(block.meta.blockedBy).toEqual(['T-0048', 'T-0047']);
    expect(block.issues).toEqual([]);
  });

  it('absent and empty read as no dependencies', () => {
    for (const extra of [[], ['blocked-by: []']]) {
      const parsed = parseTicketFile(ticketText('T-0049', extra), path('T-0049'));
      expect(parsed.meta.blockedBy).toEqual([]);
      expect(parsed.issues).toEqual([]);
    }
  });

  it('a non-list warns visibly and reads as absent — never a silent shape guess', () => {
    const parsed = parseTicketFile(ticketText('T-0049', ['blocked-by: T-0048']), path('T-0049'));
    expect(parsed.meta.blockedBy).toEqual([]);
    expect(parsed.issues).toEqual([{ level: 'warning', message: 'blocked-by is not a list — ignored' }]);
  });

  it('non-string entries warn and drop; string entries stay as written', () => {
    const parsed = parseTicketFile(
      ticketText('T-0049', ['blocked-by: [T-0048, 42, null]']),
      path('T-0049'),
    );
    expect(parsed.meta.blockedBy).toEqual(['T-0048']);
    expect(parsed.issues).toEqual([{ level: 'warning', message: 'blocked-by has a non-string entry — dropped' }]);
  });
});

// --- the derived state --------------------------------------------------------

function card(id: string, phase: string, blockedBy: readonly string[] = []): TicketCard {
  const parsed = parseTicketFile(
    ticketText(id, blockedBy.length === 0 ? [] : [`blocked-by: [${blockedBy.join(', ')}]`]),
    `tickets/50-build/${id}.md`,
  );
  return {
    id,
    path: `tickets/50-build/${id}.md`,
    phase,
    meta: { ...parsed.meta, blockedBy },
    pinned: false,
    worker: 'opencode',
    blocked: [],
    blocks: [],
    issues: [],
  };
}

const TERMINAL = 'done';

const findingsOf = (pass: ReturnType<typeof runDependencyPass>, id: string): readonly TicketIssue[] =>
  pass.issuesByCard.get(id) ?? [];

describe('runDependencyPass', () => {
  it('blocks while the blocker sits in any non-terminal phase', () => {
    for (const phase of ['inbox', 'prioritized', 'plan', 'build']) {
      const pass = runDependencyPass([card('T-0001', phase), card('T-0002', 'plan', ['T-0001'])], TERMINAL);
      expect(pass.blocked.get('T-0002')).toEqual(['T-0001']);
      expect(pass.blocks.get('T-0001')).toEqual(['T-0002']);
    }
  });

  it('unblocks the moment the blocker reaches the terminal phase', () => {
    const pass = runDependencyPass([card('T-0001', TERMINAL), card('T-0002', 'plan', ['T-0001'])], TERMINAL);
    expect(pass.blocked.get('T-0002')).toEqual([]);
    // A satisfied blocker shows nothing — the inverse is open edges only.
    expect(pass.blocks.get('T-0001')).toEqual([]);
  });

  it('several blockers need all satisfied; the open ones stay named', () => {
    const half = runDependencyPass(
      [card('T-0001', TERMINAL), card('T-0002', 'build'), card('T-0003', 'plan', ['T-0001', 'T-0002'])],
      TERMINAL,
    );
    expect(half.blocked.get('T-0003')).toEqual(['T-0002']);
    expect(half.blocks.get('T-0002')).toEqual(['T-0003']);

    const all = runDependencyPass(
      [card('T-0001', TERMINAL), card('T-0002', TERMINAL), card('T-0003', 'plan', ['T-0001', 'T-0002'])],
      TERMINAL,
    );
    expect(all.blocked.get('T-0003')).toEqual([]);
  });

  it('an unknown id warns and keeps the dependent blocked', () => {
    const pass = runDependencyPass([card('T-0002', 'plan', ['T-0048'])], TERMINAL);
    expect(pass.blocked.get('T-0002')).toEqual(['T-0048']);
    expect(findingsOf(pass, 'T-0002')).toEqual([
      { level: 'warning', message: 'blocked-by names T-0048, which is not on the board' },
    ]);
  });

  it('self-reference is an error naming the id, and the card counts as blocked', () => {
    const pass = runDependencyPass([card('T-0001', 'build', ['T-0001'])], TERMINAL);
    expect(pass.blocked.get('T-0001')).toEqual(['T-0001']);
    expect(findingsOf(pass, 'T-0001')).toEqual([
      { level: 'error', message: 'blocked-by cycle: T-0001 -> T-0001' },
    ]);
  });

  it('a two-ticket cycle errors on every member with the cycle in the message', () => {
    const pass = runDependencyPass(
      [card('T-0002', 'build', ['T-0001']), card('T-0001', 'plan', ['T-0002'])],
      TERMINAL,
    );
    const message = 'blocked-by cycle: T-0001 -> T-0002 -> T-0001';
    expect(findingsOf(pass, 'T-0001')).toEqual([{ level: 'error', message }]);
    expect(findingsOf(pass, 'T-0002')).toEqual([{ level: 'error', message }]);
    expect(pass.blocked.get('T-0001')).toEqual(['T-0002']);
    expect(pass.blocked.get('T-0002')).toEqual(['T-0001']);
  });

  it('a cycle member in the terminal phase still counts as blocked (the cycle is unsatisfiable)', () => {
    const pass = runDependencyPass(
      [card('T-0002', 'build', ['T-0001']), card('T-0001', TERMINAL, ['T-0002'])],
      TERMINAL,
    );
    expect(pass.blocked.get('T-0001')).toEqual(['T-0002']);
    expect(pass.blocked.get('T-0002')).toEqual(['T-0001']);
  });

  it('a blocker in an unknown directory resolves by its stripped phase id — never terminal', () => {
    const pass = runDependencyPass([card('T-0001', 'limbo'), card('T-0002', 'plan', ['T-0001'])], TERMINAL);
    expect(pass.blocked.get('T-0002')).toEqual(['T-0001']);
  });

  it('a duplicate blocker id resolves to the first occurrence in column order', () => {
    const pass = runDependencyPass(
      [card('T-0001', TERMINAL), card('T-0001', 'build'), card('T-0002', 'plan', ['T-0001'])],
      TERMINAL,
    );
    expect(pass.blocked.get('T-0002')).toEqual([]);
  });

  it('blockedRefusal names the id and its blockers; null when unblocked', () => {
    const pass = runDependencyPass([card('T-0001', 'build'), card('T-0002', 'plan', ['T-0001'])], TERMINAL);
    const blockedCard: TicketCard = { ...card('T-0002', 'plan'), blocked: pass.blocked.get('T-0002')! };
    expect(blockedRefusal(blockedCard)).toBe(
      'T-0002 is blocked by T-0001 — the blockers must reach the terminal phase first',
    );
    expect(blockedRefusal(card('T-0001', 'build'))).toBeNull();
  });
});

// --- the board wiring ---------------------------------------------------------

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default }',
  '  - { id: build, title: Build, handover: agent build-default }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'Prose.',
  '',
].join('\n');

function boardOf(files: readonly { path: string; text: string }[]) {
  return assembleBoard({
    vaultId: 'v',
    vaultName: 'tickets',
    activeVaultName: 'notes',
    isGitRepo: true,
    defaultWorker: 'opencode',
    pipelineText: PIPELINE,
    orderText: null,
    reposText: null,
    files,
  });
}

const cardOf = (snap: ReturnType<typeof boardOf>, id: string): TicketCard => {
  for (const column of snap.columns) {
    const found = column.tickets.find((t) => t.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`${id} is not on the board`);
};

describe('assembleBoard derives the blocked state', () => {
  it('cards carry blocked/blocks and the pass findings', () => {
    const snap = boardOf([
      { path: 'tickets/20-plan/T-0001.md', text: ticketText('T-0001') },
      {
        path: 'tickets/30-build/T-0002.md',
        text: ticketText('T-0002', ['blocked-by: [T-0001]']),
      },
    ]);
    expect(cardOf(snap, 'T-0002').blocked).toEqual(['T-0001']);
    expect(cardOf(snap, 'T-0002').issues).toEqual([]);
    expect(cardOf(snap, 'T-0001').blocks).toEqual(['T-0002']);
  });

  it('the state flips when the blocker moves to the terminal phase — no stored flag', () => {
    const snap = boardOf([
      { path: 'tickets/40-done/T-0001.md', text: ticketText('T-0001') },
      {
        path: 'tickets/30-build/T-0002.md',
        text: ticketText('T-0002', ['blocked-by: [T-0001]']),
      },
    ]);
    expect(cardOf(snap, 'T-0002').blocked).toEqual([]);
    expect(cardOf(snap, 'T-0001').blocks).toEqual([]);
  });

  it('an unknown reference surfaces the warning on the dependent card', () => {
    const snap = boardOf([
      {
        path: 'tickets/30-build/T-0002.md',
        text: ticketText('T-0002', ['blocked-by: [T-0048]']),
      },
    ]);
    const found = cardOf(snap, 'T-0002');
    expect(found.blocked).toEqual(['T-0048']);
    expect(found.issues).toEqual([
      { level: 'warning', message: 'blocked-by names T-0048, which is not on the board' },
    ]);
  });
});

// --- the round-trip -----------------------------------------------------------

describe('patchTicketFile keeps blocked-by byte-stable', () => {
  const body = ['', '## Description', '', 'It should work.', '', '## Log', ''].join('\n');

  const file = (blockedLine: string): string =>
    [
      '---',
      'id: T-0049',
      'title: "Follow-up"',
      'priority: normal',
      'rank: 5000',
      'branch: t/T-0049',
      blockedLine,
      "entered-build: '2026-10-29T10:00:00Z'",
      '---',
      body,
    ].join('\n');

  const transition = (text: string): string =>
    patchTicketFile(text, {
      to: 'commit',
      from: 'build',
      now: new Date('2026-10-29T12:00:00Z'),
      actor: 'agent@box',
    });

  it('a one-element flow list survives a transition rewrite untouched', () => {
    const patched = transition(file('blocked-by: [T-0048]'));
    expect(patched.split('\n')).toContain('blocked-by: [T-0048]');
    expect(patched.split('\n').filter((l) => l.startsWith('blocked-by'))).toEqual(['blocked-by: [T-0048]']);
    expect(parseTicketFile(patched, 'tickets/70-commit/T-0049.md').meta.blockedBy).toEqual(['T-0048']);
  });

  it('the two-element canonical form survives byte-identically too', () => {
    const patched = transition(file('blocked-by: [T-0048, T-0047]'));
    expect(patched.split('\n')).toContain('blocked-by: [T-0048, T-0047]');
    expect(parseTicketFile(patched, 'tickets/70-commit/T-0049.md').meta.blockedBy).toEqual(['T-0048', 'T-0047']);
  });

  it('a hand-written no-space list parses everywhere and normalizes on the machine rewrite', () => {
    const loose = file('blocked-by: [T-0048,T-0047]');
    expect(parseTicketFile(loose, 'tickets/50-build/T-0049.md').meta.blockedBy).toEqual(['T-0048', 'T-0047']);
    const patched = transition(loose);
    expect(patched.split('\n')).toContain('blocked-by: [T-0048, T-0047]');
    expect(parseTicketFile(patched, 'tickets/70-commit/T-0049.md').meta.blockedBy).toEqual(['T-0048', 'T-0047']);
  });
});
