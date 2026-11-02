import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { ChatMessageView, SessionMeta } from '../api/dto';
import { McState } from '../api/state';

// ---------------------------------------------------------------------------
// Pure view logic (spec'd in chat.spec.ts)
// ---------------------------------------------------------------------------

/**
 * The proposal slice `timelineOf` interleaves. The api layer's
 * `ChatProposalView` is assignable as-is; `at`/`decidedAt` ride the desk's
 * session JSON and are forwarded here once the view DTO carries them (the
 * parent reconciles) — until then the timeline falls back to array order.
 */
export interface TimelineProposal {
  readonly id: string;
  readonly state: 'pending' | 'confirmed' | 'dismissed';
  readonly summary: string;
  readonly outcome: string | null;
  /** ISO stamp of the proposal; empty/missing when the view dropped it. */
  readonly at?: string;
  /** ISO stamp of the decision; null while pending (or when dropped). */
  readonly decidedAt?: string | null;
}

/** The session slice the merged timeline renders. */
export interface TimelineSession {
  readonly messages: readonly ChatMessageView[];
  readonly proposals: readonly TimelineProposal[];
}

/**
 * The merged session timeline: messages and proposals in one list.
 * A pending proposal is a card between the messages; a decided one is a
 * one-line history entry. When every proposal carries its arrival stamps
 * (the desk's session JSON has them) the list is interleaved by order of
 * arrival — a decision lands at its decision time, where the session file
 * appends it; without stamps the deterministic fallback keeps the file's
 * array order: the messages, then the proposals as proposal/decision items.
 */
export type ChatTimelineItem =
  | { readonly kind: 'message'; readonly at: string; readonly message: ChatMessageView }
  | { readonly kind: 'proposal'; readonly at: string; readonly proposal: TimelineProposal }
  | { readonly kind: 'decision'; readonly at: string; readonly proposal: TimelineProposal };

export function timelineOf(session: TimelineSession): ChatTimelineItem[] {
  const proposals = session.proposals;
  const stamped = proposals.every((proposal) => typeof proposal.at === 'string' && proposal.at !== '');
  if (!stamped) {
    return [
      ...session.messages.map((message, index) => ({ kind: 'message' as const, at: atOf(message, index), message })),
      ...proposals.map((proposal) => itemOf(proposal)),
    ];
  }
  const items: ChatTimelineItem[] = session.messages.map((message, index) => ({
    kind: 'message',
    at: atOf(message, index),
    message,
  }));
  for (const proposal of proposals) {
    items.push(itemOf(proposal));
  }
  // ISO stamps sort lexicographically. Equal stamps keep file order: the
  // mission line precedes its proposal line in the session file.
  const rank = (item: ChatTimelineItem): number => (item.kind === 'message' ? 0 : item.kind === 'proposal' ? 1 : 2);
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank(a) - rank(b)));
}

function atOf(message: ChatMessageView, index: number): string {
  return message.at !== '' ? message.at : `${index}`;
}

function itemOf(proposal: TimelineProposal): ChatTimelineItem {
  if (proposal.state === 'pending') {
    return { kind: 'proposal', at: typeof proposal.at === 'string' && proposal.at !== '' ? proposal.at : '', proposal };
  }
  const decidedAt = proposal.decidedAt;
  return {
    kind: 'decision',
    at: typeof decidedAt === 'string' && decidedAt !== '' ? decidedAt : typeof proposal.at === 'string' ? proposal.at : '',
    proposal,
  };
}

/**
 * True while the mission's reply is still incoming and nothing of it has
 * arrived yet — the waiting ellipsis over the message list. `turnInFlight`
 * spans the whole turn: the state's send resolves only when the mission's
 * answer is complete, while the streamed text lands in the messages.
 */
export function isTurnStreaming(
  messages: readonly Pick<ChatMessageView, 'role'>[],
  turnInFlight: boolean,
): boolean {
  if (!turnInFlight) {
    return false;
  }
  const last = messages[messages.length - 1];
  return last === undefined || last.role === 'owner';
}

/** The composer grows with the draft, up to `max` rows. */
export function composerRowsOf(text: string, max = 5): number {
  const lines = text === '' ? 1 : text.split('\n').length;
  return Math.min(Math.max(lines, 1), max);
}

/**
 * Relative age words for the session rows: `now` under 45 s, then minutes,
 * then hours; `yesterday` for the previous calendar day, else `<n> d`.
 */
export function relativeAge(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '';
  }
  const delta = Math.max(0, nowMs - at);
  if (delta < 45_000) {
    return 'now';
  }
  if (delta < 3_600_000) {
    return `${Math.floor(delta / 60_000)} min`;
  }
  if (delta < 86_400_000) {
    return `${Math.floor(delta / 3_600_000)} h`;
  }
  const startOfDay = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(nowMs) - startOfDay(at)) / 86_400_000);
  if (days <= 1) {
    return 'yesterday';
  }
  return `${days} d`;
}

/**
 * The error sentence of a send/confirm/dismiss reply, for inline display.
 * `McReply` is `{ ok: true } | { ok: false; error }`; anything else without
 * a readable failure counts as no error.
 */
export function errorOf(result: unknown): string | null {
  if (result === null || typeof result !== 'object') {
    return null;
  }
  const r = result as { ok?: unknown; error?: unknown };
  if (r.ok === true) {
    return null;
  }
  if (typeof r.error === 'string' && r.error.trim() !== '') {
    return r.error;
  }
  return r.ok === false ? 'Something went wrong — try again.' : null;
}

// ---------------------------------------------------------------------------
// The chat tab (concept §6/§7)
// ---------------------------------------------------------------------------

/**
 * The chat tab's slice of the app state. Provided by the shell once, shared
 * with the other tabs; until the shell wires it, the tab renders against a
 * fresh disconnected `McState` (empty list, honest refusal errors).
 */
export const MC_CHAT_STATE = new InjectionToken<McState>('mc-chat-state');

type ChatViewMode = 'list' | 'composer' | 'session';

const NO_MESSAGES: readonly ChatMessageView[] = [];

/**
 * Mission Control's chat: one column holding the session list and the open
 * session. The list rows open a session; a primary New chat drops into the
 * composer for the first message. The session shows the merged timeline —
 * owner bubbles right (accent), mission left, the thinking trace folded to
 * a dim `thought …` line expandable on tap, pending proposals as cards
 * between the messages with Confirm/Dismiss, decisions as dim history —
 * and the composer below: Enter sends, Shift+Enter newline, the send
 * button idles while the mission's turn runs. The attach button is a
 * placeholder wired to nothing until E5c.
 */
@Component({
  selector: 'mc-chat',
  templateUrl: './chat.html',
  styleUrl: './chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Chat {
  protected readonly state: McState = inject(MC_CHAT_STATE, { optional: true }) ?? new McState();

  /** The session view suppresses the state's active session (back to the list). */
  private readonly closed = signal(false);
  private readonly composing = signal(false);
  private readonly draft = signal('');
  /** A turn (newSession/send) spans the mission's whole answer. */
  private readonly sending = signal(false);
  private readonly composerError = signal<string | null>(null);
  private readonly listError = signal<string | null>(null);
  private readonly cardErrors = signal<Readonly<Record<string, string>>>({});
  private readonly cardBusy = signal<Readonly<Record<string, boolean>>>({});
  private readonly openThoughts = signal<readonly string[]>([]);

  protected readonly viewMode = computed<ChatViewMode>(() =>
    this.composing() ? 'composer' : this.active() !== null && !this.closed() ? 'session' : 'list',
  );
  protected readonly sessions = computed<readonly SessionMeta[]>(() => this.state.chat().sessions);
  protected readonly active = computed(() => this.state.chat().active);
  protected readonly activeTitle = computed(() => this.active()?.title ?? '');
  protected readonly timeline = computed<ChatTimelineItem[]>(() => {
    const active = this.active();
    return active === null ? [] : timelineOf(active);
  });
  /** The waiting ellipsis: a turn runs and no mission text has landed yet. */
  protected readonly streaming = computed(() => isTurnStreaming(this.messages(), this.sending()));
  protected readonly canSend = computed(() => !this.sending() && this.draft().trim() !== '');
  protected readonly rows = computed(() => composerRowsOf(this.draft()));

  private readonly messages = computed<readonly Pick<ChatMessageView, 'role'>[]>(
    () => this.active()?.messages ?? NO_MESSAGES,
  );

  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  /** Keep the thread pinned to the newest line while it grows or streams. */
  private readonly pinToNewest = effect(() => {
    this.timeline();
    this.streaming();
    const el = this.thread()?.nativeElement;
    if (el !== undefined) {
      el.scrollTop = el.scrollHeight;
    }
  });

  // -- session list ---------------------------------------------------------

  protected async openSession(file: string): Promise<void> {
    this.listError.set(null);
    this.closed.set(false);
    this.composing.set(false);
    try {
      await this.state.openSession(file);
    } catch (err) {
      this.listError.set(errorText(err));
    }
  }

  protected newChat(): void {
    this.composing.set(true);
    this.closed.set(true);
    this.draft.set('');
    this.composerError.set(null);
  }

  protected back(): void {
    if (this.composing()) {
      // Leaving the composer returns to the session it was opened from.
      this.composing.set(false);
      this.closed.set(false);
      return;
    }
    this.closed.set(true);
  }

  // -- composer -------------------------------------------------------------

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (this.canSend()) {
      void this.send();
    }
  }

  protected async send(): Promise<void> {
    const text = this.draft().trim();
    if (text === '' || !this.canSend()) {
      return;
    }
    this.composerError.set(null);
    this.sending.set(true);
    try {
      const starting = this.viewMode() === 'composer';
      const reply = starting ? await this.state.newSession(text) : await this.state.send(text);
      const error = errorOf(reply);
      if (error !== null) {
        this.composerError.set(error);
        return;
      }
      this.draft.set('');
      if (starting) {
        // McState opens the fresh session itself; show it.
        this.composing.set(false);
        this.closed.set(false);
      }
    } catch (err) {
      this.composerError.set(errorText(err));
    } finally {
      this.sending.set(false);
    }
  }

  // -- the merged timeline --------------------------------------------------

  protected toggleThought(message: ChatMessageView): void {
    const at = message.at;
    this.openThoughts.update((open) =>
      open.includes(at) ? open.filter((key) => key !== at) : [...open, at],
    );
  }

  protected isThoughtOpen(message: ChatMessageView): boolean {
    return this.openThoughts().includes(message.at);
  }

  protected confirm(id: string): Promise<void> {
    const file = this.active()?.file;
    return file === undefined ? Promise.resolve() : this.decide(id, (state) => state.confirm(file, id));
  }

  protected dismiss(id: string): Promise<void> {
    const file = this.active()?.file;
    return file === undefined ? Promise.resolve() : this.decide(id, (state) => state.dismiss(file, id));
  }

  private async decide(id: string, call: (state: McState) => Promise<unknown>): Promise<void> {
    this.cardErrors.update((current) => ({ ...current, [id]: '' }));
    this.cardBusy.update((current) => ({ ...current, [id]: true }));
    try {
      const error = errorOf(await call(this.state));
      if (error !== null) {
        this.cardErrors.update((current) => ({ ...current, [id]: error }));
      }
    } catch (err) {
      this.cardErrors.update((current) => ({ ...current, [id]: errorText(err) }));
    } finally {
      this.cardBusy.update((current) => ({ ...current, [id]: false }));
    }
  }

  protected cardError(id: string): string | null {
    const value = this.cardErrors()[id];
    return value === undefined || value === '' ? null : value;
  }

  protected isCardBusy(id: string): boolean {
    return this.cardBusy()[id] === true;
  }

  // -- template helpers -----------------------------------------------------

  protected relativeAge(iso: string): string {
    return relativeAge(iso, Date.now());
  }

  protected trackOf(item: ChatTimelineItem, index: number): string {
    return `${item.kind}:${item.kind === 'message' ? item.message.at : item.proposal.id}:${index}`;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message.trim() !== '' ? err.message : 'Something went wrong — try again.';
}
