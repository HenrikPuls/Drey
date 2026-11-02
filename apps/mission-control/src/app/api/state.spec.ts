/**
 * Specs for the McState signal store (E5b): the boot → pair → listen
 * lifecycle, the event-driven refreshes, the chat stream's incremental
 * text application, and every mutation's `{ok, error?}` surfacing. The
 * state runs against a real McClient on the fake desk, with the SSE
 * stream driven by hand — no DOM, no socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McClient } from './client';
import { FakeDesk } from './fakes';
import { McState } from './state';

const FILE_A = 'tickets/_meta/chat/a.md';
const FILE_B = 'tickets/_meta/chat/b.md';
const enc = (path: string): string => encodeURIComponent(path);

const waitFor = async (check: () => void): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    try {
      check();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  check();
};

afterEach(() => {
  vi.useRealTimers();
});

/** A desk with the standard GET routes; every payload is mutable from the test. */
const makeDesk = () => {
  const desk = new FakeDesk();
  const data: {
    board: unknown;
    needs: unknown;
    personas: unknown;
    fleet: unknown;
    sessions: unknown;
    sessionA: unknown;
    ticket: unknown;
    piaImprovements: unknown;
    tessaImprovements: unknown;
  } = {
    board: { columns: [{ phase: { id: 'inbox', title: 'Inbox' }, tickets: [] }], checkpoints: [] as string[] },
    needs: [] as unknown[],
    personas: [] as unknown[],
    fleet: { runs: [] as unknown[], chain: null },
    sessions: [] as unknown[],
    sessionA: { file: FILE_A, title: 'A', createdAt: '2026-11-01', messages: [] as unknown[], proposals: [] as unknown[] },
    ticket: {
      ok: true,
      card: { id: 'T-1', title: 'One', phase: 'verify', meta: { priority: 'high' } },
      text: '---\nid: T-1\n---\n\n# One\n',
      revision: 'r1',
    },
    piaImprovements: {
      persona: { id: 'pia', title: 'Pia', role: 'Planner', worker: 'opencode', model: 'zai/glm-5.3', pool: [], color: '#ff0000' },
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
      ],
      openCount: 1,
      frictionCount: 4,
    },
    tessaImprovements: { persona: { id: 'tessa', title: 'Tessa' }, proposals: [], openCount: 0, frictionCount: 0 },
  };
  desk.on('GET', '/api/me', () => ({ ok: true, device: { name: 'phone', readOnly: false } }));
  desk.on('GET', '/api/board', () => data.board);
  desk.on('GET', '/api/needs', () => data.needs);
  desk.on('GET', '/api/personas', () => data.personas);
  desk.on('GET', '/api/fleet', () => data.fleet);
  desk.on('GET', '/api/chat/sessions', () => data.sessions);
  desk.on('GET', `/api/chat/sessions/${enc(FILE_A)}`, () => data.sessionA);
  desk.on('GET', '/api/tickets/T-1', () => data.ticket);
  desk.on('GET', '/api/personas/pia/improvements', () => data.piaImprovements);
  desk.on('GET', '/api/personas/tessa/improvements', () => data.tessaImprovements);
  return { desk, data };
};

const makeState = (desk: FakeDesk): McState => new McState(new McClient({ fetch: desk.fetch, storage: desk.storage }));

describe('boot', () => {
  it('pairs a code from the URL, stores the token and becomes ready', async () => {
    const { desk, data } = makeDesk();
    data.board = { columns: [{ phase: { id: 'inbox', title: 'Inbox' }, tickets: [{ id: 'T-1', title: 'One', phase: 'inbox', blocked: [], meta: { priority: 'high' } }] }], checkpoints: [] };
    desk.on('POST', '/api/pair', () => ({ ok: true, token: 'fresh-token', device: { name: 'phone' } }));
    const state = makeState(desk);

    await state.boot({ pairCode: '  1234-5678  ', token: null });

    expect(desk.storage.getItem('drey.remote.token')).toBe('fresh-token');
    expect(state.pairing()).toBe('ready');
    expect(desk.callsOf('POST', '/api/pair')[0]!.body).toEqual({ code: '1234-5678' });

    await waitFor(() => expect(state.connected()).toBe(true));
    await waitFor(() => expect(state.work().groups[0]!.cards.map((c) => c.id)).toEqual(['T-1']));
    expect(desk.callsOf('GET', '/api/board').length).toBeGreaterThan(0);
    expect(desk.callsOf('GET', '/api/events').length).toBe(1);
  });

  it('goes straight to ready with a stored token and refreshes every slice', async () => {
    const { desk, data } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'old-token');
    data.needs = [{ kind: 'question', ticketId: 'T-1', title: 'One', summary: 'which way?' }];
    data.personas = [{ id: 'pia', title: 'Pia', role: 'Planner', worker: 'opencode', model: 'zai/glm-5.3', pool: [], color: '#ff0000' }];
    data.fleet = { runs: [{ id: 'r1', ticketId: 'T-1', state: 'running', persona: 'pia' }], chain: null };
    data.sessions = [{ file: FILE_A, title: 'A', createdAt: '2026-11-01', updatedAt: '2026-11-02', pending: 1 }];
    const state = makeState(desk);

    await state.boot();

    expect(state.pairing()).toBe('ready');
    expect(desk.callsOf('POST', '/api/pair').length).toBe(0);
    await waitFor(() => expect(state.connected()).toBe(true));
    await waitFor(() => {
      expect(state.needs().map((n) => n.kind)).toEqual(['question']);
      expect(state.team().personas[0]!.currentRun).toEqual({ ticketId: 'T-1', state: 'running' });
      expect(state.chat().sessions.map((s) => s.file)).toEqual([FILE_A]);
      expect(state.readOnly()).toBe(false);
    });
    // The raw desk answers pass through for tabs that map their own views
    // (they survive the client's JSON re-parse, so compare by value).
    expect(state.board()).toEqual(data.board);
    expect(state.personas()).toEqual(data.personas);
    expect(desk.callsOf('GET', '/api/me').length).toBe(1);
  });

  it('waits on needs-code without a token or a code', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    await state.boot();
    expect(state.pairing()).toBe('needs-code');
    expect(desk.callsOf('POST', '/api/pair').length).toBe(0);
    expect(desk.callsOf('GET', '/api/events').length).toBe(0);
  });

  it('boots once: a second code does not re-pair', async () => {
    const { desk } = makeDesk();
    desk.on('POST', '/api/pair', () => ({ ok: true, token: 'fresh-token', device: {} }));
    const state = makeState(desk);
    await state.boot({ pairCode: 'AAAA', token: null });
    await state.boot({ pairCode: 'BBBB', token: null });
    expect(desk.callsOf('POST', '/api/pair').map((c) => c.body)).toEqual([{ code: 'AAAA' }]);
  });

  it('a #token= bearer stores the token directly and skips pairing', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);

    await state.boot({ pairCode: null, token: 'embedded-bearer' });

    expect(desk.storage.getItem('drey.remote.token')).toBe('embedded-bearer');
    expect(state.pairing()).toBe('ready');
    expect(desk.callsOf('POST', '/api/pair').length).toBe(0);
    await waitFor(() => expect(state.connected()).toBe(true));
    expect(desk.callsOf('GET', '/api/events').length).toBe(1);
  });

  it('a #token= bearer wins over a stored token (a re-embedded Drey re-registers)', async () => {
    const { desk } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'old-token');
    const state = makeState(desk);

    await state.boot({ pairCode: null, token: 'fresh-bearer' });

    expect(desk.storage.getItem('drey.remote.token')).toBe('fresh-bearer');
    expect(state.pairing()).toBe('ready');
  });

  it('a pairing failure surfaces the error and stays on needs-code', async () => {
    const { desk } = makeDesk();
    desk.on('POST', '/api/pair', () => ({ __status: 401, __body: { ok: false, error: 'the pairing code is wrong or has expired' } }));
    const state = makeState(desk);
    const reply = await state.pair('0000-0000');
    expect(reply).toEqual({ ok: false, error: 'the pairing code is wrong or has expired' });
    expect(state.pairing()).toBe('needs-code');
    expect(desk.storage.getItem('drey.remote.token')).toBeNull();
  });

  it('a 401 on the stream drops the token and returns to needs-code', async () => {
    const { desk } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'dead-token');
    const state = makeState(desk);
    await state.boot();
    await waitFor(() => expect(state.connected()).toBe(true));

    vi.useFakeTimers();
    desk.endEvents();
    desk.eventsStatus = 401;
    await vi.advanceTimersByTimeAsync(1000);

    expect(state.pairing()).toBe('needs-code');
    expect(state.connected()).toBe(false);
    expect(desk.storage.getItem('drey.remote.token')).toBeNull();
  });
});

describe('event-driven refreshes', () => {
  it('a board frame re-fetches the Work slice', async () => {
    const { desk, data } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'tok');
    const state = makeState(desk);
    await state.boot();
    await waitFor(() => expect(state.connected()).toBe(true));
    const before = desk.callsOf('GET', '/api/board').length;

    data.board = { columns: [{ phase: { id: 'plan', title: 'Plan' }, tickets: [{ id: 'T-9', title: 'Nine', phase: 'plan', blocked: [], meta: { priority: 'low' } }] }], checkpoints: [] };
    desk.pushEvent('board', {});

    await waitFor(() => expect(state.work().groups[0]!.id).toBe('plan'));
    expect(desk.callsOf('GET', '/api/board').length).toBeGreaterThan(before);
  });

  it('a fleet frame re-folds the Team runs', async () => {
    const { desk, data } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'tok');
    data.personas = [{ id: 'pia', title: 'Pia', role: 'Planner', worker: 'opencode', model: 'zai/glm-5.3', pool: [], color: '#ff0000' }];
    const state = makeState(desk);
    await state.boot();
    await waitFor(() => expect(state.team().personas.length).toBe(1));
    await waitFor(() => expect(desk.eventsOpen).toBe(true));
    expect(state.team().personas[0]!.currentRun).toBeNull();

    data.fleet = { runs: [{ id: 'r1', ticketId: 'T-5', state: 'running', persona: 'pia' }], chain: null };
    desk.pushEvent('fleet', {});

    await waitFor(() => expect(state.team().personas[0]!.currentRun).toEqual({ ticketId: 'T-5', state: 'running' }));
  });

  it('a chat frame for another session refreshes the list but leaves the pane alone', async () => {
    const { desk, data } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'tok');
    data.sessions = [{ file: FILE_B, title: 'B', createdAt: '', updatedAt: '', pending: 1 }];
    data.sessionA = { file: FILE_A, title: 'A', createdAt: '', messages: [{ role: 'owner', text: 'hello A', at: 't1', thought: null }], proposals: [] };
    const state = makeState(desk);
    await state.boot();
    await state.openSession(FILE_A);
    expect(state.chat().active?.file).toBe(FILE_A);
    await waitFor(() => expect(desk.eventsOpen).toBe(true));
    const before = desk.callsOf('GET', '/api/chat/sessions').length;

    desk.pushEvent('chat', { file: FILE_B, event: { kind: 'text', text: 'for B' } });

    await waitFor(() => expect(desk.callsOf('GET', '/api/chat/sessions').length).toBeGreaterThan(before));
    expect(state.chat().active?.messages.map((m) => m.text)).toEqual(['hello A']);
  });
});

describe('chat', () => {
  it('opens a session', async () => {
    const { desk, data } = makeDesk();
    data.sessionA = { file: FILE_A, title: 'A', createdAt: '2026-11-01', messages: [{ role: 'owner', text: 'hi', at: 't1', thought: null }], proposals: [] };
    const state = makeState(desk);
    await state.openSession(FILE_A);
    expect(desk.callsOf('GET', `/api/chat/sessions/${enc(FILE_A)}`).length).toBe(1);
    expect(state.chat().active).toEqual({
      file: FILE_A,
      title: 'A',
      createdAt: '2026-11-01',
      messages: [{ role: 'owner', text: 'hi', thought: null, at: 't1' }],
      proposals: [],
    });
  });

  it('applies streamed text and thought to the open session, then re-fetches on done', async () => {
    const { desk, data } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'tok');
    data.sessionA = { file: FILE_A, title: 'A', createdAt: '', messages: [{ role: 'owner', text: 'hi', at: 't1', thought: null }], proposals: [] };
    const state = makeState(desk);
    await state.boot();
    await state.openSession(FILE_A);
    await waitFor(() => expect(desk.eventsOpen).toBe(true));

    desk.pushEvent('chat', { file: FILE_A, event: { kind: 'text', text: 'Hel' } });
    desk.pushEvent('chat', { file: FILE_A, event: { kind: 'text', text: 'lo' } });
    await waitFor(() => {
      const last = state.chat().active!.messages.at(-1)!;
      expect(last).toMatchObject({ role: 'mission', text: 'Hello' });
    });

    desk.pushEvent('chat', { file: FILE_A, event: { kind: 'thought', text: 'thinking…' } });
    await waitFor(() => expect(state.chat().active!.messages.at(-1)!.thought).toBe('thinking…'));

    // The desk persists the finished turn; `done` re-fetches the canonical session.
    data.sessionA = {
      file: FILE_A,
      title: 'A',
      createdAt: '',
      messages: [
        { role: 'owner', text: 'hi', at: 't1', thought: null },
        { role: 'mission', text: 'Hello', at: 't2', thought: null },
      ],
      proposals: [],
    };
    desk.pushEvent('chat', { file: FILE_A, event: { kind: 'done' } });
    await waitFor(() => {
      expect(state.chat().active!.messages).toHaveLength(2);
      // The canonical re-fetch drops the streamed thought — that marks the fresh session.
      expect(state.chat().active!.messages[1]!.thought).toBeNull();
    });
    expect(state.chat().active!.messages[1]).toMatchObject({ text: 'Hello', thought: null });
  });

  it('send echoes the owner and applies the reply with its proposal cards', async () => {
    const { desk, data } = makeDesk();
    data.sessionA = { file: FILE_A, title: 'A', createdAt: '', messages: [], proposals: [] };
    desk.on('POST', `/api/chat/sessions/${enc(FILE_A)}/messages`, () => ({
      ok: true,
      say: 'Hi there',
      thought: 'hmm',
      proposals: [{ id: 'p-1', state: 'pending', summary: 'Create T-9', at: 't3', decidedAt: null, outcome: null }],
    }));
    const state = makeState(desk);
    await state.openSession(FILE_A);

    const reply = await state.send('hi');

    expect(reply).toEqual({ ok: true });
    const active = state.chat().active!;
    expect(active.messages.map((m) => [m.role, m.text])).toEqual([
      ['owner', 'hi'],
      ['mission', 'Hi there'],
    ]);
    expect(active.messages[1]!.thought).toBe('hmm');
    expect(active.proposals).toEqual([
      { id: 'p-1', state: 'pending', summary: 'Create T-9', at: 't3', decidedAt: null, outcome: null },
    ]);
    const call = desk.callsOf('POST', `/api/chat/sessions/${enc(FILE_A)}/messages`)[0]!;
    expect(call.body).toEqual({ text: 'hi' });
  });

  it('send needs an open session', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    const reply = await state.send('hi');
    expect(reply).toEqual({ ok: false, error: 'no chat session is open' });
  });

  it('send surfaces a desk refusal', async () => {
    const { desk, data } = makeDesk();
    data.sessionA = { file: FILE_A, title: 'A', createdAt: '', messages: [], proposals: [] };
    desk.on('POST', `/api/chat/sessions/${enc(FILE_A)}/messages`, () => ({ ok: false, error: 'a chat message needs text' }));
    const state = makeState(desk);
    await state.openSession(FILE_A);
    const reply = await state.send('   ');
    expect(reply).toEqual({ ok: false, error: 'a chat message needs text' });
  });

  it('newSession starts, lists and opens the session with the finished turn', async () => {
    const { desk } = makeDesk();
    const FILE_NEW = 'tickets/_meta/chat/new.md';
    desk.on('POST', '/api/chat/sessions', () => ({ ok: true, file: FILE_NEW, say: 'Started', thought: null, proposals: [] }));
    desk.on('GET', `/api/chat/sessions/${enc(FILE_NEW)}`, () => ({
      file: FILE_NEW,
      title: 'New',
      createdAt: '',
      messages: [
        { role: 'owner', text: 'do it', at: 't1', thought: null },
        { role: 'mission', text: 'Started', at: 't2', thought: null },
      ],
      proposals: [],
    }));
    const state = makeState(desk);

    const reply = await state.newSession('do it');

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/chat/sessions')[0]!.body).toEqual({ text: 'do it' });
    const active = state.chat().active!;
    expect(active.file).toBe(FILE_NEW);
    // The fresh GET already holds the turn — the reply must not be appended twice.
    expect(active.messages.filter((m) => m.text === 'Started')).toHaveLength(1);
  });

  it('confirm updates the proposal card with the desk outcome', async () => {
    const { desk, data } = makeDesk();
    data.sessionA = {
      file: FILE_A,
      title: 'A',
      createdAt: '',
      messages: [],
      proposals: [{ id: 'p-1', state: 'pending', summary: 'Create T-9', at: 't3', decidedAt: null, outcome: null }],
    };
    desk.on('POST', `/api/chat/sessions/${enc(FILE_A)}/proposals/p-1/confirm`, () => ({
      ok: true,
      proposal: { id: 'p-1', state: 'confirmed', summary: 'Create T-9', at: 't3', decidedAt: 't4', outcome: 'created tickets/inbox/T-9.md' },
    }));
    const state = makeState(desk);
    await state.openSession(FILE_A);

    const reply = await state.confirm(FILE_A, 'p-1');

    expect(reply).toEqual({ ok: true });
    expect(state.chat().active!.proposals).toEqual([
      { id: 'p-1', state: 'confirmed', summary: 'Create T-9', at: 't3', decidedAt: 't4', outcome: 'created tickets/inbox/T-9.md' },
    ]);
  });

  it('dismiss updates the proposal card without an outcome', async () => {
    const { desk, data } = makeDesk();
    data.sessionA = {
      file: FILE_A,
      title: 'A',
      createdAt: '',
      messages: [],
      proposals: [{ id: 'p-2', state: 'pending', summary: 'Move T-1', at: 't3', decidedAt: null, outcome: null }],
    };
    desk.on('POST', `/api/chat/sessions/${enc(FILE_A)}/proposals/p-2/dismiss`, () => ({
      ok: true,
      proposal: { id: 'p-2', state: 'dismissed', summary: 'Move T-1', at: 't3', decidedAt: 't4', outcome: null },
    }));
    const state = makeState(desk);
    await state.openSession(FILE_A);

    const reply = await state.dismiss(FILE_A, 'p-2');

    expect(reply).toEqual({ ok: true });
    expect(state.chat().active!.proposals[0]).toEqual({
      id: 'p-2',
      state: 'dismissed',
      summary: 'Move T-1',
      at: 't3',
      decidedAt: 't4',
      outcome: null,
    });
  });

  it('a refused decision surfaces the error and keeps the card pending', async () => {
    const { desk, data } = makeDesk();
    data.sessionA = {
      file: FILE_A,
      title: 'A',
      createdAt: '',
      messages: [],
      proposals: [{ id: 'p-1', state: 'pending', summary: 'Create T-9', at: 't3', decidedAt: null, outcome: null }],
    };
    desk.on('POST', `/api/chat/sessions/${enc(FILE_A)}/proposals/p-1/confirm`, () => ({ ok: false, error: 'no such proposal' }));
    const state = makeState(desk);
    await state.openSession(FILE_A);

    const reply = await state.confirm(FILE_A, 'p-1');

    expect(reply).toEqual({ ok: false, error: 'no such proposal' });
    expect(state.chat().active!.proposals[0]!.state).toBe('pending');
  });
});

describe('prefillChat (E8, E9)', () => {
  it('fills the one-shot prefill and switches to the chat tab', () => {
    const { desk } = makeDesk();
    const state = makeState(desk);

    state.prefillChat('promote T-0004');

    expect(state.chatPrefill()).toBe('promote T-0004');
    expect(state.tab()).toBe('chat');
  });

  it('closes an open ticket overlay — the prefill would sit under it (E9)', () => {
    const { desk } = makeDesk();
    desk.storage.setItem('drey.remote.token', 'tok');
    const state = makeState(desk);

    state.openTicket('T-1');
    expect(state.ticketOpen()).toEqual({ id: 'T-1' });

    state.prefillChat('Return T-0002 to the standard flow');

    expect(state.ticketOpen()).toBeNull();
    expect(state.chatPrefill()).toBe('Return T-0002 to the standard flow');
    expect(state.tab()).toBe('chat');
  });

  it('trims the text and refuses an empty prefill', () => {
    const { desk } = makeDesk();
    const state = makeState(desk);

    state.prefillChat('  ');
    expect(state.chatPrefill()).toBeNull();
    expect(state.tab()).toBe('work');

    state.prefillChat('  promote T-0004  ');
    expect(state.chatPrefill()).toBe('promote T-0004');
  });
});

describe('moveTicket', () => {
  it('posts the transition with the card phase from the current view', async () => {
    const { desk, data } = makeDesk();
    data.board = { columns: [{ phase: { id: 'inbox', title: 'Inbox' }, tickets: [{ id: 'T-1', title: 'One', phase: 'inbox', blocked: [], meta: { priority: 'high' } }] }], checkpoints: [] };
    desk.on('POST', '/api/tickets/T-1/move', () => ({ ok: true }));
    desk.storage.setItem('drey.remote.token', 'tok');
    const state = makeState(desk);
    await state.boot();
    await waitFor(() => expect(state.work().groups[0]!.cards.length).toBe(1));

    const reply = await state.moveTicket('T-1', 'plan');

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/tickets/T-1/move')[0]!.body).toEqual({ id: 'T-1', from: 'inbox', to: 'plan' });
  });

  it('surfaces a board refusal', async () => {
    const { desk, data } = makeDesk();
    data.board = { columns: [{ phase: { id: 'inbox', title: 'Inbox' }, tickets: [{ id: 'T-1', title: 'One', phase: 'inbox', blocked: [], meta: {} }] }], checkpoints: [] };
    desk.on('POST', '/api/tickets/T-1/move', () => ({ ok: false, error: 'the target phase is unknown' }));
    desk.storage.setItem('drey.remote.token', 'tok');
    const state = makeState(desk);
    await state.boot();
    await waitFor(() => expect(state.work().groups[0]!.cards.length).toBe(1));

    const reply = await state.moveTicket('T-1', 'nowhere');

    expect(reply).toEqual({ ok: false, error: 'the target phase is unknown' });
  });

  it('fails fast for a ticket it has not seen, without posting', async () => {
    const { desk, data } = makeDesk();
    data.board = { columns: [{ phase: { id: 'inbox', title: 'Inbox' }, tickets: [] }], checkpoints: [] };
    desk.storage.setItem('drey.remote.token', 'tok');
    const state = makeState(desk);
    await state.boot();
    await waitFor(() => expect(state.connected()).toBe(true));

    const reply = await state.moveTicket('T-9', 'plan');

    expect(reply).toEqual({ ok: false, error: 'ticket T-9 is not on the board' });
    expect(desk.callsOf('POST', '/api/tickets/T-9/move').length).toBe(0);
  });
});

describe('ticket screen', () => {
  const TWO_PHASES = {
    columns: [
      { phase: { id: 'inbox', title: 'Inbox' }, tickets: [] },
      { phase: { id: 'verify', title: 'Verify' }, tickets: [{ id: 'T-1', title: 'One', phase: 'verify', blocked: [], meta: {} }] },
    ],
    checkpoints: [] as string[],
  };
  const TICKET_WITH_PROOF = [
    '---',
    'id: T-1',
    '---',
    '',
    '# One',
    '',
    '## Verification',
    '',
    'Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.',
    '',
    '### Criteria',
    '',
    '- [x] `npm test` → ![](../attachments/verify-01.png)',
    '',
    '## Log',
    '',
    '- entry',
    '',
  ].join('\n');

  it('openTicket loads the detail, the phases from the board view and the parsed proof', async () => {
    const { desk, data } = makeDesk();
    data.board = TWO_PHASES;
    data.ticket = {
      ok: true,
      card: { id: 'T-1', title: 'One', phase: 'verify', meta: {} },
      text: TICKET_WITH_PROOF,
      revision: 'r1',
    };
    desk.storage.setItem('drey.remote.token', 'tok');
    const state = makeState(desk);
    await state.boot();
    await waitFor(() => expect(state.work().groups.length).toBe(2));

    state.openTicket('T-1');

    expect(state.ticketOpen()).toEqual({ id: 'T-1' });
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());
    const detail = state.ticketDetail()!;
    expect(detail.id).toBe('T-1');
    expect(detail.title).toBe('One');
    expect(detail.revision).toBe('r1');
    expect(detail.text).toContain('# One');
    expect(detail.phases).toEqual([
      { id: 'inbox', title: 'Inbox' },
      { id: 'verify', title: 'Verify' },
    ]);
    expect(detail.phase).toBe('verify');
    expect(detail.verification).toEqual({
      testedAt: '2026-11-01T14:32:00Z',
      tester: 'verify@engine',
      environment: 'Electron 34.2.0 on win32',
      criteria: [{ command: 'npm test', passed: true, screenshot: 'verify-01.png', note: null }],
      findings: [],
    });
    expect(state.ticketError()).toBeNull();
    expect(desk.callsOf('GET', '/api/tickets/T-1').length).toBe(1);
  });

  it('a missing ticket lands on ticketError with the desk wording', async () => {
    const { desk, data } = makeDesk();
    data.ticket = { __status: 404, __body: { ok: false, error: 'no such ticket' } };
    const state = makeState(desk);

    state.openTicket('T-1');

    await waitFor(() => expect(state.ticketError()).toBe('no such ticket'));
    expect(state.ticketDetail()).toBeNull();
  });

  it('saveTicket posts the text with the loaded base revision and refreshes the detail', async () => {
    const { desk, data } = makeDesk();
    const state = makeState(desk);
    state.openTicket('T-1');
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());
    desk.on('POST', '/api/tickets/T-1/save', (body) => {
      data.ticket = { ...(data.ticket as Record<string, unknown>), revision: 'r2' };
      expect(body).toEqual({ text: 'edited markdown', baseRevision: 'r1' });
      return { ok: true, revision: 'r2' };
    });

    const reply = await state.saveTicket('edited markdown');

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/tickets/T-1/save').length).toBe(1);
    // The success re-loads the ticket: the desk's new revision is the next base.
    expect(state.ticketDetail()!.revision).toBe('r2');
    expect(desk.callsOf('GET', '/api/tickets/T-1').length).toBe(2);
  });

  it('a stale base revision answers with the refine sentence, not the desk wording', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openTicket('T-1');
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());
    desk.on('POST', '/api/tickets/T-1/save', () => ({ ok: false, conflict: true, error: 'base revision r0 is stale' }));

    const reply = await state.saveTicket('edited markdown');

    expect(reply).toEqual({ ok: false, error: 'The ticket changed since you opened it. Reload it and edit again.' });
    expect(state.ticketDetail()!.revision).toBe('r1');
  });

  it('a desk refusal surfaces the error and keeps the loaded detail', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openTicket('T-1');
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());
    desk.on('POST', '/api/tickets/T-1/save', () => ({ ok: false, error: 'the file no longer parses as a ticket' }));

    const reply = await state.saveTicket('broken');

    expect(reply).toEqual({ ok: false, error: 'the file no longer parses as a ticket' });
    expect(state.ticketDetail()!.revision).toBe('r1');
  });

  it('saveTicket refuses before posting when no ticket is open', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);

    const reply = await state.saveTicket('edited markdown');

    expect(reply).toEqual({ ok: false, error: 'no ticket is open' });
    expect(desk.callsOf('POST', '/api/tickets/T-1/save').length).toBe(0);
  });

  it('acceptTicket posts to the accept route and refreshes', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openTicket('T-1');
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());
    desk.on('POST', '/api/tickets/T-1/accept', () => ({ ok: true }));

    const reply = await state.acceptTicket();

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/tickets/T-1/accept').length).toBe(1);
    expect(desk.callsOf('GET', '/api/tickets/T-1').length).toBe(2);
  });

  it('sendBack needs a note, then posts it trimmed', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openTicket('T-1');
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());

    const silent = await state.sendBack('   ');
    expect(silent).toEqual({ ok: false, error: 'a send-back needs a note' });
    expect(desk.callsOf('POST', '/api/tickets/T-1/send-back').length).toBe(0);

    desk.on('POST', '/api/tickets/T-1/send-back', () => ({ ok: true }));
    const reply = await state.sendBack('  The button still misaligns  ');
    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/tickets/T-1/send-back')[0]!.body).toEqual({ note: 'The button still misaligns' });
  });

  it('loadDiff loads the proof card diff and keeps the last good view on a failed GET', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openTicket('T-1');
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());
    const view = { files: [{ status: 'M', path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], truncated: false };
    desk.on('GET', '/api/tickets/T-1/diff', () => view);

    await state.loadDiff();
    expect(state.diff()).toEqual(view);

    desk.on('GET', '/api/tickets/T-1/diff', () => ({ __status: 500, __body: null }));
    await state.loadDiff();
    expect(state.diff()).toEqual(view);
  });

  it('loadDiff without an open ticket posts nothing', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    await state.loadDiff();
    expect(state.diff()).toBeNull();
    expect(desk.callsOf('GET', '/api/tickets/T-1/diff').length).toBe(0);
  });  it('attachments memoize per name and closeTicket revokes them', async () => {
    const desk = new FakeDesk();
    const created: string[] = [];
    const revoked: string[] = [];
    const client = new McClient({
      fetch: desk.fetch,
      storage: desk.storage,
      createObjectUrl: () => {
        const url = `blob:fake-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revokeObjectUrl: (url) => revoked.push(url),
    });
    const state = new McState(client);
    desk.on('GET', '/api/tickets/T-1', () => ({
      ok: true,
      card: { id: 'T-1', title: 'One', phase: 'inbox', meta: {} },
      text: '# One',
      revision: 'r1',
    }));
    desk.on('GET', '/api/attachments/shot.png', () => ({ __bytes: new Uint8Array([1, 2, 3]), __contentType: 'image/png' }));
    state.openTicket('T-1');
    await waitFor(() => expect(state.ticketDetail()).not.toBeNull());

    expect(state.attachmentUrl('shot.png')).toBeNull();
    expect(await state.ensureAttachment('shot.png')).toBe('blob:fake-1');
    expect(state.attachmentUrl('shot.png')).toBe('blob:fake-1');
    // The memo serves the second ask: one GET for two asks.
    expect(await state.ensureAttachment('shot.png')).toBe('blob:fake-1');
    expect(desk.callsOf('GET', '/api/attachments/shot.png').length).toBe(1);

    state.closeTicket();
    expect(revoked).toEqual(['blob:fake-1']);
    expect(state.attachmentUrl('shot.png')).toBeNull();
    expect(state.ticketOpen()).toBeNull();
    expect(state.ticketDetail()).toBeNull();
    expect(state.diff()).toBeNull();
  });

  it('a failed attachment fetch leaves no URL behind', async () => {
    const desk = new FakeDesk();
    const client = new McClient({
      fetch: desk.fetch,
      storage: desk.storage,
      createObjectUrl: () => 'blob:fake-1',
      revokeObjectUrl: () => undefined,
    });
    const state = new McState(client);
    desk.on('GET', '/api/attachments/missing.png', () => ({ __status: 404, __body: { ok: false, error: 'no such attachment' } }));

    expect(await state.ensureAttachment('missing.png')).toBeNull();
    expect(state.attachmentUrl('missing.png')).toBeNull();
  });
});

describe('fleet answers (req-64)', () => {
  /** Boots the state with the question needs the runs wait on. */
  const makeWaiting = async (needs: unknown) => {
    const { desk } = makeDesk();
    desk.on('GET', '/api/needs', () => needs);
    const state = makeState(desk);
    desk.storage.setItem('drey.remote.token', 'tok');
    await state.boot(null);
    const count = Array.isArray(needs) ? needs.length : 0;
    await waitFor(() => expect(state.needs()).toHaveLength(count));
    return { desk, state };
  };

  it('posts the answers record keyed off the need’s question form', async () => {
    const { desk, state } = await makeWaiting([
      {
        kind: 'question',
        ticketId: 'T-1',
        title: 'One',
        text: 'QUESTION: Which way?',
        runId: 'r-12',
        questions: [{ key: 'q0', header: null, question: 'Which way?', options: [{ label: 'Left' }, { label: 'Right' }], multiple: false }],
      },
    ]);
    desk.on('POST', '/api/runs/r-12/answer', () => ({ ok: true }));

    const reply = await state.answerRun('r-12', '  Right  ');

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/runs/r-12/answer')[0]!.body).toEqual({ answers: { q0: 'Right' } });
  });

  it('refuses an empty answer locally and surfaces the desk’s refusal', async () => {
    const { desk, state } = await makeWaiting([]);
    const silent = await state.answerRun('r-12', '   ');
    expect(silent).toEqual({ ok: false, error: 'the answer is empty' });
    expect(desk.callsOf('POST', '/api/runs/r-12/answer').length).toBe(0);

    desk.on('POST', '/api/runs/r-12/answer', () => ({ ok: false, error: 'the worker took no answer' }));
    expect(await state.answerRun('r-12', 'Left')).toEqual({ ok: false, error: 'the worker took no answer' });
  });

  it("a QUESTION: turn carries no form: the desk's refusal reroutes the wording through the steer route", async () => {
    const { desk, state } = await makeWaiting([
      { kind: 'question', ticketId: 'T-1', title: 'One', text: 'QUESTION: Which way?', runId: 'r-13' },
    ]);
    desk.on('POST', '/api/runs/r-13/answer', () => ({ ok: false, error: 'run r-13 asks no question' }));
    desk.on('POST', '/api/runs/r-13/send', () => ({ ok: true }));

    const reply = await state.answerRun('r-13', '2. Right');

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/runs/r-13/answer').length).toBe(1);
    expect(desk.callsOf('POST', '/api/runs/r-13/send')[0]!.body).toEqual({ text: '2. Right' });
  });
});

describe('persona detail (E6)', () => {
  it('openPersona opens the 1:1 and loads the improvements', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);

    state.openPersona('pia');

    expect(state.personaDetail()).toEqual({ id: 'pia' });
    await waitFor(() => expect(state.improvements()).not.toBeNull());
    const view = state.improvements()!;
    expect(view.persona?.title).toBe('Pia');
    expect(view.proposals.map((p) => p.id)).toEqual(['imp-1']);
    expect(view.openCount).toBe(1);
    expect(view.frictionCount).toBe(4);
    expect(state.improvementsError()).toBeNull();
    expect(desk.callsOf('GET', '/api/personas/pia/improvements').length).toBe(1);
  });

  it('closePersona drops the loaded view', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openPersona('pia');
    await waitFor(() => expect(state.improvements()).not.toBeNull());

    state.closePersona();

    expect(state.personaDetail()).toBeNull();
    expect(state.improvements()).toBeNull();
    expect(state.improvementsError()).toBeNull();
  });

  it('a missing persona lands on improvementsError with the desk wording', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);

    state.openPersona('ghost');

    await waitFor(() => expect(state.improvementsError()).toBe('no route GET /api/personas/ghost/improvements'));
    expect(state.improvements()).toBeNull();
    expect(state.personaDetail()).toEqual({ id: 'ghost' });
  });

  it('a newer openPersona racing the fetch wins — the stale answer is dropped', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);

    state.openPersona('pia');
    state.openPersona('tessa');

    await waitFor(() => expect(state.improvements()?.persona?.id).toBe('tessa'));
    expect(state.personaDetail()).toEqual({ id: 'tessa' });
    // pia's GET fired, but its answer arrived after the detail moved on: dropped.
    expect(desk.callsOf('GET', '/api/personas/pia/improvements').length).toBe(1);
    expect(desk.callsOf('GET', '/api/personas/tessa/improvements').length).toBe(1);
  });

  it('applyImprovement posts to the apply route and re-loads the view', async () => {
    const { desk, data } = makeDesk();
    const state = makeState(desk);
    state.openPersona('pia');
    await waitFor(() => expect(state.improvements()).not.toBeNull());
    desk.on('POST', '/api/personas/pia/improvements/imp-1/apply', () => {
      const before = data.piaImprovements as { proposals: Array<Record<string, unknown>> };
      data.piaImprovements = {
        ...(data.piaImprovements as Record<string, unknown>),
        proposals: [{ ...before.proposals[0]!, state: 'accepted', decidedAt: '2026-11-02T12:00:00Z' }],
        openCount: 0,
      };
      return { ok: true };
    });

    const reply = await state.applyImprovement('pia', 'imp-1');

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/personas/pia/improvements/imp-1/apply').length).toBe(1);
    // The success re-loads the file: the proposal moved into the history.
    await waitFor(() => expect(state.improvements()?.proposals[0]?.state).toBe('accepted'));
    expect(state.improvements()?.proposals[0]?.decidedAt).toBe('2026-11-02T12:00:00Z');
    expect(state.improvements()?.openCount).toBe(0);
  });

  it('a refused apply surfaces the error and does not re-load', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openPersona('pia');
    await waitFor(() => expect(state.improvements()).not.toBeNull());
    const gets = desk.callsOf('GET', '/api/personas/pia/improvements').length;
    desk.on('POST', '/api/personas/pia/improvements/imp-1/apply', () => ({ ok: false, error: 'the proposal is already decided' }));

    const reply = await state.applyImprovement('pia', 'imp-1');

    expect(reply).toEqual({ ok: false, error: 'the proposal is already decided' });
    expect(desk.callsOf('GET', '/api/personas/pia/improvements').length).toBe(gets);
    expect(state.improvements()?.proposals[0]?.state).toBe('open');
  });

  it('dismissImprovement posts to the dismiss route and re-loads', async () => {
    const { desk } = makeDesk();
    const state = makeState(desk);
    state.openPersona('pia');
    await waitFor(() => expect(state.improvements()).not.toBeNull());
    desk.on('POST', '/api/personas/pia/improvements/imp-1/dismiss', () => ({ ok: true }));

    const reply = await state.dismissImprovement('pia', 'imp-1');

    expect(reply).toEqual({ ok: true });
    expect(desk.callsOf('POST', '/api/personas/pia/improvements/imp-1/dismiss').length).toBe(1);
    await waitFor(() => expect(desk.callsOf('GET', '/api/personas/pia/improvements').length).toBe(2));
  });
});

describe('toast', () => {
  it('shows the message with the given kind', () => {
    vi.useFakeTimers();
    const state = makeState(makeDesk().desk);
    state.toast('Theme: Cyberpunk', 'ok');
    expect(state.toastMessage()).toEqual({ message: 'Theme: Cyberpunk', kind: 'ok' });
  });

  it('defaults the kind to ok', () => {
    vi.useFakeTimers();
    const state = makeState(makeDesk().desk);
    state.toast('plain');
    expect(state.toastMessage()?.kind).toBe('ok');
  });

  it('hides itself after 2.2 s', () => {
    vi.useFakeTimers();
    const state = makeState(makeDesk().desk);
    state.toast('Saved');
    expect(state.toastMessage()).not.toBeNull();
    vi.advanceTimersByTime(2199);
    expect(state.toastMessage()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(state.toastMessage()).toBeNull();
  });

  it('a newer toast replaces the running one and restarts the hide timer', () => {
    vi.useFakeTimers();
    const state = makeState(makeDesk().desk);
    state.toast('first', 'ok');
    vi.advanceTimersByTime(1000);
    state.toast('second', 'warn');
    vi.advanceTimersByTime(2100); // 3100 ms after the first — only 2.1 s after the second
    expect(state.toastMessage()).toEqual({ message: 'second', kind: 'warn' });
    vi.advanceTimersByTime(100);
    expect(state.toastMessage()).toBeNull();
  });
});
