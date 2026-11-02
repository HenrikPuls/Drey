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
  } = {
    board: { columns: [{ phase: { id: 'inbox', title: 'Inbox' }, tickets: [] }], checkpoints: [] as string[] },
    needs: [] as unknown[],
    personas: [] as unknown[],
    fleet: { runs: [] as unknown[], chain: null },
    sessions: [] as unknown[],
    sessionA: { file: FILE_A, title: 'A', createdAt: '2026-11-01', messages: [] as unknown[], proposals: [] as unknown[] },
  };
  desk.on('GET', '/api/me', () => ({ ok: true, device: { name: 'phone', readOnly: false } }));
  desk.on('GET', '/api/board', () => data.board);
  desk.on('GET', '/api/needs', () => data.needs);
  desk.on('GET', '/api/personas', () => data.personas);
  desk.on('GET', '/api/fleet', () => data.fleet);
  desk.on('GET', '/api/chat/sessions', () => data.sessions);
  desk.on('GET', `/api/chat/sessions/${enc(FILE_A)}`, () => data.sessionA);
  return { desk, data };
};

const makeState = (desk: FakeDesk): McState => new McState(new McClient({ fetch: desk.fetch, storage: desk.storage }));

describe('boot', () => {
  it('pairs a code from the URL, stores the token and becomes ready', async () => {
    const { desk, data } = makeDesk();
    data.board = { columns: [{ phase: { id: 'inbox', title: 'Inbox' }, tickets: [{ id: 'T-1', title: 'One', phase: 'inbox', blocked: [], meta: { priority: 'high' } }] }], checkpoints: [] };
    desk.on('POST', '/api/pair', () => ({ ok: true, token: 'fresh-token', device: { name: 'phone' } }));
    const state = makeState(desk);

    await state.boot('  1234-5678  ');

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
    await state.boot('AAAA');
    await state.boot('BBBB');
    expect(desk.callsOf('POST', '/api/pair').map((c) => c.body)).toEqual([{ code: 'AAAA' }]);
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
