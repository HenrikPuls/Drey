/**
 * Mission Control's signal store (E5b): the one owner of the connection
 * (`McClient` + the `/api/events` listen lifecycle) and of every view
 * the tabs render. Pure signals — no DOM here; the only DOM touch in
 * the whole layer lives behind `typeof document` guards in the client.
 *
 * Event-driven refreshes: a `board`/`needs` frame re-fetches the Work
 * slice, a `fleet`/`remote` frame re-folds the Team runs, and a `chat`
 * frame applies its stream delta to the open session (the `done` delta
 * re-fetches the session, which canonicalises proposals and thought).
 * Every reconnect re-fetches everything — the catch-up the missed frames
 * owe us.
 */
import { signal } from '@angular/core';
import { ApiError, McClient, type McEventHandlers } from './client';
import {
  parseActiveSession,
  parseChatEvent,
  parseNeeds,
  parseProposal,
  parseSessions,
  parseTeam,
  parseWork,
  type ChatProposalView,
  type ChatStateView,
  type ChatStreamView,
  type NeedView,
  type TeamView,
  type WorkView,
} from './dto';

export type PairingPhase = 'needs-code' | 'pairing' | 'ready';

/** What every mutation hands back so the UI can surface a failure. */
export type McReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

const fail = (error: unknown): McReply => ({
  ok: false,
  error: error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'The desk does not answer.',
});

/** A caught request error (an McReply) versus a 200 body the desk may still have refused. */
const isFailure = (value: unknown): value is McReply =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

const refusal = (body: unknown, fallback: string): McReply => {
  const error = (typeof body === 'object' && body !== null ? (body as { error?: unknown }) : {})['error'];
  return { ok: false, error: typeof error === 'string' && error !== '' ? error : fallback };
};

/** The in-flight mission reply the SSE `text`/`thought` deltas accumulate into. */
interface StreamTail {
  readonly file: string;
}

export class McState {
  readonly connected = signal(false);
  readonly pairing = signal<PairingPhase>('needs-code');
  readonly work = signal<WorkView>({ groups: [] });
  readonly needs = signal<readonly NeedView[]>([]);
  readonly team = signal<TeamView>({ personas: [] });
  readonly chat = signal<ChatStateView>({ sessions: [], active: null });
  /**
   * The raw desk answers, for tabs that map their own views from the wire
   * JSON (the Work tab's shapes carry fields the card view drops: the
   * ticket path and blurb, the phase colours, the checkpoints).
   */
  readonly board = signal<unknown>(null);
  readonly personas = signal<readonly unknown[]>([]);
  /** The paired device's read-only flag (`GET /api/me`): it watches, never mutates. */
  readonly readOnly = signal(false);

  private stopListen: (() => void) | null = null;
  private booted = false;
  private tail: StreamTail | null = null;

  constructor(private readonly client: McClient = new McClient()) {}

  /**
   * Boots the connection: a stored token goes straight to ready; else a
   * pairing code (from the URL the desk shows) is exchanged; else the
   * app waits on the pairing screen. Idempotent.
   */
  async boot(pairCodeFromUrl?: string | null): Promise<void> {
    if (this.booted) {
      return;
    }
    this.booted = true;
    if (this.client.token() !== null) {
      this.enterReady();
      return;
    }
    const code = (pairCodeFromUrl ?? '').trim();
    if (code !== '') {
      await this.pair(code);
      return;
    }
    this.pairing.set('needs-code');
  }

  /** Exchanges a pairing code; on success starts listening and refreshing. */
  async pair(code: string): Promise<McReply> {
    this.pairing.set('pairing');
    const reply = await this.client.pair(code);
    if (!reply.ok) {
      this.pairing.set('needs-code');
      return { ok: false, error: reply.error };
    }
    this.enterReady();
    return { ok: true };
  }

  private enterReady(): void {
    this.pairing.set('ready');
    this.startListening();
    void this.refreshMe();
    void this.refreshAll();
  }

  /** The paired device's profile: the Work tab hides the move for read-only devices. */
  private async refreshMe(): Promise<void> {
    const me = await this.client
      .request<{ ok?: unknown; device?: unknown }>('GET', '/api/me')
      .catch(() => null);
    const device = typeof me?.device === 'object' && me.device !== null ? (me.device as { readOnly?: unknown }) : null;
    this.readOnly.set(device?.readOnly === true);
  }

  private startListening(): void {
    this.stopListen?.();
    const handlers: McEventHandlers = {
      onState: (connected) => {
        this.connected.set(connected);
        if (connected) {
          // Catch-up: whatever the missed frames owe us.
          void this.refreshAll();
        }
      },
      onUnauthorized: () => this.unpair(),
      onEvent: (frame) => this.onFrame(frame.name, frame.data),
    };
    this.stopListen = this.client.listen(handlers);
  }

  /** The desk rejected the token: drop it and return to the pairing screen. */
  private unpair(): void {
    this.stopListen?.();
    this.stopListen = null;
    this.client.clearToken();
    this.connected.set(false);
    this.pairing.set('needs-code');
  }

  private onFrame(name: string, data: string): void {
    const event = parseChatEvent(name, data);
    switch (event.kind) {
      case 'board':
      case 'needs':
        void this.refreshWork();
        break;
      case 'fleet':
      case 'remote':
        void this.refreshTeam();
        break;
      case 'chat':
        this.applyChatStream(event.file, event.event);
        break;
      default:
        break;
    }
  }

  // --- reads (best-effort: a failed GET keeps the last good view) ----------

  private async refreshAll(): Promise<void> {
    await Promise.all([this.refreshWork(), this.refreshTeam(), this.refreshSessions()]);
    const active = this.chat().active;
    // A live stream re-fetches the session itself on `done`; re-opening it
    // here would clobber the in-flight reply with the not-yet-persisted file.
    if (active !== null && this.tail === null) {
      await this.openSession(active.file);
    }
  }

  private async refreshWork(): Promise<void> {
    const [board, needs] = await Promise.all([
      this.client.request('GET', '/api/board').catch(() => null),
      this.client.request('GET', '/api/needs').then(parseNeeds).catch(() => null),
    ]);
    if (board !== null) {
      this.board.set(board);
      this.work.set(parseWork(board));
    }
    if (needs !== null) {
      this.needs.set(needs);
    }
  }

  private async refreshTeam(): Promise<void> {
    const [personas, fleet] = await Promise.all([
      this.client.request('GET', '/api/personas').catch(() => null),
      this.client.request('GET', '/api/fleet').catch(() => null),
    ]);
    if (personas !== null) {
      this.personas.set(Array.isArray(personas) ? personas : []);
    }
    this.team.set(parseTeam(personas, fleet));
  }

  private async refreshSessions(): Promise<void> {
    const sessions = await this.client.request('GET', '/api/chat/sessions').then(parseSessions).catch(() => null);
    if (sessions !== null) {
      this.chat.update((chat) => ({ ...chat, sessions }));
    }
  }

  /**
   * Opens one session; a missing file keeps the list and clears the pane.
   * When a stream tail for this session raced the fetch, the in-flight
   * reply is newer than the persisted file — the pane keeps it (the
   * stream's `done` re-fetches the canonical session).
   */
  async openSession(file: string): Promise<void> {
    const session = await this.client
      .request('GET', `/api/chat/sessions/${encodeURIComponent(file)}`)
      .then(parseActiveSession)
      .catch(() => null);
    if (session !== null && this.tail !== null && this.chat().active?.file === file) {
      return;
    }
    this.tail = null;
    this.chat.update((chat) => ({ ...chat, active: session }));
  }

  // --- chat mutations -------------------------------------------------------

  /** Starts a session with the first owner message and opens it. */
  async newSession(text: string): Promise<McReply> {
    const body = await this.client.request<Record<string, unknown>>('POST', '/api/chat/sessions', { text }).catch(fail);
    if (isFailure(body)) {
      return body;
    }
    const file = typeof body['file'] === 'string' ? body['file'] : '';
    if (body['ok'] !== true || file === '') {
      return refusal(body, 'the desk started no session');
    }
    await this.refreshSessions();
    // The start ran the whole turn server-side, so the fresh session the
    // GET returns already holds the owner message, the reply and any cards.
    await this.openSession(file);
    return { ok: true };
  }

  /** Sends one owner message to the open session (echoed at once). */
  async send(text: string): Promise<McReply> {
    const file = this.chat().active?.file ?? null;
    if (file === null) {
      return { ok: false, error: 'no chat session is open' };
    }
    this.appendMessage({ role: 'owner', text, thought: null, at: new Date().toISOString() });
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/chat/sessions/${encodeURIComponent(file)}/messages`, { text })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not take the message');
    }
    this.applyTurn(body);
    return { ok: true };
  }

  /** Confirms a proposal card — the desk executes the command it wraps. */
  confirm(file: string, id: string): Promise<McReply> {
    return this.decide(file, id, 'confirm');
  }

  /** Dismisses a proposal card — the desk records the refusal, nothing runs. */
  dismiss(file: string, id: string): Promise<McReply> {
    return this.decide(file, id, 'dismiss');
  }

  private async decide(file: string, id: string, which: 'confirm' | 'dismiss'): Promise<McReply> {
    const path = `/api/chat/sessions/${encodeURIComponent(file)}/proposals/${encodeURIComponent(id)}/${which}`;
    const body = await this.client.request<Record<string, unknown>>('POST', path).catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, `the desk could not ${which} the proposal`);
    }
    const proposal = parseProposal(body['proposal']);
    if (proposal !== null && this.chat().active?.file === file) {
      this.upsertProposal(proposal);
    }
    return { ok: true };
  }

  // --- board mutations ------------------------------------------------------

  /**
   * Moves a ticket to another phase. `from` is the card's phase in the
   * current view (the desk's transition command asks for it); the board
   * SSE frame then re-fetches the Work slice.
   */
  async moveTicket(id: string, to: string): Promise<McReply> {
    const from = this.phaseOf(id);
    if (from === null) {
      return { ok: false, error: `ticket ${id} is not on the board` };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/tickets/${encodeURIComponent(id)}/move`, { id, from, to })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, `the board refused the move to ${to}`);
    }
    return { ok: true };
  }

  private phaseOf(id: string): string | null {
    for (const group of this.work().groups) {
      for (const card of group.cards) {
        if (card.id === id) {
          return card.phase;
        }
      }
    }
    return null;
  }

  // --- the chat stream ------------------------------------------------------

  private applyChatStream(file: string, event: ChatStreamView): void {
    const active = this.chat().active;
    if (active === null || active.file !== file) {
      // Another session streams: its list row's pending count may change.
      void this.refreshSessions();
      return;
    }
    switch (event.kind) {
      case 'thought':
        this.extendStream(file, { text: '', thought: event.text });
        break;
      case 'text':
        this.extendStream(file, { text: event.text, thought: null });
        break;
      case 'proposal':
        this.upsertProposal(event.proposal);
        break;
      case 'done':
        this.tail = null;
        void this.openSession(file);
        void this.refreshSessions();
        break;
      case 'error':
        this.extendStream(file, { text: event.message, thought: null });
        break;
    }
  }

  /** Appends a delta to the in-flight mission reply, starting it when needed. */
  private extendStream(file: string, delta: { text: string; thought: string | null }): void {
    const active = this.chat().active;
    if (active === null) {
      return;
    }
    const tail = this.tail;
    if (tail !== null && tail.file === file && active.messages.length > 0) {
      const last = active.messages[active.messages.length - 1]!;
      const grown = {
        ...last,
        text: last.text + delta.text,
        thought: delta.thought === null ? last.thought : (last.thought ?? '') + delta.thought,
      };
      this.chat.update((current) => {
        const open = current.active;
        return open === null
          ? current
          : { ...current, active: { ...open, messages: [...open.messages.slice(0, -1), grown] } };
      });
      return;
    }
    this.tail = { file };
    this.appendMessage({ role: 'mission', text: delta.text, thought: delta.thought, at: new Date().toISOString() });
  }

  private appendMessage(message: { role: 'owner' | 'mission'; text: string; thought: string | null; at: string }): void {
    this.chat.update((chat) => {
      const active = chat.active;
      return active === null ? chat : { ...chat, active: { ...active, messages: [...active.messages, message] } };
    });
  }

  /** Folds a finished turn's reply into the open session. */
  private applyTurn(body: Record<string, unknown>): void {
    const say = typeof body['say'] === 'string' ? body['say'] : '';
    const thought = typeof body['thought'] === 'string' ? body['thought'] : null;
    const proposals = Array.isArray(body['proposals']) ? body['proposals'] : [];
    if (say !== '' || thought !== null) {
      const tail = this.tail;
      if (tail !== null && this.chat().active?.file === tail.file) {
        // The streamed tail holds this turn's deltas — replace it with the canonical reply.
        this.chat.update((chat) => {
          const active = chat.active;
          if (active === null || active.messages.length === 0) {
            return chat;
          }
          const last = active.messages[active.messages.length - 1]!;
          const grown = { ...last, text: say === '' ? last.text : say, thought: thought ?? last.thought };
          return { ...chat, active: { ...active, messages: [...active.messages.slice(0, -1), grown] } };
        });
      } else if (say !== '') {
        this.appendMessage({ role: 'mission', text: say, thought, at: new Date().toISOString() });
      }
      this.tail = null;
    }
    for (const raw of proposals) {
      const proposal = parseProposal(raw);
      if (proposal !== null) {
        this.upsertProposal(proposal);
      }
    }
  }

  private upsertProposal(proposal: ChatProposalView): void {
    this.chat.update((chat) => {
      const active = chat.active;
      if (active === null) {
        return chat;
      }
      const rest = active.proposals.filter((existing) => existing.id !== proposal.id);
      return { ...chat, active: { ...active, proposals: [...rest, proposal] } };
    });
  }
}
