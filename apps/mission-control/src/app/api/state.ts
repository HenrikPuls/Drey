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
 * owe us. The shell's visible tab and the chat's one-shot draft prefill
 * (the report card's promote) live here too, so any surface can switch
 * to the chat without the components knowing each other.
 */
import { computed, signal } from '@angular/core';
import { ApiError, McClient, type McBootHints, type McEventHandlers } from './client';
import { type McChatUploadReply } from '@mission-ui/chat/chat.model';
import type { McNotesApi } from '@mission-ui/notes/notes.model';
import {
  parsePairingView,
  parseSettings,
  type McChatTest,
  type McPairingView,
  type McSettingsView,
} from '@mission-ui/settings/settings.model';
import {
  parseActiveSession,
  parseChatEvent,
  parseChatFailure,
  parseImprovements,
  parseNeeds,
  parsePersonaMemory,
  parsePersonaThread,
  parseProposal,
  parseSessions,
  parseTeam,
  parseTicketDetail,
  parseEstimate,
  parsePlanStatus,
  parseFlow,
  parsePlanApproval,
  parseTicketDiff,
  parseWork,
  DEFAULT_PRIORITY_CONFIG,
  type ChatProposalView,
  type ChatStateView,
  type ChatStreamView,
  type McEstimate,
  type McFlow,
  type McPlanApproval,
  type McPlanStatus,
  type NeedView,
  type PersonaImprovementsView,
  type PersonaMemoryView,
  type PersonaPatch,
  type PersonaThreadView,
  type TeamView,
  type TicketDetail,
  type TicketDiffView,
  type TicketPhaseOption,
  type WorkView,
  type ChatFailureView,
} from '@mission-ui/api/dto';
import type { McApproveReply, McPartsEdit } from '@mission-ui/plan/approve.model';
import type { McFlowOp, McFlowReply } from '@mission-ui/flow/flow.model';

export type PairingPhase = 'needs-code' | 'pairing' | 'ready';

/**
 * The shell's visible tab — owned here so any surface can switch to it (E8:
 * the report card's promote drops into the chat). `menu` is the phone's
 * root screen (req-96, canvas decision 17); `notes` the Notes area, hidden
 * behind the shell's feature flag until req-101 ships its client. The
 * wide layouts never show `menu`: the shell reads it as Work.
 */
export type McTab = 'menu' | 'notes' | 'work' | 'chat' | 'team' | 'settings';

/** The colour a toast carries: ok (green), warn (amber), error (red). */
export type ToastKind = 'ok' | 'warn' | 'error';

/** One transient toast: the message and the kind the pill tints it with. */
export interface ToastMessage {
  readonly message: string;
  readonly kind: ToastKind;
}

/** How long a toast stays up before it hides itself (the prototype's 2.2 s). */
export const TOAST_HIDE_MS = 2200;

/** What every mutation hands back so the UI can surface a failure. */
export type McReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

const fail = (error: unknown): { readonly ok: false; readonly error: string } => ({
  ok: false,
  error:
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'The desk does not answer.',
});

/** A caught request error (an McReply) versus a 200 body the desk may still have refused. */
const isFailure = (value: unknown): value is { readonly ok: false; readonly error: string } =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

/** The `{ok:false, error}` the desk's refusal (or the fallback) becomes — always the false variant. */
const refusal = (
  body: unknown,
  fallback: string,
): { readonly ok: false; readonly error: string } => {
  const error = (typeof body === 'object' && body !== null ? (body as { error?: unknown }) : {})[
    'error'
  ];
  return { ok: false, error: typeof error === 'string' && error !== '' ? error : fallback };
};

/** The in-flight mission reply the SSE `text`/`thought` deltas accumulate into. */
interface StreamTail {
  readonly file: string;
}

export class McState {
  readonly connected = signal(false);
  readonly pairing = signal<PairingPhase>('needs-code');
  /** The shell's visible tab; the tabbar writes it, features switch it. */
  readonly tab = signal<McTab>('work');
  /**
   * The one-shot chat draft prefill (E8): the report card's promote fills
   * it and switches to the chat tab; the chat consumes it on construction.
   * null = nothing waiting.
   */
  readonly chatPrefill = signal<string | null>(null);
  /** D-1: why the last chat turn had no model (the chat's error card); null = none. */
  readonly chatFailure = signal<ChatFailureView | null>(null);
  /**
   * One-shot: the phone's menu button on another screen switches to the
   * chat tab with this set; the chat opens its history (the menu) on mount.
   */
  readonly chatMenu = signal(false);
  /** The per-vault settings (E12-3); null until the first load or after a failure. */
  readonly settings = signal<McSettingsView | null>(null);
  readonly settingsError = signal<string | null>(null);
  /** The pairing waiting for a device, started from Settings → Devices (D-2); null = none. */
  readonly pairingView = signal<McPairingView | null>(null);
  readonly work = signal<WorkView>({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG });
  readonly needs = signal<readonly NeedView[]>([]);
  readonly team = signal<TeamView>({ personas: [], runs: [] });
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

  // --- the Notes clients (req-101) ----------------------------------------------
  /** The SSE `notes` event: a counter (every frame is news) and the paths a device wrote. */
  readonly notesChanged = signal<{ readonly seq: number; readonly paths: readonly string[] }>({ seq: 0, paths: [] });
  /** The Notes calls over the desk, for the Notes screens. */
  get notesApi(): McNotesApi {
    return this.client;
  }

  private onNotesFrame(data: string): void {
    let paths: readonly string[] = [];
    try {
      const changed = (JSON.parse(data) as { changed?: unknown }).changed;
      paths = Array.isArray(changed) ? changed.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      paths = [];
    }
    this.notesChanged.update((last) => ({ seq: last.seq + 1, paths }));
  }

  /**
   * "Ask about this note": the chat opens with the note named in the
   * composer — the owner reviews the line and sends; the model reads the
   * note through the vault tools (the engine has no note attachment yet).
   */
  askAboutNote(path: string): void {
    this.prefillChat(`About the note ${path}: `);
  }

  // --- the toast pill ---------------------------------------------------------
  /** The current toast the shell's pill renders; null = nothing showing. */
  readonly toastMessage = signal<ToastMessage | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Shows the toast pill: one message at a time — a new toast replaces the
   * running one and restarts the hide timer (the prototype's showToast).
   */
  toast(message: string, kind: ToastKind = 'ok'): void {
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
    }
    this.toastMessage.set({ message, kind });
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.toastMessage.set(null);
    }, TOAST_HIDE_MS);
  }

  // --- the ticket screen's slice (E5c) --------------------------------------
  /** The ticket the screen shows; null = the board, not one ticket. */
  readonly ticketOpen = signal<{ id: string } | null>(null);
  /**
   * The ticket a card back-swipe parked its Send-back on: the screen
   * answers by opening its Send-back panel (on the proof face) for this
   * ticket and consumes the flag. Every fresh open, the panel's dismiss,
   * an accept, a landed send-back and the screen's close clear it —
   * null = nothing waiting.
   */
  readonly sendBackPending = signal<string | null>(null);
  /** The loaded ticket; null while the first fetch runs or it failed. */
  readonly ticketDetail = signal<TicketDetail | null>(null);
  /** The last load/save failure the ticket screen surfaces; null when all is well. */
  readonly ticketError = signal<string | null>(null);
  /** The worktree-vs-base diff the proof card renders; null until loaded. */
  readonly diff = signal<TicketDiffView | null>(null);
  /** The attachment object-URL memo: the file name to the URL `ensureAttachment` fetched. */
  private readonly attachmentUrls = signal<ReadonlyMap<string, string>>(new Map());

  // --- the persona detail's slice (E6) ----------------------------------------
  /** The persona whose 1:1 is open; null = the team list, no detail. */
  readonly personaDetail = signal<{ id: string } | null>(null);
  /** The loaded improvements view; null while the first fetch runs or it failed. */
  readonly improvements = signal<PersonaImprovementsView | null>(null);
  /** The last load failure the 1:1 surfaces; null when all is well. */
  readonly improvementsError = signal<string | null>(null);
  /** The 1:1's coaching thread; null while the first fetch runs or it failed. */
  readonly personaThread = signal<PersonaThreadView | null>(null);
  /** Why the thread load failed; null when all is well. */
  readonly personaThreadError = signal<string | null>(null);
  /** The 1:1's curated memory; null while the first fetch runs or it failed. */
  readonly personaMemory = signal<PersonaMemoryView | null>(null);
  /** Why the memory load failed; null when all is well. */
  readonly personaMemoryError = signal<string | null>(null);

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
    const device =
      typeof me?.device === 'object' && me.device !== null
        ? (me.device as { readOnly?: unknown })
        : null;
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
    if (name === 'notes') {
      this.onNotesFrame(data);
      return;
    }
    const event = parseChatEvent(name, data);
    switch (event.kind) {
      case 'board':
      case 'needs':
        void this.refreshWork();
        this.refreshOpenPlans();
        void this.refreshApproval();
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
      this.client
        .request('GET', '/api/needs')
        .then(parseNeeds)
        .catch(() => null),
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
    const sessions = await this.client
      .request('GET', '/api/chat/sessions')
      .then(parseSessions)
      .catch(() => null);
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
  /** The shared plans' states by ticket id (E10-2): the chip, the status line and the line marks. */
  private readonly plans = signal<ReadonlyMap<string, McPlanStatus>>(new Map());
  /** The chip's switch: the owner's plan edits go along with the next message (reset after each send). */
  readonly planEdits = signal(true);
  /** The open shape session's plan; null for a plain chat. */
  readonly chatPlan = computed<McPlanStatus | null>(() => {
    const ticket = this.chat().active?.ticket ?? null;
    return ticket === null ? null : (this.plans().get(ticket) ?? null);
  });

  /** The plan of one ticket as last fetched; null before the first answer. */
  planOf(id: string): McPlanStatus | null {
    return this.plans().get(id) ?? null;
  }

  /** Fetches one ticket's plan state; a failed GET keeps the last good one. */
  async refreshPlan(id: string): Promise<void> {
    const body = await this.client.raw(`/api/tickets/${encodeURIComponent(id)}/plan`);
    const status = body === null ? null : parsePlanStatus(body);
    if (status !== null) {
      this.plans.update((map) => new Map(map).set(id, status));
    }
  }

  private refreshOpenPlans(): void {
    const shaped = this.chat().active?.ticket ?? null;
    const open = this.ticketOpen()?.id ?? null;
    for (const id of new Set([shaped, open])) {
      if (id !== null) {
        void this.refreshPlan(id);
      }
    }
  }

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
    if (session?.ticket !== undefined && session.ticket !== null) {
      void this.refreshPlan(session.ticket);
      void this.loadShapeDoc(session.ticket);
    }
  }

  /**
   * Leaves the open session (req-96, the phone menu's "New chat"): the chat
   * shows its empty state, and the next send starts a new session. No
   * request — the sessions list keeps the entry.
   */
  closeSession(): void {
    this.tail = null;
    this.chat.update((chat) => (chat.active === null ? chat : { ...chat, active: null }));
  }

  // --- chat mutations -------------------------------------------------------

  /**
   * The chat prefill (E8 promote, E9 gate sheet): fills the chat draft —
   * the owner reviews the command and sends it, the desk answers with the
   * proposal card the confirmation needs — and switches to the chat tab,
   * where the freshly constructed composer adopts the one-shot prefill.
   * The ticket overlay closes: the owner leaves the ticket screen for the
   * composer, otherwise the overlay would cover the prefilled tab.
   */
  prefillChat(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') {
      return;
    }
    this.closeTicket();
    this.chatPrefill.set(trimmed);
    this.tab.set('chat');
  }

  /**
   * Leaves the ticket screen for the chat with nothing in the composer (D-7b:
   * 'Change by chat' no longer pre-fills a ticket-id prefix).
   */
  openChat(): void {
    this.closeTicket();
    this.tab.set('chat');
  }

  /** Starts a session with the first owner message and opens it; `ticket` makes it a shape session. */
  async newSession(text: string, ticket?: string): Promise<McReply> {
    this.chatFailure.set(null);
    const body = await this.client
      .request<Record<string, unknown>>('POST', '/api/chat/sessions', { text, ...(ticket === undefined ? {} : { ticket }) })
      .catch(fail);
    // A turn the model never answered comes back as { ok: false, failure, file }:
    // read that before the generic refusal.
    const file = typeof (body as Record<string, unknown>)['file'] === 'string' ? ((body as Record<string, unknown>)['file'] as string) : '';
    const failure = body['ok'] === true ? null : parseChatFailure((body as Record<string, unknown>)['failure']);
    if (failure === null && isFailure(body)) {
      return body;
    }
    if (failure !== null && file !== '') {
      // The desk wrote the session with the owner's line, then found no
      // model: open it and show the card under the line.
      await this.refreshSessions();
      await this.openSession(file);
      this.shapeTicket.set(null);
      this.chatFailure.set({ ...failure, file });
      return { ok: true };
    }
    if (body['ok'] !== true || file === '') {
      return refusal(body, 'the desk started no session');
    }
    await this.refreshSessions();
    // The start ran the whole turn server-side, so the fresh session the
    // GET returns already holds the owner message, the reply and any cards.
    await this.openSession(file);
    this.shapeTicket.set(null);
    return { ok: true };
  }

  // --- shape mode (E10-3) ---------------------------------------------------

  /** The ticket the composer will start a shape session for with its first message; null = a plain chat. */
  readonly shapeTicket = signal<string | null>(null);
  /** The shaped ticket's file as the desk holds it — the plan pane's document. */
  readonly shapeDoc = signal<{ readonly id: string; readonly text: string; readonly revision: string } | null>(null);
  /** The plan pane's pending edit, saved before the next message goes out; false = the save failed. */
  private planFlush: (() => Promise<boolean>) | null = null;
  /** True while a shape turn runs (the pane dims its editing). */
  readonly shapeBusy = signal(false);

  /** The ticket in view in the chat: the open shape session's, or the one a fresh composer was asked to shape. */
  readonly shapedTicket = computed<string | null>(() => {
    const active = this.chat().active;
    return active === null ? this.shapeTicket() : (active.ticket ?? null);
  });

  /** Paul's open split proposal in the open session: the latest `split` card, still undecided. */
  readonly splitProposal = computed(() => {
    const split = [...(this.chat().active?.messages ?? [])].reverse().find((m) => m.kind === 'split');
    return split === undefined || (split.decision ?? null) !== null ? null : { parts: split.parts ?? 1, reason: split.text };
  });

  /**
   * The entry point (E10-3): shaping a ticket with Paul. A session that
   * already shapes it opens again; otherwise a fresh composer waits for the
   * first message — the chat tab, the ticket screen closed.
   */
  beginShape(ticket: string): void {
    this.closeTicket();
    const existing = this.chat().sessions.find((s) => s.ticket === ticket) ?? null;
    this.tab.set('chat');
    if (existing !== null) {
      this.shapeTicket.set(null);
      void this.openSession(existing.file);
      return;
    }
    this.tail = null;
    this.chat.update((chat) => ({ ...chat, active: null }));
    this.shapeTicket.set(ticket);
    void this.loadShapeDoc(ticket);
  }

  /** Fetches the shaped ticket's file; a failed GET keeps the last good one. */
  async loadShapeDoc(id: string): Promise<void> {
    const body = await this.client.raw(`/api/tickets/${encodeURIComponent(id)}`);
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    if (record !== null && typeof record['text'] === 'string' && typeof record['revision'] === 'string') {
      if (this.shapedTicket() === id) {
        this.shapeDoc.set({ id, text: record['text'], revision: record['revision'] });
      }
    }
  }

  /** The pane's save: the whole ticket text against the loaded revision. */
  async saveShapeDoc(text: string): Promise<McReply> {
    const doc = this.shapeDoc();
    if (doc === null) {
      return { ok: false, error: 'the plan is not loaded yet' };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/tickets/${encodeURIComponent(doc.id)}/save`, { text, baseRevision: doc.revision })
      .catch(fail);
    if ((body as Record<string, unknown>)['conflict'] === true) {
      await this.loadShapeDoc(doc.id);
      return { ok: false, error: 'The plan changed since you opened it. It was reloaded — edit again.' };
    }
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not save the plan');
    }
    await this.loadShapeDoc(doc.id);
    void this.refreshPlan(doc.id);
    return { ok: true };
  }

  setPlanFlush(flush: (() => Promise<boolean>) | null): void {
    this.planFlush = flush;
  }

  /** The owner's tap on Paul's split proposal. "Split into N tickets" leads on to the plan to accept. */
  async shapeDecide(file: string, choice: 'keep' | 'split'): Promise<McReply> {
    const shaped = this.chat().active?.ticket ?? null;
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/chat/sessions/${encodeURIComponent(file)}/split/${choice}`)
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk could not take the decision');
    }
    const canonical = await this.client
      .request('GET', `/api/chat/sessions/${encodeURIComponent(file)}`)
      .then(parseActiveSession)
      .catch(() => null);
    if (canonical !== null && this.chat().active?.file === file) {
      this.chat.update((chat) => ({ ...chat, active: canonical }));
    }
    void this.refreshWork();
    if (choice === 'split' && shaped !== null) {
      void this.openApproval(shaped);
    }
    return { ok: true };
  }

  // --- the plan to accept (E10-4) -----------------------------------------

  /** The ticket whose plan is up for approval; null = the screen is closed. */
  readonly approvalTicket = signal<string | null>(null);
  /** The cards as the desk answered; null while they load. */
  readonly approval = signal<McPlanApproval | null>(null);
  readonly approvalError = signal<string | null>(null);

  /** Opens the plan to accept of one ticket (after "Split into N tickets", or from the ticket face). */
  async openApproval(ticket: string): Promise<void> {
    if (this.approvalTicket() !== ticket) {
      this.approval.set(null);
    }
    this.approvalError.set(null);
    this.approvalTicket.set(ticket);
    await this.refreshApproval();
  }

  closeApproval(): void {
    this.approvalTicket.set(null);
    this.approval.set(null);
    this.approvalError.set(null);
  }

  /** Re-reads the open plan's cards; a failed GET keeps the last good ones. */
  async refreshApproval(): Promise<void> {
    const id = this.approvalTicket();
    if (id === null) {
      return;
    }
    const body = await this.client.raw(`/api/tickets/${encodeURIComponent(id)}/parts`);
    if (this.approvalTicket() !== id) {
      return;
    }
    const approval = body === null ? null : parsePlanApproval(body);
    if (approval !== null) {
      this.approval.set(approval);
      this.approvalError.set(null);
    } else if (this.approval() === null) {
      const error = (typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null) ?? null;
      this.approvalError.set(typeof error === 'string' ? error : 'The desk has no plan parts for this ticket.');
    }
  }

  /** One list edit on the cards: a persona pick, a move, a delete. */
  async editParts(edit: McPartsEdit): Promise<McApproveReply> {
    const id = this.approvalTicket();
    if (id === null) {
      return { ok: false, error: 'no plan is open' };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/tickets/${encodeURIComponent(id)}/parts`, edit)
      .catch(fail);
    if (isFailure(body)) {
      await this.refreshApproval();
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not change the parts');
    }
    await this.refreshApproval();
    void this.refreshPlan(id);
    return { ok: true };
  }

  /** The approval: mints a ticket per new part (or only the first). "All" closes the screen and shows Work; "first" keeps the cards up. */
  async releaseParts(scope: 'all' | 'first'): Promise<McApproveReply> {
    const id = this.approvalTicket();
    if (id === null) {
      return { ok: false, error: 'no plan is open' };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/tickets/${encodeURIComponent(id)}/release`, { scope })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not release the parts');
    }
    const tickets = Array.isArray(body['tickets']) ? body['tickets'].filter((t): t is string => typeof t === 'string') : [];
    void this.refreshWork();
    this.toast(tickets.length === 1 ? `Released ${tickets[0]}` : `Released ${tickets.length} tickets`, 'ok');
    if (scope === 'first') {
      // Only part 1 went: the rest still waits for its own approval, so the cards stay up, now with a locked first part.
      await this.refreshApproval();
      return { ok: true, tickets };
    }
    this.closeApproval();
    this.tab.set('work');
    return { ok: true, tickets };
  }

  // --- the flow editor (E10-5) ---------------------------------------------

  /** The flow being edited: a ticket's own chain (`part` null) or one part of a plan. */
  readonly flowTarget = signal<{ readonly ticket: string; readonly part: number | null } | null>(null);
  /** The working draft as the desk last answered it. */
  readonly flow = signal<McFlow | null>(null);
  /** The flow as the file holds it — what the dashed marks compare against. */
  readonly flowSaved = signal<McFlow | null>(null);
  readonly flowError = signal<string | null>(null);
  /** Paul's reason while his draft is the working draft. */
  readonly flowReason = signal<string | null>(null);
  /** The draft before Paul's, for "Undo draft". */
  private flowBeforePaul: McFlow | null = null;

  private flowPath(target: { ticket: string; part: number | null }): string {
    return `/api/tickets/${encodeURIComponent(target.ticket)}/flow`;
  }

  /** Opens the flow editor on a ticket's flow (`part` null) or one part's. */
  async openFlow(ticket: string, part: number | null): Promise<void> {
    this.flow.set(null);
    this.flowSaved.set(null);
    this.flowError.set(null);
    this.flowReason.set(null);
    this.flowBeforePaul = null;
    this.flowTarget.set({ ticket, part });
    const body = await this.client.raw(`${this.flowPath({ ticket, part })}${part === null ? '' : `/${part}`}`);
    const target = this.flowTarget();
    if (target === null || target.ticket !== ticket || target.part !== part) {
      return;
    }
    const flow = body === null ? null : parseFlow(body);
    if (flow === null) {
      const error = (typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null) ?? null;
      this.flowError.set(typeof error === 'string' ? error : 'The desk has no flow for this ticket.');
      return;
    }
    this.flow.set(flow);
    this.flowSaved.set(flow);
  }

  closeFlow(): void {
    this.flowTarget.set(null);
    this.flow.set(null);
    this.flowSaved.set(null);
    this.flowError.set(null);
    this.flowReason.set(null);
    this.flowBeforePaul = null;
  }

  /** One edit on the draft: the desk answers the next draft; nothing is written. */
  async editFlow(op: McFlowOp): Promise<McFlowReply> {
    const target = this.flowTarget();
    const draft = this.flow();
    if (target === null || draft === null) {
      return { ok: false, error: 'no flow is open' };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `${this.flowPath(target)}-edit`, { part: target.part, chain: draft.chain, edit: op })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    const next = parseFlow(body);
    if (next === null) {
      return refusal(body, 'the desk did not take that change');
    }
    this.flow.set(next);
    // A hand edit makes the working draft the owner's again.
    this.flowReason.set(null);
    this.flowBeforePaul = null;
    return { ok: true };
  }

  /** Paul drafts a flow; the draft becomes the working draft (dashed) and keeps the one before for undo. */
  async draftFlow(ask: string | null): Promise<McFlowReply> {
    const target = this.flowTarget();
    const before = this.flow();
    if (target === null || before === null) {
      return { ok: false, error: 'no flow is open' };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `${this.flowPath(target)}-draft`, { part: target.part, ask })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    const drafted = parseFlow(body);
    if (drafted === null) {
      return refusal(body, 'Paul could not draft a flow');
    }
    this.flowBeforePaul = before;
    this.flow.set(drafted);
    this.flowReason.set(drafted.reason ?? 'Paul proposes this flow.');
    return { ok: true };
  }

  undoFlowDraft(): void {
    if (this.flowBeforePaul !== null) {
      this.flow.set(this.flowBeforePaul);
    }
    this.flowBeforePaul = null;
    this.flowReason.set(null);
  }

  /** "Save flow": the draft becomes the chain in the file; the editor closes and the screens under it refresh. */
  async saveFlow(): Promise<McFlowReply> {
    const target = this.flowTarget();
    const draft = this.flow();
    if (target === null || draft === null) {
      return { ok: false, error: 'no flow is open' };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `${this.flowPath(target)}-save`, { part: target.part, chain: draft.chain })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not save the flow');
    }
    this.closeFlow();
    this.toast('Flow saved', 'ok');
    if (target.part !== null) {
      void this.refreshApproval();
    }
    if (this.ticketOpen()?.id === target.ticket) {
      void this.loadTicket(target.ticket);
    }
    void this.refreshWork();
    return { ok: true };
  }

  /** Uploads the composer's picked attachments to the desk. */
  async uploadAttachment(files: File[]): Promise<McChatUploadReply> {
    return this.client.uploadAttachments(files);
  }

  /** Sends one owner message to the open session (echoed at once). */
  async send(text: string): Promise<McReply> {
    const file = this.chat().active?.file ?? null;
    if (file === null) {
      return { ok: false, error: 'no chat session is open' };
    }
    // The plan pane saves an edit still in its field first, so the model reads the same text.
    if (this.planFlush !== null && !(await this.planFlush())) {
      return { ok: false, error: 'Save the plan edit first — it did not go through.' };
    }
    this.appendMessage({ role: 'owner', text, thought: null, at: new Date().toISOString() });
    this.shapeBusy.set(this.chat().active?.ticket != null);
    const shaped = this.chat().active?.ticket ?? null;
    const withEdits = this.planEdits();
    this.chatFailure.set(null);
    const body = await this.client
      .request<Record<string, unknown>>(
        'POST',
        `/api/chat/sessions/${encodeURIComponent(file)}/messages`,
        { text, ...(shaped !== null && !withEdits ? { planEdits: false } : {}) },
      )
      .catch(fail);
    this.shapeBusy.set(false);
    const failure = body['ok'] === true ? null : parseChatFailure((body as Record<string, unknown>)['failure']);
    if (failure === null && isFailure(body)) {
      return body;
    }
    if (failure !== null) {
      // The owner's line is in the session; no model answered. Reload the
      // canonical thread (the optimistic echo and the stream tail go) and
      // let the card say why.
      this.tail = null;
      await this.openSession(file);
      this.chatFailure.set({ ...failure, file });
      return { ok: true };
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not take the message');
    }
    this.applyTurn(body);
    if (shaped !== null) {
      // The desk wrote the "You edited the plan" card into the session file:
      // read the canonical session back, and the chip starts afresh.
      this.planEdits.set(true);
      const canonical = await this.client
        .request('GET', `/api/chat/sessions/${encodeURIComponent(file)}`)
        .then(parseActiveSession)
        .catch(() => null);
      if (canonical !== null && this.chat().active?.file === file) {
        this.tail = null;
        this.chat.update((chat) => ({ ...chat, active: canonical }));
      }
      void this.refreshPlan(shaped);
      void this.loadShapeDoc(shaped);
    }
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
      .request<Record<string, unknown>>('POST', `/api/tickets/${encodeURIComponent(id)}/move`, {
        id,
        from,
        to,
      })
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
   * phase is the highlighted entry. A pending send-back never survives
   * an open — only the swipe's own call re-parks one, right after.
   */
  openTicket(id: string): void {
    this.ticketOpen.set({ id });
    this.sendBackPending.set(null);
    this.ticketDetail.set(null);
    this.ticketError.set(null);
    this.diff.set(null);
    this.wholeFiles.set(new Map());
    this.wholeFilesAsked.clear();
    void this.loadTicket(id);
  }

  /**
   * The card back-swipe's one call: opens the ticket AND parks the
   * send-back, so the screen lands straight on its Send-back panel.
   */
  openTicketSendBack(id: string): void {
    this.openTicket(id);
    this.sendBackPending.set(id);
  }

  /** The screen consumed the parked send-back (panel opened or dismissed). */
  clearSendBack(): void {
    this.sendBackPending.set(null);
  }

  /** Back to the board: drops the detail and revokes every object URL the memo holds. */
  closeTicket(): void {
    for (const url of this.attachmentUrls().values()) {
      this.client.release(url);
    }
    this.attachmentUrls.set(new Map());
    this.ticketOpen.set(null);
    this.sendBackPending.set(null);
    this.ticketDetail.set(null);
    this.ticketError.set(null);
    this.diff.set(null);
    this.wholeFiles.set(new Map());
    this.wholeFilesAsked.clear();
  }

  /**
   * Loads one ticket's full markdown (`GET /api/tickets/<id>`); a 404 or
   * a dropped desk lands on `ticketError` and leaves the detail empty. A
   * newer `openTicket` racing this fetch wins — the stale answer is dropped.
   */
  async loadTicket(id: string): Promise<void> {
    const body = await this.client
      .request('GET', `/api/tickets/${encodeURIComponent(id)}`)
      .catch(fail);
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
    void this.refreshPlan(id);
  }

  /**
   * The archive of any age, newest first (`GET /api/archive`, E13-21): what the Work
   * tab's "Show older" lists under the Done-this-week group. A dropped desk is an empty list.
   */
  async loadArchive(): Promise<readonly { id: string; title: string | null; at: string }[]> {
    const body = await this.client.raw<{ ok?: boolean; tickets?: unknown }>('/api/archive');
    const list = Array.isArray(body?.tickets) ? (body.tickets as readonly unknown[]) : [];
    return list.flatMap((item) => {
      const entry = item as { id?: unknown; title?: unknown; at?: unknown } | null;
      return entry !== null && typeof entry.id === 'string'
        ? [{ id: entry.id, title: typeof entry.title === 'string' ? entry.title : null, at: typeof entry.at === 'string' ? entry.at : '' }]
        : [];
    });
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
      return {
        ok: false,
        error: 'The ticket changed since you opened it. Reload it and edit again.',
      };
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
    this.sendBackPending.set(null);
    await this.loadTicket(open.id);
    return { ok: true };
  }

  /** A manual step's Accept (E10-6): the same endpoint as the ticket screen's, for any ticket by id. */
  async finishManualStep(id: string): Promise<McReply> {
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/tickets/${encodeURIComponent(id)}/accept`)
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    return body['ok'] === true ? { ok: true } : refusal(body, 'the desk did not accept the step');
  }

  /** A manual step's Send back (E10-6): the note is mandatory. */
  async sendBackManualStep(id: string, note: string): Promise<McReply> {
    const text = note.trim();
    if (text === '') {
      return { ok: false, error: 'a send-back needs a note' };
    }
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/tickets/${encodeURIComponent(id)}/send-back`, { note: text })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    return body['ok'] === true ? { ok: true } : refusal(body, 'the desk did not send the ticket back');
  }

  /** Sends the open ticket back to the agent; the note is mandatory (an empty one refuses). */
  async sendBack(note: string, comments: readonly { file: string; line: number; endLine: number | null; text: string }[] = []): Promise<McReply> {
    const open = this.ticketOpen();
    if (open === null) {
      return { ok: false, error: 'no ticket is open' };
    }
    const text = note.trim();
    if (text === '' && comments.length === 0) {
      return { ok: false, error: 'a send-back needs a note' };
    }
    const path = `/api/tickets/${encodeURIComponent(open.id)}/send-back`;
    const body = await this.client
      .request<Record<string, unknown>>('POST', path, { note: text, ...(comments.length > 0 ? { comments } : {}) })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not send the ticket back');
    }
    this.sendBackPending.set(null);
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

  // --- fleet runs (req-64) -----------------------------------------------------

  /**
   * Answers a run's question: `POST /api/runs/<runId>/answer` with the
   * answers record the desk's parseAnswer reads — one question's form key
   * to the chosen wording. The key comes from the need the run waits on
   * (the needs list the SSE frames keep fresh); without a readable one
   * the first form key (`q0`) is the default. A `QUESTION:` turn (req-75
   * W2) carries no form: the desk refuses the answer route, and the
   * wording then goes the steer route instead — the takeover's own path
   * for the conversation's question.
   */
  async answerRun(runId: string, text: string): Promise<McReply> {
    const trimmed = text.trim();
    if (trimmed === '') {
      return { ok: false, error: 'the answer is empty' };
    }
    const key = this.needs().find((need) => need.runId === runId)?.questions?.[0]?.key ?? 'q0';
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/runs/${encodeURIComponent(runId)}/answer`, {
        answers: { [key]: trimmed },
      })
      .catch(fail);
    if (isFailure(body)) {
      if (/asks no question/.test(body.error)) {
        return this.steerRun(runId, trimmed);
      }
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not take the answer');
    }
    return { ok: true };
  }

  /** Steers a waiting run with the owner's wording (`POST /api/runs/<id>/send`). */
  private async steerRun(runId: string, text: string): Promise<McReply> {
    const body = await this.client
      .request<Record<string, unknown>>('POST', `/api/runs/${encodeURIComponent(runId)}/send`, {
        text,
      })
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not take the answer');
    }
    return { ok: true };
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

  /** Run estimates by `gate|persona|model` (E11-4); null = asked, no basis. */
  private readonly estimates = signal<ReadonlyMap<string, McEstimate | null>>(new Map());
  private readonly estimatesAsked = new Set<string>();

  /**
   * The estimate for a gate by a persona, on the model the persona is
   * set to; null until the desk answers and when it has no basis (fewer
   * than three similar runs). The first call starts the fetch.
   */
  estimateFor(gate: string, persona: string): McEstimate | null {
    const model = this.team().personas.find((p) => p.id === persona)?.model ?? '';
    if (model === '') {
      return null;
    }
    const key = `${gate}|${persona}|${model}`;
    if (!this.estimatesAsked.has(key)) {
      this.estimatesAsked.add(key);
      void this.fetchEstimate(key, gate, persona, model);
    }
    return this.estimates().get(key) ?? null;
  }

  private async fetchEstimate(key: string, gate: string, persona: string, model: string): Promise<void> {
    const path = `/api/estimate/${encodeURIComponent(gate)}/${encodeURIComponent(persona)}/${encodeURIComponent(model)}`;
    const body = await this.client.raw(path);
    if (body === null) {
      this.estimatesAsked.delete(key);
      return;
    }
    this.estimates.update((map) => new Map(map).set(key, parseEstimate(body)));
  }

  /** Whole-file texts for the diff's "Whole file" view, by repo path. */
  private readonly wholeFiles = signal<ReadonlyMap<string, { text: string; truncated: boolean }>>(new Map());
  private readonly wholeFilesAsked = new Set<string>();

  /** A file on the ticket branch; null until fetched (the first call starts the fetch). */
  wholeFile(path: string): { text: string; truncated: boolean } | null {
    const known = this.wholeFiles().get(path);
    if (known === undefined && !this.wholeFilesAsked.has(path)) {
      this.wholeFilesAsked.add(path);
      void this.fetchWholeFile(path);
    }
    return known ?? null;
  }

  private async fetchWholeFile(path: string): Promise<void> {
    const open = this.ticketOpen();
    if (open === null) {
      return;
    }
    const encoded = encodeURIComponent(path);
    const body = await this.client.raw<Record<string, unknown>>(`/api/tickets/${encodeURIComponent(open.id)}/file/${encoded}`);
    if (body !== null && body['ok'] === true && typeof body['text'] === 'string') {
      const entry = { text: body['text'], truncated: body['truncated'] === true };
      this.wholeFiles.update((map) => new Map(map).set(path, entry));
    } else {
      this.wholeFilesAsked.delete(path);
    }
  }

  /** The memoized object URL for one walkthrough video; null until `ensureVideo` fetched it. */
  videoUrl(name: string): string | null {
    return this.attachmentUrls().get(`videos/${name}`) ?? null;
  }

  /** Fetches one video on demand (it shares the attachment memo under a `videos/` key). */
  async ensureVideo(name: string): Promise<string | null> {
    const key = `videos/${name}`;
    const known = this.attachmentUrls().get(key);
    if (known !== undefined) {
      return known;
    }
    const url = await this.client.video(name).catch(() => null);
    if (url === null) {
      return null;
    }
    this.attachmentUrls.update((map) => new Map(map).set(key, url));
    return url;
  }

  // --- the persona detail (E6) -------------------------------------------------

  /**
   * Opens one persona's 1:1 (concept §4.8): the screen shows it and the
   * improvements, the thread and the memory start loading. The persona's
   * directory facts ride along in the improvements answer's `persona`
   * field — the Team tab's list needs nothing.
   */
  openPersona(id: string): void {
    this.personaDetail.set({ id });
    this.improvements.set(null);
    this.improvementsError.set(null);
    this.personaThread.set(null);
    this.personaThreadError.set(null);
    this.personaMemory.set(null);
    this.personaMemoryError.set(null);
    void this.loadPersona(id);
    void this.loadPersonaThread(id);
    void this.loadPersonaMemory(id);
  }

  /** Back to the team list: drops the loaded views and any failure. */
  closePersona(): void {
    this.personaDetail.set(null);
    this.improvements.set(null);
    this.improvementsError.set(null);
    this.personaThread.set(null);
    this.personaThreadError.set(null);
    this.personaMemory.set(null);
    this.personaMemoryError.set(null);
  }

  /**
   * Loads one persona's improvements (`GET /api/personas/<id>/improvements`);
   * a missing persona or a dropped desk lands on `improvementsError` and
   * leaves the view empty. A newer `openPersona` racing this fetch wins —
   * the stale answer is dropped (the ticket screen's load pattern).
   */
  async loadPersona(id: string): Promise<void> {
    const body = await this.client
      .request('GET', `/api/personas/${encodeURIComponent(id)}/improvements`)
      .catch(fail);
    if (this.personaDetail()?.id !== id) {
      return;
    }
    if (isFailure(body)) {
      this.improvements.set(null);
      this.improvementsError.set(body.error);
      return;
    }
    const view = parseImprovements(body);
    if (view === null) {
      this.improvements.set(null);
      this.improvementsError.set(refusal(body, 'the improvements did not come through').error);
      return;
    }
    this.improvementsError.set(null);
    this.improvements.set(view);
  }

  /**
   * Applies one open proposal (`POST …/improvements/<imp>/apply` — the
   * desk rewrites the proposal's target in exactly one commit); a success
   * re-loads the view, moving the proposal into the history.
   */
  applyImprovement(personaId: string, proposalId: string): Promise<McReply> {
    return this.decideImprovement(personaId, proposalId, 'apply');
  }

  /** Dismisses one open proposal (`POST …/improvements/<imp>/dismiss`); a success re-loads the view. */
  dismissImprovement(personaId: string, proposalId: string): Promise<McReply> {
    return this.decideImprovement(personaId, proposalId, 'dismiss');
  }

  private async decideImprovement(
    personaId: string,
    proposalId: string,
    which: 'apply' | 'dismiss',
  ): Promise<McReply> {
    const base = `/api/personas/${encodeURIComponent(personaId)}/improvements`;
    const body = await this.client
      .request<Record<string, unknown>>(
        'POST',
        `${base}/${encodeURIComponent(proposalId)}/${which}`,
      )
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, `the desk could not ${which} the proposal`);
    }
    await this.loadPersona(personaId);
    return { ok: true };
  }

  // --- the 1:1's thread, memory and setup (prototype convergence) ------------

  /**
   * Loads one persona's thread (`GET /api/personas/<id>/thread`) and its
   * memory (`GET /api/personas/<id>/memory`) — both tolerant: a torn
   * answer degrades to an empty view, a dropped desk lands on the error
   * signal. A newer `openPersona` racing these fetches wins — stale
   * answers are dropped (the improvements load's pattern).
   */
  private async loadPersonaThread(id: string): Promise<void> {
    const body = await this.client
      .request('GET', `/api/personas/${encodeURIComponent(id)}/thread`)
      .catch(fail);
    if (this.personaDetail()?.id !== id) {
      return;
    }
    if (isFailure(body)) {
      this.personaThread.set(null);
      this.personaThreadError.set(body.error);
      return;
    }
    this.personaThreadError.set(null);
    this.personaThread.set(parsePersonaThread(body));
  }

  private async loadPersonaMemory(id: string): Promise<void> {
    const body = await this.client
      .request('GET', `/api/personas/${encodeURIComponent(id)}/memory`)
      .catch(fail);
    if (this.personaDetail()?.id !== id) {
      return;
    }
    if (isFailure(body)) {
      this.personaMemory.set(null);
      this.personaMemoryError.set(body.error);
      return;
    }
    this.personaMemoryError.set(null);
    this.personaMemory.set(parsePersonaMemory(body));
  }

  /**
   * Sends one owner line into the open persona's thread: the echo lands
   * at once (optimistic append), then the POST runs; the desk's own
   * answer — when the reply carries `messages` — replaces the echo's
   * tail canonical. A refusal keeps the echo and lands on the error
   * signal (the pane surfaces it inline).
   */
  async sendPersonaThread(id: string, text: string): Promise<McReply> {
    const trimmed = text.trim();
    if (trimmed === '' || this.personaDetail()?.id !== id) {
      return { ok: false, error: 'no persona thread is open' };
    }
    this.personaThread.update((thread) => ({
      messages: [
        ...(thread?.messages ?? []),
        { role: 'owner', text: trimmed, at: new Date().toISOString() },
      ],
    }));
    const body = await this.client
      .request('POST', `/api/personas/${encodeURIComponent(id)}/thread`, { text: trimmed })
      .catch(fail);
    if (this.personaDetail()?.id !== id) {
      return { ok: false, error: 'the persona thread closed' };
    }
    if (isFailure(body)) {
      this.personaThreadError.set(body.error);
      return body;
    }
    // The reply may carry the canonical thread — apply it when readable;
    // anything else keeps the optimistic echo (tolerant, never a throw).
    const messages = (body as Record<string, unknown>)['messages'];
    if (Array.isArray(messages)) {
      this.personaThread.set(parsePersonaThread({ messages }));
    }
    this.personaThreadError.set(null);
    return { ok: true };
  }

  /**
   * Appends one manual memory entry: the unpinned line lands at once
   * (optimistic), then the POST; a refusal drops the optimistic line and
   * lands on the error signal.
   */
  async appendPersonaMemory(id: string, text: string): Promise<McReply> {
    const trimmed = text.trim();
    if (trimmed === '' || this.personaDetail()?.id !== id) {
      return { ok: false, error: 'no persona memory is open' };
    }
    const before = this.personaMemory();
    this.personaMemory.set({
      entries: [...(before?.entries ?? []), { text: trimmed, pinned: false }],
    });
    const body = await this.client
      .request('POST', `/api/personas/${encodeURIComponent(id)}/memory`, { text: trimmed })
      .catch(fail);
    if (this.personaDetail()?.id !== id) {
      return { ok: false, error: 'the persona memory closed' };
    }
    if (isFailure(body)) {
      this.personaMemory.set(before);
      this.personaMemoryError.set(body.error);
      return body;
    }
    const entries = (body as Record<string, unknown>)['entries'];
    if (Array.isArray(entries)) {
      this.personaMemory.set(parsePersonaMemory({ entries }));
    }
    this.personaMemoryError.set(null);
    return { ok: true };
  }

  /**
   * Pins or unpins the memory entry at `index` (`POST …/memory/pin` with
   * `{index, pinned}` — the wire pins by position): the flag flips at
   * once (optimistic) and reverts when the desk refuses.
   */
  async pinPersonaMemory(id: string, index: number, pinned: boolean): Promise<McReply> {
    const before = this.personaMemory();
    if (before === null || this.personaDetail()?.id !== id || before.entries[index] === undefined) {
      return { ok: false, error: 'no such memory entry' };
    }
    const flipped: PersonaMemoryView = {
      entries: before.entries.map((entry, at) => (at === index ? { ...entry, pinned } : entry)),
    };
    this.personaMemory.set(flipped);
    const body = await this.client
      .request('POST', `/api/personas/${encodeURIComponent(id)}/memory/pin`, { index, pinned })
      .catch(fail);
    if (this.personaDetail()?.id !== id) {
      return { ok: false, error: 'the persona memory closed' };
    }
    if (isFailure(body)) {
      this.personaMemory.set(before);
      this.personaMemoryError.set(body.error);
      return body;
    }
    if ((body as Record<string, unknown>)['ok'] !== true) {
      this.personaMemory.set(before);
      const refused = refusal(body, 'the desk did not take the pin');
      this.personaMemoryError.set(refused.error);
      return refused;
    }
    this.personaMemoryError.set(null);
    return { ok: true };
  }

  /**
   * Patches the persona (`PATCH /api/personas/<id>` — the setup tab's
   * every change, one commit each); a success re-folds the team so the
   * directory's fresh fields ride the next render.
   */
  async personaPatch(id: string, patch: PersonaPatch): Promise<McReply> {
    const body = await this.client
      .request<Record<string, unknown>>('PATCH', `/api/personas/${encodeURIComponent(id)}`, patch)
      .catch(fail);
    if (isFailure(body)) {
      return body;
    }
    if (body['ok'] !== true) {
      return refusal(body, 'the desk did not take the change');
    }
    await this.refreshTeam();
    return { ok: true };
  }

  // --- the chain's switches (the team tab's strip and cards) -------------------

  /**
   * The chain master's toggle (`POST /api/chain/master` with the new
   * mode): a success re-folds the team (the fresh snapshot reports the
   * position) and toasts the prototype's wording; a refusal toasts why.
   */
  async chainMaster(paused: boolean): Promise<McReply> {
    const body = await this.client
      .request<Record<string, unknown>>('POST', '/api/chain/master', {
        mode: paused ? 'halted' : 'run',
      })
      .catch(fail);
    if (isFailure(body)) {
      this.toast(body.error, 'error');
      return body;
    }
    if (body['ok'] !== true) {
      const refused = refusal(body, 'the desk did not take the switch');
      this.toast(refused.error, 'error');
      return refused;
    }
    await this.refreshTeam();
    this.toast(paused ? 'Chain halted — running runs finish' : 'Chain runs again', 'ok');
    return { ok: true };
  }

  // --- settings (E12-3) --------------------------------------------------------

  /** Loads the desk's per-vault settings; a failure is surfaced, never thrown. */
  async load(): Promise<void> {
    const body = await this.client.request<unknown>('GET', '/api/settings').catch(fail);
    const view = isFailure(body) ? null : parseSettings(body);
    this.settings.set(view);
    this.settingsError.set(
      view !== null ? null : isFailure(body) ? body.error : 'This desk has no settings to show.',
    );
  }

  setVideoMaxMb(maxMb: number): Promise<McReply> {
    return this.settingsWrite('/api/settings/engine', { maxMb });
  }

  setVideosInGit(inGit: boolean, confirm: boolean, includeExisting = false): Promise<McReply> {
    return this.settingsWrite('/api/settings/engine', { inGit, confirm, includeExisting });
  }

  /** The Chat row's "Test connection": the desk probes the endpoint the chat would use. */
  async testChat(): Promise<McChatTest> {
    const body: Record<string, unknown> | { readonly ok: false; readonly error: string } = await this.client
      .request<Record<string, unknown>>('POST', '/api/settings/chat/test', {})
      .catch(fail);
    // The desk's answer is { ok, message } either way -- a failed probe is a
    // result to show, not a failed request.
    const record = body as Record<string, unknown>;
    if (typeof record['message'] === 'string') {
      return { ok: record['ok'] === true, message: record['message'] };
    }
    return { ok: false, message: isFailure(body) ? body.error : 'The desk gave no answer to the test.' };
  }

  revokeDevice(id: string): Promise<McReply> {
    return this.settingsWrite('/api/settings/devices/revoke', { id });
  }

  // --- pairing from this device (D-2) -------------------------------------------

  /** Starts a pairing (`POST /api/pairing/start`); the engine refuses a read-only device. */
  async startPairing(name: string, readOnly: boolean): Promise<McReply> {
    return this.pairingCall('POST', '/api/pairing/start', { name, readOnly });
  }

  async cancelPairing(): Promise<McReply> {
    return this.pairingCall('POST', '/api/pairing/cancel', {});
  }

  /**
   * Re-reads the waiting pairing (`GET /api/pairing`). Once a pairing that
   * was up is gone -- its code was used or it expired -- the device list
   * reloads, so the new device appears.
   */
  async refreshPairing(): Promise<void> {
    const had = this.pairingView()?.pairing != null;
    const body = await this.client.request<unknown>('GET', '/api/pairing').catch(fail);
    const view = isFailure(body) ? null : parsePairingView(body);
    this.pairingView.set(view);
    if (had && view?.pairing == null) {
      await this.load();
    }
  }

  private async pairingCall(method: 'POST', path: string, payload: unknown): Promise<McReply> {
    const body = await this.client.request<Record<string, unknown>>(method, path, payload).catch(fail);
    if (isFailure(body)) {
      this.toast(body.error, 'error');
      return body;
    }
    const view = parsePairingView(body);
    if (view === null) {
      const refused = refusal(body, 'the desk did not take the pairing');
      this.toast(refused.error, 'error');
      return refused;
    }
    this.pairingView.set(view);
    return { ok: true };
  }

  /** One settings write: the desk answers with the fresh view, a refusal toasts why. */
  private async settingsWrite(path: string, payload: unknown): Promise<McReply> {
    const body = await this.client.request<Record<string, unknown>>('POST', path, payload).catch(fail);
    if (isFailure(body)) {
      this.toast(body.error, 'error');
      return body;
    }
    const view = body['ok'] === true ? parseSettings(body) : null;
    if (view === null) {
      const refused = refusal(body, 'the desk did not take the change');
      this.toast(refused.error, 'error');
      return refused;
    }
    this.settings.set(view);
    this.settingsError.set(null);
    return { ok: true };
  }

  /**
   * One persona's pause/resume (`POST /api/chain/persona-pause` with
   * `{persona, paused}`): a success re-folds the team and toasts; a
   * refusal toasts why. The paused persona finishes its running work —
   * the chain just stops dispatching to it.
   */
  async personaPause(id: string, paused: boolean): Promise<McReply> {
    const body = await this.client
      .request<Record<string, unknown>>('POST', '/api/chain/persona-pause', { persona: id, paused })
      .catch(fail);
    if (isFailure(body)) {
      this.toast(body.error, 'error');
      return body;
    }
    if (body['ok'] !== true) {
      const refused = refusal(body, `the desk did not ${paused ? 'pause' : 'resume'} ${id}`);
      this.toast(refused.error, 'error');
      return refused;
    }
    await this.refreshTeam();
    this.toast(paused ? `Persona ${id} paused` : `Persona ${id} resumed`, 'ok');
    return { ok: true };
  }

  // --- run controls and the all-switches (E12-4) -------------------------------

  /** The default steer a Nudge sends (see the Team view). */
  private static readonly NUDGE_TEXT =
    'You seem stuck. Say in one line what you have tried, then take a different approach.';

  /** The title of a ticket off the board, for the Team card's run rows; null = unknown. */
  ticketTitleOf(id: string): string | null {
    for (const group of this.work().groups) {
      const card = group.cards.find((candidate) => candidate.id === id);
      if (card !== undefined) {
        return card.title;
      }
    }
    return null;
  }

  /** A stuck run's Nudge: one steering message. */
  nudgeRun(runId: string): Promise<McReply> {
    return this.runControl(`/api/runs/${encodeURIComponent(runId)}/send`, { text: McState.NUDGE_TEXT }, 'Nudged the worker');
  }

  /** A stuck run's Stop. */
  stopRun(runId: string): Promise<McReply> {
    return this.runControl(`/api/runs/${encodeURIComponent(runId)}/stop`, {}, 'Run stopped');
  }

  /** A stuck run's Hand to Claude Code: stop, wait, restart the ticket there. */
  handToClaude(runId: string): Promise<McReply> {
    return this.runControl(`/api/runs/${encodeURIComponent(runId)}/handoff`, {}, 'Handed to Claude Code');
  }

  /** "Stop all": every live run aborted and the chain halted. */
  async stopAll(): Promise<McReply> {
    const body = await this.client.request<Record<string, unknown>>('POST', '/api/chain/abort', {}).catch(fail);
    if (isFailure(body)) {
      this.toast(body.error, 'error');
      return body;
    }
    if (body['ok'] !== true) {
      const refused = refusal(body, 'the desk did not stop everything');
      this.toast(refused.error, 'error');
      return refused;
    }
    await this.refreshTeam();
    this.toast('Stopped everything — the chain is halted', 'ok');
    return { ok: true };
  }

  /** One run control: POST, toast the outcome, re-fold the team. */
  private async runControl(path: string, payload: unknown, done: string): Promise<McReply> {
    const body = await this.client.request<Record<string, unknown>>('POST', path, payload).catch(fail);
    if (isFailure(body)) {
      this.toast(body.error, 'error');
      return body;
    }
    if (body['ok'] !== true) {
      const refused = refusal(body, 'the desk did not take that');
      this.toast(refused.error, 'error');
      return refused;
    }
    await this.refreshTeam();
    this.toast(done, 'ok');
    return { ok: true };
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
        // The turn's reply carries the failure (the card shows why); the
        // stream's error is no reply text.
        this.tail = null;
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
    this.appendMessage({
      role: 'mission',
      text: delta.text,
      thought: delta.thought,
      at: new Date().toISOString(),
    });
  }

  private appendMessage(message: {
    role: 'owner' | 'mission';
    text: string;
    thought: string | null;
    at: string;
  }): void {
    this.chat.update((chat) => {
      const active = chat.active;
      return active === null
        ? chat
        : { ...chat, active: { ...active, messages: [...active.messages, message] } };
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
          const grown = {
            ...last,
            text: say === '' ? last.text : say,
            thought: thought ?? last.thought,
          };
          return {
            ...chat,
            active: { ...active, messages: [...active.messages.slice(0, -1), grown] },
          };
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
