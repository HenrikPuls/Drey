/**
 * Specs for the tolerant DTO mappers (E5b): complete payloads, missing
 * fields, mistyped fields and outright junk — the mappers forgive
 * everything and never throw.
 */
import { describe, expect, it } from 'vitest';
import {
  parseActiveSession,
  parseChatEvent,
  parseNeeds,
  parseProposal,
  parseSessions,
  parseTeam,
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
    });
  });

  it('forgives a missing card phase (falls back to the column id) and an unknown priority', () => {
    const work = parseWork({
      columns: [{ phase: { id: 'plan' }, tickets: [{ id: 'T-3', meta: { priority: 'yesterday', title: 'Odd' } }] }],
    });
    expect(work.groups[0]!.cards[0]).toMatchObject({ phase: 'plan', priority: 'normal', title: 'Odd' });
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

  it('never throws on junk', () => {
    expect(parseWork(null)).toEqual({ groups: [] });
    expect(parseWork(undefined)).toEqual({ groups: [] });
    expect(parseWork('board')).toEqual({ groups: [] });
    expect(parseWork([1, 2, 3])).toEqual({ groups: [] });
    expect(parseWork({})).toEqual({ groups: [] });
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

  it('never throws on junk', () => {
    expect(parseTeam(null, null)).toEqual({ personas: [] });
    expect(parseTeam([null, { title: 'no id' }, 'x'], 'junk')).toEqual({ personas: [] });
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
