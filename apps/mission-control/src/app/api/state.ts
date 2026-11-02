/**
 * Mission Control's signal store (E5b, extended E5c with the ticket
 * screen's slice): the one owner of the connection (`McClient` + the
 * `/api/events` listen lifecycle) and of every view the tabs render.
 * Pure signals — no DOM here; the only DOM touches in the whole layer
 * live behind `typeof document`/`typeof location` guards in the client.
 *
 * Event-driven refreshes: a `board`/`needs` frame re-fetches the Work
 * slice, a `fleet`/`remote` frame re-folds the Team runs, and a `chat`
 * frame applies its stream delta to the open session (the `done` delta
 * re-fetches the session, which canonicalises proposals and thought).
 * Every reconnect re-fetches everything — the catch-up the missed frames
 * owe us.
 */
import { signal } from '@angular/core';
import { ApiError, McClient, type McBootHints, type McEventHandlers } from './client';
import {
  parseActiveSession,
  parseChatEvent,
  parseNeeds,
  parseProposal,
  parseSessions,
  parseTeam,
  parseTicketDetail,
  parseTicketDiff,
  parseWork,
  type ChatProposalView,
  type ChatStateView,
  type ChatStreamView,
  type NeedView,
  type TeamView,
  type TicketDetail,
  type TicketDiffView,
  type TicketPhaseOption,
  type WorkView,
} from './dto';

export type PairingPhase = 'needs-code' | 'pairing' | 'ready';

/** What every mutation hands back so the UI can surface a failure. */
export type McReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

const fail = (error: unknown): { readonly ok: false; readonly error: string } => ({
  ok: false,
  error: error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'The desk does not answer.',
});

/** A caught request error (an McReply) versus a 200 body the desk may still have refused. */
const isFailure = (value: unknown): value is { readonly ok: false; readonly error: string } =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

/** The `{ok:false, error}` the desk's refusal (or the fallback) becomes — always the false variant. */
const refusal = (body: unknown, fallback: string): { readonly ok: false; readonly error: string } => {
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

  // --- the ticket screen's slice (E5c) --------------------------------------
  /** The ticket the screen shows; null = the board, not one ticket. */
  readonly ticketOpen = signal<{ id: string } | null>(null);
  /** The loaded ticket; null while the first fetch runs or it failed. */
  readonly ticketDetail = signal<TicketDetail | null>(null);
  /** The last load/save failure the ticket screen surfaces; null when all is well. */
  readonly ticketError = signal<string | null>(null);
  /** The worktree-vs-base diff the proof card renders; null until loaded. */
  readonly diff = signal<TicketDiffView | null>(null);
  /** The attachment object-URL memo: the file name to the URL `ensureAttachment` fetched. */
  private readonly attachmentUrls = signal<ReadonlyMap<string, string>>(new Map());

  private stopListen: (() => void) | null = null;
  private booted = false;
  private tail: StreamTail | null = null;

  constructor(private readonly client: McClient = new McClient()) {}

  /**
   * Boots the connection: a `#token=` bearer from the URL (Drey's
   * embedded client) stores the token directly and skips pairing; else a
   * stored token goes straight to ready; else a `#pair=` code is
   * exchanged; else the app waits on the pairing screen. Idempotent.
   *
   * A bare string is read as the pairing code — the shape the shell
   * passed before the `#token=` hint existed; prefer `McBootHints`.
   */
  async boot(hints?: McBootHints | string | null): Promise<void> {
    if (this.booted) {
      return;
    }
    this.booted = true;
    const fromUrl: McBootHints | null =
      typeof hints === 'string' ? { pairCode: hints, token: null } : (hints ?? null);
    const landed = (fromUrl?.token ?? '').trim();
    if (landed !== '') {
      this.client.setToken(landed);
      this.enterReady();
      return;
    }
    if (this.client.token() !== null) {
      this.enterReady();
      return;
    }
    const code = (fromUrl?.pairCode ?? '').trim();
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

  // --- the ticket screen (E5c) ------------------------------------------------

  /**
   * Opens one ticket: the screen shows it, the detail and the diff start
   * loading. The board view supplies the phase list; the card's own
   * phase is the highlighted entry.
   */
  openTicket(id: string): void {
    this.ticketOpen.set({ id });
    this.ticketDetail.set(null);
    this.ticketError.set(null);
    this.diff.set(null);
    void this.loadTicket(id);
  }

  /** Back to the board: drops the detail and revokes every object URL the memo holds. */
  closeTicket(): void {
    for (const url of this.attachmentUrls().values()) {
      this.client.release(url);
    }
    this.attachmentUrls.set(new Map());
    this.ticketOpen.set(null);
    this.ticketDetail.set(null);
    this.ticketError.set(null);
    this.diff.set(null);
  }

  /**
   * Loads one ticket's full markdown (`GET /api/tickets/<id>`); a 404 or
   * a dropped desk lands on `ticketError` and leaves the detail empty. A
   * newer `openTicket` racing this fetch wins — the stale answer is dropped.
   */
  async loadTicket(id: string): Promise<void> {
    const body = await this.client.request('GET', `/api/tickets/${encodeURIComponent(id)}`).catch(fail);
    if (this.ticketOpen()?.id !== id) {
      return;
    }
    if (isFailure(body)) {
      this.ticketDetail.set(null);
      this.ticketError.set(body.error);
      return;
    }
    const detail = parseTicketDetail(body, this.phaseOptions());
    if (detail === null) {
      this.ticketDetail.set(null);
      this.ticketError.set(refusal(body, 'the ticket did not come through').error);
      return;
    }
    const phase = detail.phase === '' ? (this.phaseOf(detail.id) ?? '') : detail.phase;
    this.ticketError.set(null);
    this.ticketDetail.set({ ...detail, phase });
  }

  /** The current board view's phases, for the ticket screen's phase rail. */
  private phaseOptions(): readonly TicketPhaseOption[] {
    return this.work().groups.map((group) => ({ id: group.id, title: group.title }));
  }

  /**
   * Saves the raw markdown (`POST /api/tickets/<id>/save`, the loaded
   * revision as the base); one git commit on the desk when it lands. A
   * stale base is the refine sentence, never the desk's raw wording; a
   * success re-loads the detail (the revision moves on).
   */
  async saveTicket(text: string): Promise<McReply> {
    const detail = this.ticketDetail();
    if (detail === null) {
      return { ok: false, error: 'no ticket is open' };
    }
    const path = `/api/tickets/${encodeURIComponent(detail.id)}/save`;
    const body = await this.client
      .request<Record<string, unknown>>('POST', path, { text, baseRevision: detail.revision })
      .catch(fail);
    // A stale base rides a 200 `{ok:false, conflict:true}` — the refine
    // sentence covers it before the plain isFailure pass below.
    if ((body as Record<string, unknown>)['conflict'] === true) {
      return { ok: false, error: 'The ticket changed since you opened it. Reload it and edit again.' };
    }
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not save the ticket');
    }
    await this.loadTicket(detail.id);
    return { ok: true };
  }

  /** Accepts the open ticket (`POST …/accept` — it leaves the owner's hands). */
  async acceptTicket(): Promise<McReply> {
    const open = this.ticketOpen();
    if (open === null) {
      return { ok: false, error: 'no ticket is open' };
    }
    const path = `/api/tickets/${encodeURIComponent(open.id)}/accept`;
    const body = await this.client.request<Record<string, unknown>>('POST', path).catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not accept the ticket');
    }
    await this.loadTicket(open.id);
    return { ok: true };
  }

  /** Sends the open ticket back to the agent; the note is mandatory (an empty one refuses). */
  async sendBack(note: string): Promise<McReply> {
    const open = this.ticketOpen();
    if (open === null) {
      return { ok: false, error: 'no ticket is open' };
    }
    const text = note.trim();
    if (text === '') {
      return { ok: false, error: 'a send-back needs a note' };
    }
    const path = `/api/tickets/${encodeURIComponent(open.id)}/send-back`;
    const body = await this.client.request<Record<string, unknown>>('POST', path, { note: text }).catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not send the ticket back');
    }
    await this.loadTicket(open.id);
    return { ok: true };
  }

  /** Loads the worktree-vs-base diff the proof card renders; a failed GET keeps the last good view. */
  async loadDiff(): Promise<void> {
    const open = this.ticketOpen();
    if (open === null) {
      return;
    }
    const body = await this.client.raw(`/api/tickets/${encodeURIComponent(open.id)}/diff`);
    if (body !== null) {
      this.diff.set(parseTicketDiff(body));
    }
  }

  /** The memoized object URL for one attachment; null until `ensureAttachment` fetched it. */
  attachmentUrl(name: string): string | null {
    return this.attachmentUrls().get(name) ?? null;
  }

  /** Fetches one attachment on demand; the memo hands out the same URL afterwards. */
  async ensureAttachment(name: string): Promise<string | null> {
    const known = this.attachmentUrls().get(name);
    if (known !== undefined) {
      return known;
    }
    const url = await this.client.attachment(name).catch(() => null);
    if (url === null) {
      return null;
    }
    this.attachmentUrls.update((map) => new Map(map).set(name, url));
    return url;
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
