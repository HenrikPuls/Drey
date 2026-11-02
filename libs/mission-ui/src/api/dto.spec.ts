/**
 * Specs for the tolerant DTO mappers (E5b): complete payloads, missing
 * fields, mistyped fields and outright junk — the mappers forgive
 * everything and never throw.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIORITY_CONFIG,
  isJumpPriority,
  parseActiveSession,
  parseBoardCard,
  parseChatEvent,
  parseImprovements,
  parseNeeds,
  parsePriorities,
  parseProposal,
  parseSessions,
  parseTeam,
  parseTicketDetail,
  parseTicketDiff,
  parseVerlaufEntries,
  parseVerification,
  parseWork,
} from './dto';

describe('parseWork', () => {
  it('maps columns to card groups', () => {
    const board = {
      columns: [
        {
          phase: { id: 'inbox', title: 'Inbox' },
          tickets: [
            {
              id: 'T-1',
              title: 'First',
              path: 'tickets/inbox/T-1.md',
              phase: 'inbox',
              blocked: ['T-2'],
              meta: { priority: 'high', persona: 'pia', claimedBy: 'owner@phone' },
            },
            {
              id: 'T-2',
              path: 'tickets/inbox/T-2.md',
              phase: 'inbox',
              meta: { priority: 'urgent' },
            },
          ],
        },
        { phase: { id: 'done', title: 'Done' }, tickets: [] },
      ],
      checkpoints: ['verify'],
    };
    expect(parseWork(board)).toEqual({
      groups: [
        {
          id: 'inbox',
          title: 'Inbox',
          cards: [
            {
              id: 'T-1',
              title: 'First',
              phase: 'inbox',
              priority: 'high',
              personaId: 'pia',
              claimedBy: 'owner@phone',
              blocked: ['T-2'],
            },
            {
              id: 'T-2',
              title: 'T-2',
              phase: 'inbox',
              priority: 'urgent',
              personaId: null,
              claimedBy: null,
              blocked: [],
            },
          ],
        },
        { id: 'done', title: 'Done', cards: [] },
      ],
      priorities: DEFAULT_PRIORITY_CONFIG,
    });
  });

  it('parses the board priorities tolerantly — default vocabulary when absent or junk', () => {
    expect(parseWork({ columns: [], priorities: { order: ['p0', 'p1', 'p2'], default: 'p1' } }).priorities).toEqual({
      order: ['p0', 'p1', 'p2'],
      default: 'p1',
    });
    // A missing `default` derives from the split point: floor(3/2) = 1.
    expect(parseWork({ columns: [], priorities: { order: ['p0', 'p1', 'p2'] } }).priorities).toEqual({
      order: ['p0', 'p1', 'p2'],
      default: 'p1',
    });
    // Junk entries and duplicates drop, an empty or unreadable list takes the default.
    expect(parseWork({ columns: [], priorities: { order: [1, null, 'p0', 'p0', ''] } }).priorities).toEqual({
      order: ['p0'],
      default: 'p0',
    });
    expect(parseWork({ columns: [], priorities: 'junk' }).priorities).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(parseWork({ columns: [], priorities: { order: [] } }).priorities).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(parseWork({ columns: [] }).priorities).toEqual(DEFAULT_PRIORITY_CONFIG);
  });

  it('forgives a missing card phase and keeps an unknown priority id as written', () => {
    const work = parseWork({
      columns: [{ phase: { id: 'plan' }, tickets: [{ id: 'T-3', meta: { priority: 'yesterday', title: 'Odd' } }, { id: 'T-4', meta: {} }] }],
    });
    // The vocabulary is the vault's: the id IS the label, never coerced;
    // a missing priority reads as none.
    expect(work.groups[0]!.cards[0]).toMatchObject({ phase: 'plan', priority: 'yesterday', title: 'Odd' });
    expect(work.groups[0]!.cards[1]).toMatchObject({ priority: null });
  });

  it('skips columns without an id and cards without an id', () => {
    const work = parseWork({
      columns: [
        { phase: { title: 'No id' }, tickets: [{ meta: {} }] },
        { phase: { id: 'inbox' }, tickets: [null, { id: 'T-4' }] },
        null,
      ],
    });
    expect(work.groups.length).toBe(1);
    expect(work.groups[0]!.cards.map((card) => card.id)).toEqual(['T-4']);
  });

  it('carries the card’s settled-run usage off the ledger, tolerantly', () => {
    const work = parseWork({
      columns: [
        {
          phase: { id: 'build', title: 'Build' },
          tickets: [
            { id: 'T-1', usage: { tokensIn: 48000, tokensOut: 6000, cost: 1.87, runs: 2 } },
            { id: 'T-2', usage: { tokensIn: 'x', tokensOut: null, cost: 'n/a', runs: true } },
            { id: 'T-3', usage: 'junk' },
            { id: 'T-4' },
          ],
        },
      ],
    });
    const cards = work.groups[0]!.cards;
    expect(cards[0]!.usage).toEqual({ tokensIn: 48000, tokensOut: 6000, cost: 1.87, runs: 2 });
    // Junk counters read as 0, an unreadable cost as null — never a guess.
    expect(cards[1]!.usage).toEqual({ tokensIn: 0, tokensOut: 0, cost: null, runs: 0 });
    // Absent or unusable usage stays absent — the cost slots hide.
    expect(cards[2]!.usage).toBeUndefined();
    expect(cards[3]!.usage).toBeUndefined();
  });

  it('never throws on junk', () => {
    const bare = { groups: [], priorities: DEFAULT_PRIORITY_CONFIG };
    expect(parseWork(null)).toEqual(bare);
    expect(parseWork(undefined)).toEqual(bare);
    expect(parseWork('board')).toEqual(bare);
    expect(parseWork([1, 2, 3])).toEqual(bare);
    expect(parseWork({})).toEqual(bare);
  });
});

describe('parseNeeds', () => {
  it('maps the needs list', () => {
    const needs = parseNeeds([
      { kind: 'question', ticketId: 'T-1', title: 'First', summary: 'which way?' },
      { kind: 'checkpoint', ticketId: 'T-2', title: 'Second' },
    ]);
    expect(needs).toEqual([
      { kind: 'question', ticketId: 'T-1', title: 'First', summary: 'which way?' },
      { kind: 'checkpoint', ticketId: 'T-2', title: 'Second', summary: '' },
    ]);
  });

  it('accepts the raw shape too (summary from text) and forgives junk items', () => {
    const needs = parseNeeds([
      { kind: 'permission', ticketId: 'T-1', title: 'First', text: 'allow bash?' },
      null,
      'junk',
      { title: 'No kind' },
    ]);
    expect(needs).toEqual([
      { kind: 'permission', ticketId: 'T-1', title: 'First', summary: 'allow bash?' },
      { kind: 'checkpoint', ticketId: null, title: 'No kind', summary: '' },
    ]);
  });

  it('keeps the improvements kind (E6) with its empty ticket id', () => {
    const needs = parseNeeds([{ kind: 'improvements', ticketId: '', title: 'Pia', text: '3 improvement proposals wait for the 1:1' }]);
    expect(needs).toEqual([{ kind: 'improvements', ticketId: null, title: 'Pia', summary: '3 improvement proposals wait for the 1:1' }]);
  });

  it('keeps the notify kind (E9) — a Bescheid card, not a checkpoint', () => {
    const needs = parseNeeds([{ kind: 'notify', ticketId: 'T-9', title: 'The build gate', text: 'verify completed' }]);
    expect(needs).toEqual([{ kind: 'notify', ticketId: 'T-9', title: 'The build gate', summary: 'verify completed' }]);
  });

  it('accepts the E7 kinds, keyed and keyless, with their text untouched', () => {
    const needs = parseNeeds([
      { kind: 'needs-decision', ticketId: 'T-7', title: 'Palette shortcut', text: '[palette-shortcut] Which shortcut should open the palette?' },
      { kind: 'blocked', ticketId: 'T-8', title: 'The build', text: '[ci] waiting for the build' },
      { kind: 'needs-decision', title: 'Palette shortcut', text: 'Which shortcut should open the palette?' },
      { kind: 'blocked', title: 'The build', text: 'waiting for the build' },
    ]);
    expect(needs).toEqual([
      { kind: 'needs-decision', ticketId: 'T-7', title: 'Palette shortcut', summary: '[palette-shortcut] Which shortcut should open the palette?' },
      { kind: 'blocked', ticketId: 'T-8', title: 'The build', summary: '[ci] waiting for the build' },
      { kind: 'needs-decision', ticketId: null, title: 'Palette shortcut', summary: 'Which shortcut should open the palette?' },
      { kind: 'blocked', ticketId: null, title: 'The build', summary: 'waiting for the build' },
    ]);
  });

  it('keeps a report need with its parsed report (E8)', () => {
    const needs = parseNeeds([
      {
        kind: 'report',
        ticketId: 'T-0004',
        title: 'Which storage backs the index?',
        phase: 'ready',
        runId: null,
        text: '1 of 2 decisions open — Which storage should back the index?',
        since: '2026-11-02T14:32:00Z',
        report: {
          writtenAt: '2026-11-02T14:32:00Z',
          by: 'pia',
          summary: 'The repo carries two index implementations.',
          decisions: [
            { key: 'D1', question: 'Which storage should back the index?', recommendation: 'SQLite', resolved: false },
            { key: 'D2', question: 'Migrate existing data?', recommendation: null, resolved: true },
          ],
        },
      },
    ]);
    expect(needs).toEqual([
      {
        kind: 'report',
        ticketId: 'T-0004',
        title: 'Which storage backs the index?',
        summary: '1 of 2 decisions open — Which storage should back the index?',
        report: {
          writtenAt: '2026-11-02T14:32:00Z',
          by: 'pia',
          summary: 'The repo carries two index implementations.',
          decisions: [
            { key: 'D1', question: 'Which storage should back the index?', recommendation: 'SQLite', resolved: false },
            { key: 'D2', question: 'Migrate existing data?', recommendation: null, resolved: true },
          ],
        },
      },
    ]);
  });

  it('forgives a broken report: junk decisions drop, a missing report reads as headline-only', () => {
    const needs = parseNeeds([
      {
        kind: 'report',
        ticketId: 'T-0005',
        title: 'Half there',
        text: 'the scout report is ready',
        report: {
          writtenAt: '2026-11-02T14:32:00Z',
          summary: 42,
          decisions: ['junk', null, { key: 'D1', question: 'Which storage?', recommendation: 7, resolved: 'yes' }],
        },
      },
      { kind: 'report', ticketId: 'T-0006', title: 'No detail', text: 'the scout report is ready', report: 'garbage' },
    ]);
    expect(needs).toEqual([
      {
        kind: 'report',
        ticketId: 'T-0005',
        title: 'Half there',
        summary: 'the scout report is ready',
        report: {
          writtenAt: '2026-11-02T14:32:00Z',
          by: '',
          summary: '',
          decisions: [{ key: 'D1', question: 'Which storage?', recommendation: null, resolved: false }],
        },
      },
      { kind: 'report', ticketId: 'T-0006', title: 'No detail', summary: 'the scout report is ready' },
    ]);
  });

  it('never throws on junk', () => {
    expect(parseNeeds(null)).toEqual([]);
    expect(parseNeeds({ kind: 'question' })).toEqual([]);
    expect(parseNeeds('needs')).toEqual([]);
  });
});

describe('parseTeam', () => {
  const personas = [
    { id: 'pia', title: 'Pia', role: 'Planner', worker: 'opencode', model: 'zai/glm-5.3', pool: ['a', 'b'], color: '#ff0000' },
    { id: 'tessa', title: 'Tessa', role: 'Tester', worker: 'codex', model: 'gpt-5', color: '#00ff00' },
  ];

  it('folds the newest live run into the persona that dispatched it', () => {
    const team = parseTeam(personas, {
      runs: [
        { id: 'r2', ticketId: 'T-2', state: 'running', persona: 'pia' },
        { id: 'r1', ticketId: 'T-1', state: 'done', persona: 'pia' },
        { id: 'r3', ticketId: 'T-3', state: 'failed', persona: 'tessa' },
      ],
      chain: null,
    });
    expect(team.personas[0]).toMatchObject({
      id: 'pia',
      pool: ['a', 'b'],
      currentRun: { ticketId: 'T-2', state: 'running' },
    });
    expect(team.personas[1]).toMatchObject({ id: 'tessa', pool: [], currentRun: null });
  });

  it('keeps currentRun null when the fleet is missing or the persona dispatched nothing', () => {
    expect(parseTeam(personas, null).personas.every((p) => p.currentRun === null)).toBe(true);
    expect(parseTeam(personas, { runs: [{ state: 'running', persona: null, ticketId: 'T-9' }] }).personas[0]!.currentRun).toBeNull();
    expect(parseTeam([], { runs: [] }).personas).toEqual([]);
  });

  it('carries the day-cost figures off the wire, tolerantly (concept §4.3)', () => {
    const team = parseTeam(
      [
        { id: 'pia', budget: 5, dailyCost: 1.4 },
        { id: 'ben', budget: 5 },
        { id: 'ralf', dailyCost: 0.19 },
        { id: 'tessa', budget: 'n/a', dailyCost: -1 },
        { id: 'noa' },
      ],
      null,
    );
    expect(team.personas[0]).toMatchObject({ budget: 5, dailyCost: 1.4 });
    // A budget without a settled cost today: no dailyCost — never a fake 0.
    expect(team.personas[1]).toMatchObject({ budget: 5 });
    expect(team.personas[1]!.dailyCost).toBeUndefined();
    expect(team.personas[2]).toMatchObject({ budget: null, dailyCost: 0.19 });
    // Junk on either figure reads as none, never a guess.
    expect(team.personas[3]).toMatchObject({ budget: null });
    expect(team.personas[3]!.dailyCost).toBeUndefined();
    expect(team.personas[4]).toMatchObject({ budget: null });
    expect(team.personas[4]!.dailyCost).toBeUndefined();
  });

  it('never throws on junk', () => {
    expect(parseTeam(null, null)).toEqual({ personas: [], runs: [] });
    expect(parseTeam([null, { title: 'no id' }, 'x'], 'junk')).toEqual({ personas: [], runs: [] });
  });
});

describe('parseImprovements', () => {
  const PIA = { id: 'pia', title: 'Pia', role: 'Planner', worker: 'opencode', model: 'zai/glm-5.3', pool: ['a'], color: '#ff0000' };

  it('maps the answer with the persona, the proposals and the counters', () => {
    const view = parseImprovements({
      persona: PIA,
      proposals: [
        {
          id: 'imp-1',
          state: 'open',
          target: 'prompt.md',
          title: 'Order the pack',
          evidence: ['2026-11-01 · T-0007 · guessed the shape'],
          content: 'You build in the ticket’s worktree…',
          lesson: 'Keep the pack recipe explicit.',
          at: '2026-11-02T10:00:00Z',
          decidedAt: null,
        },
        {
          id: 'imp-2',
          state: 'dismissed',
          target: 'models.default',
          title: 'Try sonnet',
          evidence: [],
          content: 'sonnet',
          lesson: null,
          at: '2026-11-02T10:00:00Z',
          decidedAt: '2026-11-02T11:00:00Z',
        },
      ],
      openCount: 1,
      frictionCount: 4,
    });
    expect(view).toEqual({
      persona: { ...PIA, currentRun: null, budget: null },
      proposals: [
        {
          id: 'imp-1',
          state: 'open',
          target: 'prompt.md',
          title: 'Order the pack',
          evidence: ['2026-11-01 · T-0007 · guessed the shape'],
          content: 'You build in the ticket’s worktree…',
          lesson: 'Keep the pack recipe explicit.',
          at: '2026-11-02T10:00:00Z',
          decidedAt: null,
        },
        {
          id: 'imp-2',
          state: 'dismissed',
          target: 'models.default',
          title: 'Try sonnet',
          evidence: [],
          content: 'sonnet',
          lesson: null,
          at: '2026-11-02T10:00:00Z',
          decidedAt: '2026-11-02T11:00:00Z',
        },
      ],
      openCount: 1,
      frictionCount: 4,
    });
  });

  it('counts the open proposals when the desk omits openCount, and defaults the rest', () => {
    const view = parseImprovements({
      proposals: [
        { id: 'imp-1', state: 'open', target: 'memory', title: 'A', content: 'x' },
        { id: 'imp-2', state: 'open', target: 'memory', title: 'B', content: 'y' },
        { id: 'imp-3', state: 'accepted', target: 'memory', title: 'C', content: 'z' },
      ],
    });
    expect(view?.openCount).toBe(2);
    expect(view?.frictionCount).toBe(0);
    expect(view?.persona).toBeNull();
  });

  it('degrades an unknown state to open, drops id-less proposals, filters junk evidence', () => {
    const view = parseImprovements({
      proposals: [
        { target: 'memory', title: 'no id', content: 'x' },
        null,
        { id: 'imp-9', state: 'weird', target: 'prompt.md', title: 'Odd', evidence: ['a', 2, 'b'], content: 'c' },
      ],
    });
    expect(view?.proposals).toEqual([
      { id: 'imp-9', state: 'open', target: 'prompt.md', title: 'Odd', evidence: ['a', 'b'], content: 'c', lesson: null, at: '', decidedAt: null },
    ]);
  });

  it('never throws on junk', () => {
    expect(parseImprovements(null)).toBeNull();
    expect(parseImprovements('junk')).toBeNull();
    expect(parseImprovements({})).toEqual({ persona: null, proposals: [], openCount: 0, frictionCount: 0 });
  });
});

describe('parseSessions', () => {
  it('maps the sessions listing', () => {
    const sessions = parseSessions([
      { file: 'tickets/_meta/chat/a.md', title: 'A', createdAt: '2026-11-01', updatedAt: '2026-11-02', pending: 2 },
      { file: 'tickets/_meta/chat/b.md', title: 'B', createdAt: '', updatedAt: '', pending: -3 },
    ]);
    expect(sessions).toEqual([
      { file: 'tickets/_meta/chat/a.md', title: 'A', createdAt: '2026-11-01', updatedAt: '2026-11-02', pending: 2 },
      { file: 'tickets/_meta/chat/b.md', title: 'B', createdAt: '', updatedAt: '', pending: 0 },
    ]);
  });

  it('drops entries without a file and never throws on junk', () => {
    expect(parseSessions([{ title: 'no file' }, null, { file: 'f.md' }])).toEqual([
      { file: 'f.md', title: 'f.md', createdAt: '', updatedAt: '', pending: 0 },
    ]);
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions({})).toEqual([]);
  });
});

describe('parseActiveSession', () => {
  it('maps a session with messages and proposals', () => {
    const session = parseActiveSession({
      file: 'tickets/_meta/chat/a.md',
      title: 'A',
      createdAt: '2026-11-01',
      messages: [
        { role: 'owner', text: 'hi', at: 't1', thought: null },
        { role: 'mission', text: 'hello', at: 't2', thought: 'thinking…' },
        { role: 'ghost', text: 'junk role' },
      ],
      proposals: [
        { id: 'p-1', state: 'pending', summary: 'Create T-9', at: 't3', decidedAt: null, outcome: null },
        { id: 'p-2', state: 'confirmed', summary: 'Move T-1', at: 't4', decidedAt: 't5', outcome: 'moved to plan' },
        'junk',
      ],
    });
    expect(session).toEqual({
      file: 'tickets/_meta/chat/a.md',
      title: 'A',
      createdAt: '2026-11-01',
      messages: [
        { role: 'owner', text: 'hi', thought: null, at: 't1' },
        { role: 'mission', text: 'hello', thought: 'thinking…', at: 't2' },
        { role: 'mission', text: 'junk role', thought: null, at: '' },
      ],
      proposals: [
        { id: 'p-1', state: 'pending', summary: 'Create T-9', at: 't3', decidedAt: null, outcome: null },
        { id: 'p-2', state: 'confirmed', summary: 'Move T-1', at: 't4', decidedAt: 't5', outcome: 'moved to plan' },
      ],
    });
  });

  it('returns null without a usable file and never throws on junk', () => {
    expect(parseActiveSession(null)).toBeNull();
    expect(parseActiveSession({ title: 'no file' })).toBeNull();
    expect(parseActiveSession('session')).toBeNull();
    expect(parseActiveSession({ file: 'f.md', messages: [null], proposals: [null] })).toEqual({
      file: 'f.md',
      title: 'f.md',
      createdAt: '',
      messages: [],
      proposals: [],
    });
  });
});

describe('parseProposal', () => {
  it('maps a proposal and defaults a missing state to pending', () => {
    expect(parseProposal({ id: 'p-1', state: 'dismissed', summary: 's', at: 't1', decidedAt: 't2', outcome: null })).toEqual({
      id: 'p-1',
      state: 'dismissed',
      summary: 's',
      at: 't1',
      decidedAt: 't2',
      outcome: null,
    });
    expect(parseProposal({ id: 'p-2', summary: 's' })).toEqual({
      id: 'p-2',
      state: 'pending',
      summary: 's',
      at: '',
      decidedAt: null,
      outcome: null,
    });
    expect(parseProposal(null)).toBeNull();
  });

  it('carries the setChain command payload (E9) and nothing on other kinds', () => {
    expect(
      parseProposal({
        id: 'p-3',
        summary: 'Set T-0042 chain to 2 entries',
        state: 'pending',
        at: 't1',
        decidedAt: null,
        outcome: null,
        command: { kind: 'setChain', id: 'T-0042', chain: ['skip verify', 'notify build'] },
      }),
    ).toEqual({
      id: 'p-3',
      state: 'pending',
      summary: 'Set T-0042 chain to 2 entries',
      at: 't1',
      decidedAt: null,
      outcome: null,
      chain: { id: 'T-0042', chain: ['skip verify', 'notify build'] },
    });
    expect(
      parseProposal({ id: 'p-4', summary: 'Move T-1 from a to b', command: { kind: 'transition', id: 'T-1', from: 'a', to: 'b' } }),
    ).toEqual({
      id: 'p-4',
      state: 'pending',
      summary: 'Move T-1 from a to b',
      at: '',
      decidedAt: null,
      outcome: null,
    });
    expect(parseProposal({ id: 'p-5', summary: 's', command: { kind: 'setChain', id: '', chain: [] } })).toEqual({
      id: 'p-5',
      state: 'pending',
      summary: 's',
      at: '',
      decidedAt: null,
      outcome: null,
    });
  });

  it('carries a setBlockedBy proposal by its summary alone — no compare payload', () => {
    expect(
      parseProposal({
        id: 'p-6',
        summary: 'Block T-0002 by T-0001',
        state: 'pending',
        command: { kind: 'setBlockedBy', id: 'T-0002', blockedBy: ['T-0001'] },
      }),
    ).toEqual({
      id: 'p-6',
      state: 'pending',
      summary: 'Block T-0002 by T-0001',
      at: '',
      decidedAt: null,
      outcome: null,
    });
  });
});

describe('parsePriorities', () => {
  it('reads order and default, derives the default from the split when absent', () => {
    expect(parsePriorities({ order: ['a', 'b', 'c', 'd'], default: 'b' })).toEqual({ order: ['a', 'b', 'c', 'd'], default: 'b' });
    expect(parsePriorities({ order: ['a', 'b', 'c'] })).toEqual({ order: ['a', 'b', 'c'], default: 'b' });
    // A default the order does not hold derives from the split point.
    expect(parsePriorities({ order: ['a', 'b', 'c'], default: 'zzz' })).toEqual({ order: ['a', 'b', 'c'], default: 'b' });
  });

  it('falls back to the default vocabulary on absent, junk or empty input', () => {
    expect(parsePriorities(undefined)).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(parsePriorities(null)).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(parsePriorities('priorities')).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(parsePriorities({})).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(parsePriorities({ order: 'a,b' })).toEqual(DEFAULT_PRIORITY_CONFIG);
    expect(parsePriorities({ order: [42, {}, '  '] })).toEqual(DEFAULT_PRIORITY_CONFIG);
  });

  it('is the default vocabulary the jump-class rule reads', () => {
    expect(DEFAULT_PRIORITY_CONFIG).toEqual({ order: ['urgent', 'high', 'normal', 'low'], default: 'normal' });
    // floor(4/2) = 2: urgent and high sit in the jump class, the rest not.
    expect(isJumpPriority('urgent', DEFAULT_PRIORITY_CONFIG.order)).toBe(true);
    expect(isJumpPriority('high', DEFAULT_PRIORITY_CONFIG.order)).toBe(true);
    expect(isJumpPriority('normal', DEFAULT_PRIORITY_CONFIG.order)).toBe(false);
    expect(isJumpPriority('low', DEFAULT_PRIORITY_CONFIG.order)).toBe(false);
    expect(isJumpPriority('p0', DEFAULT_PRIORITY_CONFIG.order)).toBe(false);
    expect(isJumpPriority(null, DEFAULT_PRIORITY_CONFIG.order)).toBe(false);
    // Odd lengths: floor(3/2) = 1 — only the first entry jumps.
    expect(isJumpPriority('a', ['a', 'b', 'c'])).toBe(true);
    expect(isJumpPriority('b', ['a', 'b', 'c'])).toBe(false);
  });
});

describe('parseChatEvent', () => {
  it('maps the payload-less frames', () => {
    expect(parseChatEvent('board', '{}')).toEqual({ kind: 'board' });
    expect(parseChatEvent('needs', '{}')).toEqual({ kind: 'needs' });
    expect(parseChatEvent('fleet', '{}')).toEqual({ kind: 'fleet' });
    expect(parseChatEvent('remote', '{}')).toEqual({ kind: 'remote' });
  });

  it('maps the chat stream frames with their payload', () => {
    expect(parseChatEvent('chat', '{"file":"f.md","event":{"kind":"text","text":"Hel"}}')).toEqual({
      kind: 'chat',
      file: 'f.md',
      event: { kind: 'text', text: 'Hel' },
    });
    expect(parseChatEvent('chat', '{"file":"f.md","event":{"kind":"thought","text":"hm"}}')).toEqual({
      kind: 'chat',
      file: 'f.md',
      event: { kind: 'thought', text: 'hm' },
    });
    expect(
      parseChatEvent('chat', '{"file":"f.md","event":{"kind":"proposal","proposal":{"id":"p-1","state":"pending","summary":"Create T-9","at":"t3","decidedAt":null}}}'),
    ).toEqual({
      kind: 'chat',
      file: 'f.md',
      event: {
        kind: 'proposal',
        proposal: { id: 'p-1', state: 'pending', summary: 'Create T-9', at: 't3', decidedAt: null, outcome: null },
      },
    });
    expect(parseChatEvent('chat', '{"file":"f.md","event":{"kind":"done"}}')).toEqual({
      kind: 'chat',
      file: 'f.md',
      event: { kind: 'done' },
    });
    expect(parseChatEvent('chat', '{"file":"f.md","event":{"kind":"error","message":"the model gave up"}}')).toEqual({
      kind: 'chat',
      file: 'f.md',
      event: { kind: 'error', message: 'the model gave up' },
    });
  });

  it('lands broken chat payloads and unknown names on unknown', () => {
    expect(parseChatEvent('chat', 'not json')).toEqual({ kind: 'unknown', name: 'chat' });
    expect(parseChatEvent('chat', '{"event":{"kind":"done"}}')).toEqual({ kind: 'unknown', name: 'chat' });
    expect(parseChatEvent('chat', '{"file":"f.md","event":{"kind":"mystery"}}')).toEqual({ kind: 'unknown', name: 'chat' });
    expect(parseChatEvent('board-extra', '{}')).toEqual({ kind: 'unknown', name: 'board-extra' });
  });
});

describe('parseVerification', () => {
  const SECTION = [
    '## Verification',
    '',
    'Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.',
    '',
    '### Criteria',
    '',
    '- [x] `npm run build` → ![](../attachments/verify-20261101-143200-01.png)',
    '- [ ] `npm test` — no screenshot: the app never became ready',
    '',
    '### Findings',
    '',
    '- The settings page stayed blank until the reload.',
    '',
  ].join('\n');

  it('maps the canonical section', () => {
    expect(parseVerification(SECTION)).toEqual({
      testedAt: '2026-11-01T14:32:00Z',
      tester: 'verify@engine',
      environment: 'Electron 34.2.0 on win32',
      criteria: [
        { command: 'npm run build', passed: true, screenshot: 'verify-20261101-143200-01.png', note: null },
        { command: 'npm test', passed: false, screenshot: null, note: 'no screenshot: the app never became ready' },
      ],
      findings: ['The settings page stayed blank until the reload.'],
    });
  });

  it('reads the section out of a full ticket file and stops at the next H2', () => {
    const file = `---\nid: T-1\n---\n\n# T-1\n\n## Plan\n\ndo it\n\n${SECTION}## Log\n\n- '2026-11-01T14:40:00Z' me — moved\n`;
    const verification = parseVerification(file);
    expect(verification).not.toBeNull();
    expect(verification!.criteria).toHaveLength(2);
    expect(verification!.findings).toEqual(['The settings page stayed blank until the reload.']);
  });

  it('tolerates a bare section: stamp without environment, no screenshots, no findings', () => {
    const verification = parseVerification('## Verification\n\n- [X] `npm run build`\n');
    expect(verification).toEqual({
      testedAt: '',
      tester: '',
      environment: '',
      criteria: [{ command: 'npm run build', passed: true, screenshot: null, note: null }],
      findings: [],
    });
  });

  it('returns null when the heading is absent and never throws on junk', () => {
    expect(parseVerification('# T-1\n\nno proof yet\n')).toBeNull();
    expect(parseVerification('')).toBeNull();
    expect(parseVerification(null as unknown as string)).toBeNull();
    expect(parseVerification('## Verificationism\n\n- [x] `x`')).toBeNull();
  });
});

describe('parseTicketDetail', () => {
  const phases = [
    { id: 'inbox', title: 'Inbox' },
    { id: 'verify', title: 'Verify' },
  ];
  const TICKET_TEXT = ['---', 'id: T-1', '---', '', '# One', '', '## Verification', '', '- [x] `npm test`', ''].join('\n');

  it('maps the ticket reply with the verification parsed out of the markdown', () => {
    const detail = parseTicketDetail(
      {
        ok: true,
        card: { id: 'T-1', title: 'One', phase: 'verify', meta: { priority: 'high' } },
        text: TICKET_TEXT,
        revision: 'abc123',
      },
      phases,
    );
    expect(detail).toEqual({
      id: 'T-1',
      title: 'One',
      revision: 'abc123',
      text: TICKET_TEXT,
      verification: {
        testedAt: '',
        tester: '',
        environment: '',
        criteria: [{ command: 'npm test', passed: true, screenshot: null, note: null }],
        findings: [],
      },
      phases,
      phase: 'verify',
      chain: [],
      priority: 'high',
      blockedBy: [],
      blocked: [],
      blocks: [],
      verlauf: [],
    });
  });

  it('parses the ## Verlauf chapter off the text tolerantly — and the usage off the card', () => {
    const detail = parseTicketDetail(
      {
        ok: true,
        card: {
          id: 'T-1',
          phase: 'verify',
          usage: { tokensIn: 48000, tokensOut: 6000, cost: 1.87, runs: 2 },
        },
        text: [
          '## Description',
          '',
          'why',
          '',
          '## Verlauf',
          '',
          '- { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 1.17, dauer: 12m, ausgang: handed-over }',
          '- {phase: verify, persona: tessa, model: sonnet, tokens: 52k, cost: 0.64, dauer: 40m, ausgang: failed}',
          'prose and torn lines are not entries',
          '- { phase: build, persona: ben',
          '',
          '## Log',
          '',
          "- '2026-11-01T14:40:00Z' me — moved",
          '',
        ].join('\n'),
        revision: 'abc123',
      },
      phases,
    );
    expect(detail!.usage).toEqual({ tokensIn: 48000, tokensOut: 6000, cost: 1.87, runs: 2 });
    // The chapter ends at the next H2; only the `- {…}` lines are entries.
    expect(detail!.verlauf).toEqual([
      {
        phase: 'plan',
        persona: 'pia',
        model: 'opus',
        tokens: '48k',
        cost: 1.17,
        dauer: '12m',
        ausgang: 'handed-over',
      },
      {
        phase: 'verify',
        persona: 'tessa',
        model: 'sonnet',
        tokens: '52k',
        cost: 0.64,
        dauer: '40m',
        ausgang: 'failed',
      },
    ]);
    // Tolerance: no chapter, no usage, junk — nulls and [], never a throw.
    const bare = parseTicketDetail({ ok: true, card: { id: 'T-2', usage: 'junk' }, text: '## Verlauf\n\nno lines yet\n', revision: '' }, phases);
    expect(bare!.verlauf).toEqual([]);
    expect(bare!.usage).toBeUndefined();
    expect(parseVerlaufEntries('## Verlaufism\n\n- {phase: plan}\n')).toEqual([]);
    expect(parseVerlaufEntries(null as unknown as string)).toEqual([]);
  });

  it('parses the priority id and the blockedBy/blocked/blocks lists tolerantly', () => {
    const detail = parseTicketDetail(
      {
        ok: true,
        card: {
          id: 'T-1',
          phase: 'build',
          meta: { priority: 'p0', blockedBy: ['T-0002', 7, null, 'T-0003'] },
          blocked: ['T-0002'],
          blocks: ['T-0009'],
        },
        text: 'x',
        revision: '',
      },
      phases,
    );
    expect(detail).toMatchObject({ priority: 'p0', blockedBy: ['T-0002', 'T-0003'], blocked: ['T-0002'], blocks: ['T-0009'] });
    const bare = parseTicketDetail({ ok: true, card: { id: 'T-2', meta: {} }, text: '', revision: '' }, phases);
    expect(bare).toMatchObject({ priority: null, blockedBy: [], blocked: [], blocks: [] });
  });

  it('maps the chain delta off the card meta tolerantly', () => {
    const detail = parseTicketDetail(
      {
        ok: true,
        card: {
          id: 'T-1',
          phase: 'build',
          meta: {
            chain: [
              { kind: 'insert', phase: 'design', anchor: 'review', position: 'after', persona: 'pia', notify: true },
              { kind: 'skip', phase: 'verify' },
              { kind: 'notify', phase: 'build' },
              { kind: 'mystery', phase: 'x' },
              { kind: 'insert', phase: 'no-anchor' },
              'junk',
            ],
          },
        },
        text: TICKET_TEXT,
        revision: 'abc123',
      },
      phases,
    );
    expect(detail?.chain).toEqual([
      { kind: 'insert', phase: 'design', anchor: 'review', position: 'after', persona: 'pia', notify: true },
      { kind: 'skip', phase: 'verify', anchor: null, position: null, persona: null, notify: false },
      { kind: 'notify', phase: 'build', anchor: null, position: null, persona: null, notify: false },
    ]);
  });

  it('falls back to the meta title and an empty phase, and rides the given phases along', () => {
    const detail = parseTicketDetail({ ok: true, card: { id: 'T-2', meta: { title: 'Two' } }, text: 'x', revision: '' }, phases);
    expect(detail).toMatchObject({ id: 'T-2', title: 'Two', phase: '', phases });
  });

  it('returns null for a refused, card-less or id-less answer and never throws on junk', () => {
    expect(parseTicketDetail({ ok: false, error: 'no such ticket' }, phases)).toBeNull();
    expect(parseTicketDetail({ ok: true, text: 'x' }, phases)).toBeNull();
    expect(parseTicketDetail({ ok: true, card: { meta: {} }, text: 'x' }, phases)).toBeNull();
    expect(parseTicketDetail(null, phases)).toBeNull();
    expect(parseTicketDetail('ticket', phases)).toBeNull();
  });
});

describe('parseBoardCard (E9)', () => {
  const BOARD = {
    columns: [
      {
        phase: { id: 'build', title: 'Build' },
        tickets: [
          {
            id: 'T-1',
            phase: 'build',
            meta: { chain: [{ kind: 'skip', phase: 'verify' }] },
          },
        ],
      },
      { phase: { id: 'verify', title: 'Verify' }, tickets: [{ id: 'T-2', phase: 'verify', meta: {} }] },
    ],
  };

  it('finds the card and reads its phase and chain delta', () => {
    expect(parseBoardCard(BOARD, 'T-1')).toEqual({
      phase: 'build',
      chain: [{ kind: 'skip', phase: 'verify', anchor: null, position: null, persona: null, notify: false }],
    });
    expect(parseBoardCard(BOARD, 'T-2')).toEqual({ phase: 'verify', chain: [] });
  });

  it('returns null for an unknown id and never throws on junk', () => {
    expect(parseBoardCard(BOARD, 'T-9')).toBeNull();
    expect(parseBoardCard(null, 'T-1')).toBeNull();
    expect(parseBoardCard('board', 'T-1')).toBeNull();
    expect(parseBoardCard({ columns: [{ tickets: [null, 'x', { id: 'T-3' }] }] }, 'T-3')).toEqual({ phase: '', chain: [] });
  });
});

describe('parseTicketDiff', () => {
  it('maps the files and the truncated flag', () => {
    expect(
      parseTicketDiff({
        files: [
          { status: 'M', path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
          { status: 'A', path: 'src/b.ts', patch: '' },
        ],
        truncated: true,
      }),
    ).toEqual({
      files: [
        { status: 'M', path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
        { status: 'A', path: 'src/b.ts', patch: '' },
      ],
      truncated: true,
    });
  });

  it('drops file entries without a path and never throws on junk', () => {
    expect(parseTicketDiff({ files: [{ status: 'M' }, null, { status: 'D', path: 'gone.ts' }], truncated: 'yes' })).toEqual({
      files: [{ status: 'D', path: 'gone.ts', patch: '' }],
      truncated: false,
    });
    expect(parseTicketDiff(null)).toEqual({ files: [], truncated: false });
    expect(parseTicketDiff('diff')).toEqual({ files: [], truncated: false });
  });
});
