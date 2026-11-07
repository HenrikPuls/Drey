import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { AppBar } from '../app-bar/app-bar';
import { MC_WORK_STATE, questionCardOf, ticketPersonaOf, type McBoard, type QuestionCardVm } from '../work/work.model';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { AnswerCard, type AnswerOption } from '../phone/answer-card';
import { PhoneAvatar } from '../phone/avatar';
import { PhoneIcon } from '../phone/icon';
import { padSignal, touchFaceSignal } from '../phone/phone';
import { PadCards } from '../shell/pad-card';

import { COMPOSER_PLACEHOLDER } from '../../../../shared/composer-placeholder';
import { Dictation, browserDictationEnv, clockOf } from './dictation';
import { PlanPane } from '../plan/plan-pane';
import { MC_PLAN_STATE, planRowSubtitleOf, planSectionOf, splitLabelOf } from '../plan/plan.model';
import {
  MC_CHAT_STATE,
  disconnectedChatState,
  type McChatState,
} from './chat.model';
import { parseBoardCard, type ChatMessageView, type McChainEntry, type SessionMeta } from '../api/dto';
import {
  chainStepsOf,
  parseChainEntryView,
  planChipOf,
  type ChainEntryView,
  type GatePhase,
  type GateStep,
} from '../ticket/ticket.model';

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
  /**
   * E9 (concept §5.7): the setChain command the card wraps — the
   * before/after confirmation renders the proposed delta from it.
   */
  readonly chain?: { readonly id: string; readonly chain: readonly string[] };
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
  return message.at !== '' ? message.at : `${index}`;
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

// --- the setChain before/after card (E9, concept §5.7) ----------------------------

/** The two merged gate chains a setChain proposal card renders. */
export interface ChainCompare {
  /** The merge with the ticket's current delta (the board card's `chain:`). */
  readonly before: readonly GateStep[];
  /** The merge with the proposed delta — the proposal command's entries. */
  readonly after: readonly GateStep[];
}

/**
 * The before/after the confirmation card shows before the owner commits
 * a chain change: both merges render through the same tolerant merger
 * the ticket screen's gate bar uses (standard flow + delta). Proposed
 * entries the grammar does not read drop out — the desk refuses them the
 * same way at execution, never a guess here.
 */
export function chainCompareOf(
  phases: readonly GatePhase[],
  currentPhaseId: string,
  current: readonly McChainEntry[],
  proposed: readonly string[],
): ChainCompare {
  const afterEntries = proposed
    .map((entry) => parseChainEntryView(entry))
    .filter((entry): entry is ChainEntryView => entry !== null);
  return {
    before: chainStepsOf(phases, currentPhaseId, current),
    after: chainStepsOf(phases, currentPhaseId, afterEntries),
  };
}

/** The composer grows with the draft, up to `max` rows. */
export function composerRowsOf(text: string, max = 5): number {
  const lines = text === '' ? 1 : text.split('\n').length;
  return Math.min(Math.max(lines, 1), max);
}

// --- the attach sheet (concept §6, the composer's attach slot) -----------------

/** One picked file's chip above the composer: the name and its thumbnail URL (null = none). */
export interface AttachmentChip {
  readonly name: string;
  readonly url: string | null;
}

/** The file path's last segment — `tickets/attachments/img-….png` → `img-….png`. */
export function basenameOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * The upload-success toast: one attachment or several, with the names the
 * desk minted. The `warn` tint is deliberate — the files are laid down
 * under `tickets/attachments/`, nothing was sent into the session.
 */
export function attachmentToastOf(stored: readonly string[]): { message: string; kind: 'warn' } {
  const names = stored.map(basenameOf).join(', ');
  return {
    message: stored.length === 1 ? `File attached: ${names}` : `${stored.length} files attached: ${names}`,
    kind: 'warn',
  };
}

/** An object URL for an image file's thumbnail; null for non-images or where the platform has none. */
export function thumbnailUrlOf(file: File): string | null {
  if (!file.type.startsWith('image/')) {
    return null;
  }
  try {
    return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
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

/** One history group: a day label and the sessions updated on it. */
export interface HistoryGroup {
  readonly label: 'Today' | 'Yesterday' | 'Earlier';
  readonly entries: readonly SessionMeta[];
}

/**
 * The history list's groups (phone menu, desktop dock): sessions newest
 * first, grouped by the calendar day of their last update, narrowed by a
 * case-insensitive title filter. Empty groups are left out.
 */
export function historyGroupsOf(
  sessions: readonly SessionMeta[],
  nowMs: number,
  query: string,
): readonly HistoryGroup[] {
  const needle = query.trim().toLowerCase();
  const startOfDay = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(nowMs);
  const buckets: Record<HistoryGroup['label'], SessionMeta[]> = { Today: [], Yesterday: [], Earlier: [] };
  const sorted = [...sessions]
    .filter((session) => needle === '' || session.title.toLowerCase().includes(needle))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const session of sorted) {
    const at = Date.parse(session.updatedAt);
    const days = Number.isNaN(at) ? 2 : Math.round((today - startOfDay(at)) / 86_400_000);
    buckets[days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : 'Earlier'].push(session);
  }
  return (['Today', 'Yesterday', 'Earlier'] as const)
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, entries: buckets[label] }));
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

// --- the proposal cards' rich bodies (prototype convergence) -----------------

/**
 * The card detail read off a proposal's summary sentence. The desk's
 * `summaryOf` (chat-service) minting is deterministic English, so the
 * fields the rich cards show — the transition's from/to, the create's
 * title/phase, the blocker ids, the priority word — parse back out of it.
 * The wire's raw `command` block is not carried in the view DTO for these
 * kinds (only setChain rides along as `chain`), so the summary is the
 * parseable source; anything that does not match reads as null and the
 * card falls back to the summary line — never a guess.
 */
export type ProposalDetail =
  | { readonly kind: 'transition'; readonly id: string; readonly from: string; readonly to: string }
  | { readonly kind: 'create'; readonly title: string; readonly phase: string }
  | { readonly kind: 'blocked'; readonly id: string; readonly ids: readonly string[] }
  | { readonly kind: 'priority'; readonly id: string; readonly to: string }
  | { readonly kind: 'promote'; readonly id: string };

const TRANSITION_SUMMARY = /^Move (\S+) from (\S+) to (\S+)$/;
const CREATE_SUMMARY = /^Create ticket "([^"]+)" in (\S+)$/;
const BLOCKED_SUMMARY = /^Block (\S+) by (.+)$/;
const CLEARED_SUMMARY = /^Clear (\S+) blockers$/;
const PRIORITY_SUMMARY = /^Set (\S+) priority to (\S+)$/;
const PROMOTE_SUMMARY = /^Promote (\S+) to a ship ticket$/;

export function proposalDetailOf(summary: string): ProposalDetail | null {
  let match = TRANSITION_SUMMARY.exec(summary);
  if (match !== null) {
    return { kind: 'transition', id: match[1]!, from: match[2]!, to: match[3]! };
  }
  match = CREATE_SUMMARY.exec(summary);
  if (match !== null) {
    return { kind: 'create', title: match[1]!, phase: match[2]! };
  }
  match = BLOCKED_SUMMARY.exec(summary);
  if (match !== null) {
    const ids = match[2]!
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    return { kind: 'blocked', id: match[1]!, ids };
  }
  match = CLEARED_SUMMARY.exec(summary);
  if (match !== null) {
    return { kind: 'blocked', id: match[1]!, ids: [] };
  }
  match = PRIORITY_SUMMARY.exec(summary);
  if (match !== null) {
    return { kind: 'priority', id: match[1]!, to: match[2]! };
  }
  match = PROMOTE_SUMMARY.exec(summary);
  if (match !== null) {
    return { kind: 'promote', id: match[1]! };
  }
  return null;
}

/**
 * The tickets directory a `createTicket` card's diffbox names for its
 * target phase. Resolution reuses before it derives — the engine's
 * phase-dirs rule: a sibling ticket's file path in that phase's column
 * names the directory the desk actually uses; without a sibling the
 * derived `NN-<id>` name is what the writer creates on first use. A phase
 * the board does not know yields null — the card then omits the path line.
 */
export function phaseDirOf(board: unknown, phaseId: string): string | null {
  if (phaseId === '') {
    return null;
  }
  const body = recOf(board);
  const columns = Array.isArray(body?.['columns']) ? (body!['columns'] as readonly unknown[]) : [];
  for (let index = 0; index < columns.length; index++) {
    const column = recOf(columns[index]);
    const phase = recOf(column?.['phase']);
    if (column === null || phase === null || phase['id'] !== phaseId) {
      continue;
    }
    const tickets = Array.isArray(column['tickets']) ? (column['tickets'] as readonly unknown[]) : [];
    for (const raw of tickets) {
      const card = recOf(raw);
      const path = typeof card?.['path'] === 'string' ? card['path'] : '';
      const match = /^tickets\/([^/]+)\//.exec(path);
      if (match !== null) {
        return match[1]!;
      }
    }
    return phaseDirectoryName(index + 1, phaseId);
  }
  return null;
}

/** The engine's derived directory name (`phaseDirectoryName`, mirrored). */
function phaseDirectoryName(position1: number, id: string): string {
  return `${String(position1 * 10).padStart(2, '0')}-${id}`;
}

/**
 * A ticket's current priority off the raw board JSON — the "from" side of
 * a setPriority card's before/after line; null when the board holds no
 * such card or the card carries no readable priority.
 */
export function cardPriorityOf(board: unknown, id: string): string | null {
  const body = recOf(board);
  const columns = Array.isArray(body?.['columns']) ? (body!['columns'] as readonly unknown[]) : [];
  for (const raw of columns) {
    const column = recOf(raw);
    const tickets = Array.isArray(column?.['tickets']) ? (column!['tickets'] as readonly unknown[]) : [];
    for (const ticket of tickets) {
      const card = recOf(ticket);
      if (card === null || card['id'] !== id) {
        continue;
      }
      const meta = recOf(card['meta']);
      const priority = meta?.['priority'];
      return typeof priority === 'string' && priority !== '' ? priority : null;
    }
  }
  return null;
}

function recOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// --- the thinking trace's fold (prototype convergence) -----------------------

/**
 * The measured think duration's label — `2,4 s` — or null while it is not
 * measurable: no window, an inverted one, or a reply that started with
 * text at once (nothing measurable happened).
 */
export function thinkSecondsLabel(startMs: number | null, endMs: number | null): string | null {
  if (startMs === null || endMs === null || endMs < startMs) {
    return null;
  }
  const seconds = (endMs - startMs) / 1000;
  if (seconds < 0.1) {
    return null;
  }
  return `${seconds.toFixed(1).replace('.', ',')} s`;
}

/** The fold's summary line: with the measured duration, else without. */
export function thinkFoldLabel(seconds: string | null): string {
  return seconds === null ? 'Thought' : `Thought · ${seconds}`;
}

// ---------------------------------------------------------------------------
// The chat tab (concept §6/§7)
// ---------------------------------------------------------------------------

/**
 * The chat tab's slice of the app state lives in `./chat.model` (the
 * `McChatState` contract and the `MC_CHAT_STATE` token) — this component
 * consumes the token, never the app's state store directly.
 */

type ChatViewMode = 'empty' | 'composer' | 'session';

/** Distance from the bottom inside which the pin still counts as "at the end". */
const FOLLOW_SLACK_PX = 32;

const NO_MESSAGES: readonly ChatMessageView[] = [];

/** One sheet row the sessions sheet renders. */
interface SheetEntry {
  readonly file: string;
  readonly title: string;
}

/**
 * Mission Control's chat in the prototype's dress (#v-chat): a fixed
 * column — header with the title and the two 34 px icon buttons (sessions
 * sheet, new chat) on top, the merged timeline scrolling alone in the
 * middle, the composer pinned below — the owner bubbles right, mission
 * left with the thinking trace, live as a dim mono stream with a blinking
 * accent cursor and folded to a `▸ Thought` details after the turn
 * (measured first-thought → first-text when measurable) — pending
 * proposals as rich confirmation cards between the messages
 * (chain before/after strips, transition arrow, create diffbox, blocker
 * and priority lines) with Discard/Confirm and the toast feedback,
 * decided ones as mint done-cards with the engine's outcome line, and the
 * composer below: Enter sends, Shift+Enter newline, the circle send idles
 * while the mission's turn runs, and the attach circle opens the 'Attachment'
 * sheet — 'Photo or camera' and 'Choose a file' — whose picks upload
 * through the state's `uploadAttachment` (a host without it keeps the
 * button disabled). Success lays chips (name, thumbnail) above the
 * composer until the next send and fires the warn toast naming what the
 * desk stored under `tickets/attachments/` — a failure shows inline at
 * the composer plus an error toast. The upload is display-only: nothing
 * rides the message; the desk links attachments where its ticket-upload
 * context does.
 *
 * The sessions sheet lists every session file as a row (title, mono age,
 * pending badge; the open one marked cur + `offen`). Opening a session
 * that is not the pane's live one shows it read-only — the composer dims,
 * a warn toast says so; no backend change switches the desk's pointer, the
 * lock is this tab's honest presentation (the desk itself would take a
 * send for any file). `New chat` opens the composer for a fresh session.
 */
@Component({
  selector: 'mc-chat',
  templateUrl: './chat.html',
  styleUrls: ['../phone/kit.css', './chat.css', './phone.css', './pad.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, PlanPane, AppBar, AnswerCard, McI18nPipe, PhoneAvatar, PhoneIcon],
})
export class Chat {
  protected readonly state: McChatState =
    inject(MC_CHAT_STATE, { optional: true }) ?? disconnectedChatState();

  /**
   * The report card's promote (E8) fills the one-shot draft prefill and
   * switches to this tab — the tab switch mounts this component, and the
   * constructor adopts what waits: the draft carries the command, and a
   * fresh composer opens when no session is open (with one, the draft
   * sits in that session's composer — the send routes there).
   */
  constructor() {
    if (this.state.chatMenu?.() === true) {
      this.state.chatMenu.set(false);
      this.sheetOpen.set(true);
    }
    this.adoptPrefill();
    // The iPad's chat pane stays mounted: a prefill that arrives later
    // ("Ask about this note", a promote) is adopted the same way.
    effect(() => {
      if (this.state.chatPrefill() !== null) {
        untracked(() => this.adoptPrefill());
      }
    });
  }

  private adoptPrefill(): void {
    const prefill = this.state.chatPrefill();
    if (prefill !== null) {
      this.state.chatPrefill.set(null);
      this.draft.set(prefill);
      if (this.active() === null) {
        this.composing.set(true);
      }
    }
  }

  private readonly composing = signal(false);
  /** The composer's ghost text — the same string as Drey's Assistant panel (D-7e). */
  protected readonly placeholder = COMPOSER_PLACEHOLDER;
  private readonly draft = signal('');
  /**
   * The microphone (E12-8): interim speech fills the draft live, the final
   * text stays editable and is never sent for the owner.
   */
  protected readonly dictation = new Dictation(browserDictationEnv(), (text) => this.draft.set(text));
  protected readonly clockOf = clockOf;
  /** The recording indicator's bars (heights in a 24-high box); the animation moves them. */
  protected readonly waveBars: readonly number[] = [6, 12, 20, 10, 16, 6, 22, 12, 8, 18, 10, 4, 14, 6, 10, 4, 8, 14, 6];
  private readonly dictationCleanup = ((): void => {
    const stopHidden = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.dictation.stop();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', stopHidden);
    }
    inject(DestroyRef).onDestroy(() => {
      this.dictation.cancel();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', stopHidden);
      }
    });
  })();
  /** A turn (newSession/send) spans the mission's whole answer. */
  private readonly sending = signal(false);
  private readonly composerError = signal<string | null>(null);
  private readonly sheetError = signal<string | null>(null);
  private readonly cardErrors = signal<Readonly<Record<string, string>>>({});
  private readonly cardBusy = signal<Readonly<Record<string, boolean>>>({});
  /** Cards dimmed by a dismiss tap before the desk's reconcile lands. */
  private readonly dimmedCards = signal<Readonly<Record<string, boolean>>>({});
  /** Whether the sessions sheet is up. */
  protected readonly sheetOpen = signal(false);
  /** The history list's search text. */
  protected readonly historyQuery = signal('');
  /** Whether the attach sheet is up. */
  protected readonly attachSheetOpen = signal(false);
  /** True while the picked files are still on their way to the desk. */
  protected readonly uploading = signal(false);
  /** The laid-down files' chips above the composer — until the next send. */
  protected readonly attachments = signal<readonly AttachmentChip[]>([]);
  /**
   * The pane's live (continuable) session file; null until one opens.
   * A session opened from the sheet that is not this one shows read-only.
   */
  private readonly liveFile = signal<string | null>(null);

  protected readonly viewMode = computed<ChatViewMode>(() =>
    this.composing() ? 'composer' : this.active() !== null ? 'session' : 'empty',
  );
  protected readonly sessions = computed<readonly SessionMeta[]>(() => this.state.chat().sessions);
  protected readonly active = computed(() => this.state.chat().active);
  protected readonly timeline = computed<ChatTimelineItem[]>(() => {
    const active = this.active();
    return active === null ? [] : timelineOf(active);
  });
  /**
   * True while a session is shown that is not the pane's live one: the
   * read-only view (composer dimmed, no send). The desk holds no session
   * pointer to switch — this is the tab's own, honest lock.
   */
  protected readonly readOnly = computed(() => {
    const live = this.liveFile();
    const active = this.active();
    return this.viewMode() === 'session' && live !== null && active !== null && active.file !== live;
  });
  /** The history list below the live row: the other sessions by day, filtered. */
  protected readonly historyGroups = computed<readonly HistoryGroup[]>(() => {
    const live = this.liveEntry()?.file ?? null;
    return historyGroupsOf(
      this.sessions().filter((session) => session.file !== live),
      Date.now(),
      this.historyQuery(),
    );
  });
  /** The live row shows unless the search filters it out. */
  protected readonly liveVisible = computed(() => {
    const live = this.liveEntry();
    const needle = this.historyQuery().trim().toLowerCase();
    return live !== null && (needle === '' || live.title.toLowerCase().includes(needle));
  });
  /** The sheet's first row: the pane's live session, whatever it is named. */
  protected readonly liveEntry = computed<SheetEntry | null>(() => {
    const live = this.liveFile();
    if (live === null) {
      return null;
    }
    const meta = this.sessions().find((session) => session.file === live);
    return { file: live, title: meta?.title ?? 'Current conversation' };
  });

  /**
   * The pipeline as the chain strips merge it — board order, the
   * checkpoints marked (the raw board JSON carries the checkpoint ids).
   */
  private readonly chainPhases = computed<readonly GatePhase[]>(() => {
    const raw = this.state.board() as { checkpoints?: readonly unknown[] } | null;
    const marks = new Set(
      Array.isArray(raw?.checkpoints)
        ? raw.checkpoints.filter((mark): mark is string => typeof mark === 'string')
        : [],
    );
    return this.state.work().groups.map((group) => ({
      id: group.id,
      title: group.title,
      checkpoint: marks.has(group.id),
    }));
  });
  /**
   * The error card (D-1): provider, endpoint and reason of the turn that
   * found no model, with a headline per kind. The speaker is Paul in a
   * shape session, Pia otherwise.
   */
  protected readonly failure = computed(() => {
    const failure = this.state.chatFailure?.() ?? null;
    if (failure === null || (failure.file !== undefined && failure.file !== this.active()?.file)) {
      return null;
    }
    const who = this.shape() === null ? 'Pia' : 'Paul';
    const headline: Record<typeof failure.code, string> = {
      'not-configured': `${who} has no model yet`,
      unsupported: `${who} cannot use this provider`,
      unreachable: `${who} cannot reach the model`,
      refused: `The model refused ${who}'s request`,
      timeout: `The model took too long for ${who}`,
    };
    return { ...failure, headline: headline[failure.code] };
  });

  protected dismissFailure(): void {
    this.state.chatFailure?.set(null);
  }

  /** The waiting ellipsis: no mission text has landed yet this turn. */
  protected readonly streaming = computed(() => {
    if (!this.sending()) {
      return false;
    }
    if (isTurnStreaming(this.messages(), true)) {
      return true;
    }
    // A live reply whose first chunk was empty still waits visibly.
    const last = this.messages()[this.messages().length - 1];
    return last !== undefined && last.text === '' && (last.thought ?? '') === '';
  });
  protected readonly canSend = computed(() => !this.sending() && this.draft().trim() !== '');
  protected readonly rows = computed(() => composerRowsOf(this.draft()));
  /**
   * The attach button's gate: read-only never uploads, an in-flight upload
   * waits, and a host that wires no `uploadAttachment` keeps the button
   * disabled — the honest placeholder it was before the sheet existed.
   */
  protected readonly attachDisabled = computed(
    () => this.readOnly() || this.uploading() || this.state.uploadAttachment === undefined,
  );

  private readonly messages = computed<readonly ChatMessageView[]>(
    () => this.active()?.messages ?? NO_MESSAGES,
  );

  /** The mission reply the mission turn before this one ended with. */
  private priorReply: ChatMessageView | null = null;

  private readonly latestMission = computed<ChatMessageView | null>(() => {
    const messages = this.messages();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role === 'mission') {
        return message;
      }
    }
    return null;
  });

  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  /**
   * True while the pin follows the newest line: the thread sits at (or
   * near) the bottom. A deliberate scroll up stops the yank — stream
   * deltas then land below the fold without moving the view; scrolling
   * back to the bottom re-arms the pin.
   */
  private readonly follow = signal(true);

  /** The thread's scroll listener: keeps the follow flag honest. */
  protected onThreadScroll(): void {
    const el = this.thread()?.nativeElement;
    if (el === undefined) {
      return;
    }
    this.follow.set(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX);
  }

  /** Keep the thread pinned to the newest line while it grows or streams. */
  private readonly pinToNewest = effect(() => {
    this.timeline();
    this.streaming();
    this.linkedPick();
    this.picked();
    const file = this.active()?.file ?? null;
    if (file !== this.lastPinnedFile) {
      // A session switch (or the thread's first mount) always shows the
      // latest line — the follow gate is only for reading history.
      this.lastPinnedFile = file;
      this.follow.set(true);
    }
    const el = this.thread()?.nativeElement;
    if (el !== undefined && this.follow()) {
      el.scrollTop = el.scrollHeight;
      // The phone's answer card grows after this pass: its Send button appears on a mark.
      if (this.phone()) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
  });
  private lastPinnedFile: string | null = null;

  /** The pane's first session is its live one (a booted state may carry one). */
  private readonly adoptLive = effect(() => {
    const file = this.active()?.file ?? null;
    if (file !== null && this.liveFile() === null) {
      this.liveFile.set(file);
    }
    if (file !== this.lastActiveFile) {
      // A session switch invalidates the transient card dims.
      this.lastActiveFile = file;
      this.dimmedCards.set({});
    }
  });
  private lastActiveFile: string | null = null;

  // -- the thinking trace's measurement ---------------------------------------

  /** The in-flight reply's stamp the measurement window is keyed to. */
  private readonly thinkKey = signal<string | null>(null);
  private readonly thinkStartMs = signal<number | null>(null);
  private readonly thinkEndMs = signal<number | null>(null);
  /** First thought delta → first text delta, measured while the turn runs. */
  protected readonly thinkSeconds = computed(() => thinkSecondsLabel(this.thinkStartMs(), this.thinkEndMs()));

  /**
   * Measures the think window off the streamed deltas (the state's SSE
   * fold grows the last message; nothing here touches the state): the
   * window opens when the reply's thought first shows text and closes
   * when its text arrives. A new in-flight reply resets the window; the
   * finished fold keeps the last measurement.
   */
  private readonly measureThink = effect(() => {
    if (!this.sending()) {
      return;
    }
    const last = this.messages()[this.messages().length - 1];
    if (last === undefined || last.role !== 'mission') {
      return;
    }
    if (this.thinkKey() !== last.at) {
      this.thinkKey.set(last.at);
      this.thinkStartMs.set(null);
      this.thinkEndMs.set(null);
    }
    const now = Date.now();
    if ((last.thought ?? '') !== '' && this.thinkStartMs() === null) {
      this.thinkStartMs.set(now);
    }
    if (last.text !== '' && this.thinkEndMs() === null) {
      this.thinkEndMs.set(now);
    }
  });

  // -- the sessions sheet -------------------------------------------------------

  protected openSessions(): void {
    this.sheetError.set(null);
    this.attachSheetOpen.set(false);
    this.sheetOpen.set(true);
  }

  protected closeSheet(): void {
    this.sheetOpen.set(false);
    this.historyQuery.set('');
  }

  protected onHistoryQuery(event: Event): void {
    this.historyQuery.set((event.target as HTMLInputElement).value);
  }

  /**
   * Opens one session from the sheet. The pane's live session (or the
   * first one ever opened) opens continuable; any other shows read-only —
   * composer dimmed and the warn toast, no backend change behind it.
   */
  protected async openFromSheet(entry: SheetEntry): Promise<void> {
    const live = this.liveFile();
    const viewed = this.active()?.file ?? null;
    const goingLive = live === null || entry.file === live;
    this.composing.set(false);
    this.sheetOpen.set(false);
    this.sheetError.set(null);
    if (!goingLive) {
      this.toast(`Session opened: ${entry.title} — read-only`, 'warn');
    }
    await this.state.openSession(entry.file);
    if (this.active()?.file !== entry.file) {
      // openSession clears the pane when the desk has no such file.
      this.sheetError.set(`The session could not be opened: ${entry.title}`);
      this.sheetOpen.set(true);
      return;
    }
    if (goingLive) {
      this.liveFile.set(entry.file);
      if (live !== null && viewed !== live) {
        this.toast('Back in the current conversation');
      }
    }
  }

  /** The header's `New chat`: a fresh session's composer. */
  protected newChat(): void {
    this.sheetOpen.set(false);
    this.attachSheetOpen.set(false);
    this.composing.set(true);
    this.state.shapeTicket?.set(null);
    this.dictation.cancel();
    this.draft.set('');
    this.composerError.set(null);
    this.clearAttachments();
  }

  // -- the attach sheet (concept §6) -------------------------------------------

  private readonly attachImageInput = viewChild<ElementRef<HTMLInputElement>>('attachImageInput');
  private readonly attachFileInput = viewChild<ElementRef<HTMLInputElement>>('attachFileInput');

  protected openAttachSheet(): void {
    this.sheetOpen.set(false);
    this.sheetError.set(null);
    this.attachSheetOpen.set(true);
  }

  protected closeAttachSheet(): void {
    this.attachSheetOpen.set(false);
  }

  /** The hidden input's picker opens; the picked files come back through `onPicked`. */
  protected pickImage(): void {
    this.attachImageInput()?.nativeElement.click();
  }

  protected pickFile(): void {
    this.attachFileInput()?.nativeElement.click();
  }

  /** The picker answered: take the files, reset the input so a re-pick fires again. */
  protected async onPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    await this.uploadPicked(files);
  }

  /**
   * Uploads through the state's `uploadAttachment`, busy while it runs.
   * Success lays the chips above the composer, fires the warn toast
   * naming what the desk stored and closes the sheet; a failure closes it
   * too — the error shows inline at the composer plus an error toast.
   */
  protected async uploadPicked(files: File[]): Promise<void> {
    const upload = this.state.uploadAttachment;
    if (upload === undefined || files.length === 0 || this.uploading()) {
      return;
    }
    this.composerError.set(null);
    this.uploading.set(true);
    try {
      // Called on the state — a detached reference would lose `this`.
      const reply = await this.state.uploadAttachment?.(files);
      if (reply === undefined) {
        return;
      }
      if (!reply.ok) {
        this.failUpload(reply.error);
        return;
      }
      this.attachments.update((current) => [
        ...current,
        ...files.map((file) => ({ name: file.name, url: thumbnailUrlOf(file) })),
      ]);
      const note = attachmentToastOf(reply.stored);
      this.toast(note.message, note.kind);
      this.attachSheetOpen.set(false);
    } catch (err) {
      this.failUpload(errorText(err));
    } finally {
      this.uploading.set(false);
    }
  }

  private failUpload(message: string): void {
    this.composerError.set(message);
    this.toast(message, 'error');
    this.attachSheetOpen.set(false);
  }

  /** Drops the chips and revokes their thumbnail URLs. */
  private clearAttachments(): void {
    for (const chip of this.attachments()) {
      if (chip.url === null) {
        continue;
      }
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(chip.url);
        }
      } catch {
        // the URL is already gone
      }
    }
    this.attachments.set([]);
  }

  // -- composer -------------------------------------------------------------

  protected onDraft(event: Event): void {
    // The owner's own typing ends a dictation: the engine's next result
    // would otherwise rebuild the draft from the text it started with.
    this.dictation.cancel();
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected toggleDictation(): void {
    this.dictation.toggle(this.draft());
  }

  /** Focus leaving the composer (not just moving between its controls) ends a dictation. */
  protected onComposerFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) {
      return;
    }
    this.dictation.stop();
  }

  protected onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (this.canSend() && !this.readOnly()) {
      void this.send();
    }
  }

  protected async send(): Promise<void> {
    this.dictation.cancel();
    const text = this.draft().trim();
    if (text === '' || !this.canSend() || this.readOnly()) {
      return;
    }
    this.composerError.set(null);
    this.sending.set(true);
    this.priorReply = this.latestMission();
    try {
      const starting = this.viewMode() !== 'session';
      const shaped = starting ? (this.state.shapeTicket?.() ?? null) : null;
      const reply = starting ? await this.state.newSession(text, shaped ?? undefined) : await this.state.send(text);
      const error = errorOf(reply);
      if (error !== null) {
        this.composerError.set(error);
        return;
      }
      this.draft.set('');
      this.clearAttachments();
      if (starting) {
        // The state opens the fresh session itself; show it — as the live one.
        this.composing.set(false);
        const file = this.active()?.file ?? null;
        if (file !== null) {
          this.liveFile.set(file);
        }
      }
    } catch (err) {
      this.composerError.set(errorText(err));
    } finally {
      this.sending.set(false);
    }
  }

  // -- the merged timeline --------------------------------------------------

  /** True on the reply that is streaming in right now (think-live face). */
  /** The chip over the composer: the owner's plan edits that would go along (E10-2). */
  protected readonly planChip = computed(() => planChipOf(this.state.chatPlan?.() ?? null));
  protected readonly planOn = computed(() => this.state.planEdits?.() ?? true);

  protected togglePlanEdits(): void {
    this.state.planEdits?.update((on) => !on);
  }

  // -- shape mode (E10-3) ------------------------------------------------------

  private readonly planState = inject(MC_PLAN_STATE, { optional: true });

  /**
   * The shape session in view: the open session's ticket, or — before the
   * first message — the ticket the entry point asked to shape. The context
   * line reads "Shaping T-0130 with Paul · opus · reads only" and, once
   * Paul has read files, the sources.
   */
  protected readonly shape = computed(() => {
    const active = this.active();
    const ticket = active !== null ? (active.ticket ?? null) : (this.state.shapeTicket?.() ?? null);
    if (ticket === null) {
      return null;
    }
    const sources = active?.sources ?? [];
    const shown = sources.slice(0, 3).join(' · ');
    return {
      ticket,
      line: `Shaping ${ticket} with Paul${active?.model === undefined ? '' : ` · ${active.model}`} · reads only`,
      context: sources.length === 0 ? null : `Context: ${shown}${sources.length > 3 ? ` · +${sources.length - 3}` : ''}`,
    };
  });

  /** The shape session's planner as the iPad draws it above his answers (board 5b, 5c). */
  protected readonly shapeWho = computed(() => {
    const name = 'Paul';
    return { name, color: this.work?.personas.find((persona) => persona.title === name)?.color ?? 'var(--text-2)' };
  });

  /** Paul's unanswered question: the last thing in the thread is his answer card. */
  protected readonly phone = touchFaceSignal();
  protected readonly pad = padSignal();
  /** The iPad's right pane (10e): the shell draws the Assistant head, the card of the open ticket shows here. */
  readonly assistant = input(false);
  /** The iPad's thread in the centre (10f): the ticket it was opened from. */
  readonly padThread = input<string | null>(null);
  readonly threadBack = output<void>();
  private readonly padCards = inject(PadCards);
  protected readonly padCard = computed(() => (this.assistant() ? this.padCards.card() : null));
  /** The bar's back control: only the thread's, to its ticket. */
  protected readonly barBack = computed(() => {
    const ticket = this.padThread();
    return ticket === null || ticket === '' ? null : ticket;
  });
  /** The padded column's meta line: the Assistant's has no time. */
  protected metaOf(at: string): string {
    return this.assistant() ? this.i18n.t('menu.mission_control') : this.i18n.t('chat.phone.meta', { time: this.timeOf(at) });
  }
  private readonly i18n = inject(McI18n);

  /** A message's clock time for the phone's meta line. */
  protected timeOf(at: string): string {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? this.i18n.formatTime(new Date(ms)) : '';
  }

  /** The phone draws every waiting change on one card (board 10m), at the first one's place. */
  protected readonly pendingProposals = computed<readonly TimelineProposal[]>(() =>
    this.timeline().flatMap((item) => (item.kind === 'proposal' ? [item.proposal] : [])),
  );

  /** A change's two lines: the ticket and what happens to it. */
  protected changeOf(proposal: TimelineProposal): { readonly id: string | null; readonly text: string } {
    const detail = proposalDetailOf(proposal.summary);
    switch (detail?.kind) {
      case 'transition':
        return { id: detail.id, text: `${this.phaseTitle(detail.from)} → ${this.phaseTitle(detail.to)}` };
      case 'promote':
        return { id: detail.id, text: this.i18n.t('chat.phone.promote') };
      case 'priority':
        return { id: detail.id, text: this.i18n.t('chat.phone.priority', { to: detail.to }) };
      case 'blocked':
        return { id: detail.id, text: proposal.summary };
      default:
        return { id: null, text: proposal.summary };
    }
  }

  protected readonly phoneOptions = computed<readonly AnswerOption[]>(() =>
    (this.openQuestion()?.options ?? []).map((option) => ({ label: option.label, consequence: null, recommended: option.recommended })),
  );

  protected readonly pickedIndex = computed<number | null>(() => {
    const label = this.pickedLabel();
    const at = label === null ? -1 : this.phoneOptions().findIndex((option) => option.label === label);
    return at === -1 ? null : at;
  });

  private readonly work = inject(MC_WORK_STATE, { optional: true });

  /** A worker's open question on the ticket the last answer names (board 10a). */
  private readonly linkedNeed = computed(() => {
    const said = this.latestMission()?.text ?? '';
    return (this.work?.needs ?? []).find((need) => need.kind === 'question' && (need.ticketId ?? '') !== '' && said.includes(need.ticketId!)) ?? null;
  });

  /** The ticket card in the thread: the session's ticket, else the one the answer asks about. */
  protected readonly linkedTicket = computed<{ readonly id: string; readonly title: string; readonly line: string } | null>(() => {
    const id = this.active()?.ticket ?? this.linkedNeed()?.ticketId ?? null;
    if (id === null) {
      return null;
    }
    const entry = this.state.ticketSummary?.(id) ?? null;
    if (entry === null) {
      return null;
    }
    const persona = this.work === null ? null : ticketPersonaOf(this.work.board as McBoard | null, id, this.work.personas);
    return {
      id,
      title: entry.title,
      line:
        this.linkedNeed() !== null && persona !== null
          ? this.i18n.t('chat.phone.linked_question', { id, phase: entry.phase, name: persona.title })
          : [id, entry.phase].join(' · '),
    };
  });

  protected readonly linkedCard = computed<QuestionCardVm | null>(() => {
    const need = this.linkedNeed();
    return need === null ? null : questionCardOf(need);
  });
  protected readonly linkedPick = signal<number | null>(null);
  protected readonly linkedBusy = signal(false);
  protected readonly linkedDone = signal(false);
  protected readonly linkedError = signal<string | null>(null);

  /** The one acting tap: the same answer the ticket's card sends. */
  protected async sendLinked(card: QuestionCardVm): Promise<void> {
    const at = this.linkedPick();
    const option = at === null ? undefined : card.options[at];
    const answer = this.work?.answer;
    if (option === undefined || card.runId === null || answer === undefined) {
      return;
    }
    this.linkedBusy.set(true);
    this.linkedError.set(null);
    try {
      const reply = await answer.call(this.work, card.runId, option.answerText);
      if (reply.ok) {
        this.linkedDone.set(true);
      } else {
        this.linkedError.set(reply.error);
      }
    } finally {
      this.linkedBusy.set(false);
    }
  }

  protected openLinked(id: string): void {
    this.state.openTicket?.(id);
  }

  protected readonly openQuestion = computed(() => {
    const last = this.messages()[this.messages().length - 1];
    return last !== undefined && last.kind === 'question' && (last.options?.length ?? 0) >= 2 && !this.readOnly() ? last : null;
  });
  /** The choice picked on the answer card; sent by the button, never by the pick itself. */
  protected readonly picked = signal<string | null>(null);
  protected readonly pickedLabel = computed(() => {
    const question = this.openQuestion();
    const pick = this.picked();
    return question !== null && pick !== null && (question.options ?? []).some((o) => o.label === pick) ? pick : null;
  });

  protected pick(label: string): void {
    this.picked.update((current) => (current === label ? null : label));
  }

  protected async sendPicked(): Promise<void> {
    const label = this.pickedLabel();
    if (label === null || this.sending()) {
      return;
    }
    this.composerError.set(null);
    this.sending.set(true);
    this.priorReply = this.latestMission();
    try {
      const error = errorOf(await this.state.send(label));
      if (error !== null) {
        this.composerError.set(error);
        return;
      }
      this.picked.set(null);
    } catch (err) {
      this.composerError.set(errorText(err));
    } finally {
      this.sending.set(false);
    }
  }

  /** The split proposal that still waits for the owner: the latest split card, undecided. */
  protected readonly openSplit = computed(() => {
    const split = [...this.messages()].reverse().find((m) => m.kind === 'split');
    return split !== undefined && (split.decision ?? null) === null && !this.readOnly() ? split : null;
  });
  protected readonly splitBusy = signal(false);
  protected readonly splitError = signal<string | null>(null);

  protected isOpenSplit(message: ChatMessageView): boolean {
    return message === this.openSplit();
  }

  protected splitLabel(message: ChatMessageView): string {
    return splitLabelOf(message.parts ?? 1);
  }

  protected async decideSplit(choice: 'keep' | 'split'): Promise<void> {
    const file = this.active()?.file ?? null;
    if (file === null || this.splitBusy() || this.state.shapeDecide === undefined) {
      return;
    }
    this.splitBusy.set(true);
    this.splitError.set(null);
    try {
      const error = errorOf(await this.state.shapeDecide(file, choice));
      if (error !== null) {
        this.splitError.set(error);
      }
    } catch (err) {
      this.splitError.set(errorText(err));
    } finally {
      this.splitBusy.set(false);
    }
  }

  /** The phone's plan row and its sheet (the wide layout shows the plan beside the chat). */
  protected readonly planSheetOpen = signal(false);
  protected readonly planRow = computed(() => {
    const doc = this.planState?.doc() ?? null;
    return this.shape() === null || this.planState === null
      ? null
      : { subtitle: doc === null ? null : planRowSubtitleOf(planSectionOf(doc.text)) };
  });

  protected openPlanSheet(): void {
    this.planSheetOpen.set(true);
  }

  protected closePlanSheet(): void {
    this.planSheetOpen.set(false);
  }

  protected isLive(item: ChatTimelineItem): boolean {
    const latest = this.latestMission();
    return (
      this.sending() &&
      latest !== null &&
      latest !== this.priorReply &&
      item.kind === 'message' &&
      item.message === latest
    );
  }

  /** True on the newest mission reply — the one whose think window was measured. */
  protected isLatestMission(item: ChatTimelineItem): boolean {
    return item.kind === 'message' && item.message.role === 'mission' && item.message === this.latestMission();
  }

  protected thinkFoldOf(item: ChatTimelineItem): string {
    return thinkFoldLabel(this.isLatestMission(item) ? this.thinkSeconds() : null);
  }

  // -- proposal cards ---------------------------------------------------------

  protected async confirm(id: string): Promise<void> {
    const file = this.active()?.file;
    if (file === undefined) {
      return;
    }
    const ok = await this.decide(id, (state) => state.confirm(file, id));
    if (!ok) {
      return;
    }
    const outcome = this.active()?.proposals.find((proposal) => proposal.id === id)?.outcome ?? null;
    this.toast(outcome !== null && outcome !== '' ? `Confirmed — ${outcome}` : 'Confirmed');
  }

  protected async dismiss(id: string): Promise<void> {
    const file = this.active()?.file;
    if (file === undefined) {
      return;
    }
    // The dim shows at once; a refused dismiss lifts it again.
    this.dimmedCards.update((current) => ({ ...current, [id]: true }));
    const ok = await this.decide(id, (state) => state.dismiss(file, id));
    if (!ok) {
      this.dimmedCards.update((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }
    this.toast('Discarded — nothing was changed', 'warn');
  }

  private async decide(id: string, call: (state: McChatState) => Promise<unknown>): Promise<boolean> {
    this.cardErrors.update((current) => ({ ...current, [id]: '' }));
    this.cardBusy.update((current) => ({ ...current, [id]: true }));
    try {
      const error = errorOf(await call(this.state));
      if (error !== null) {
        this.cardErrors.update((current) => ({ ...current, [id]: error }));
        return false;
      }
      return true;
    } catch (err) {
      this.cardErrors.update((current) => ({ ...current, [id]: errorText(err) }));
      return false;
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

  protected isDimmed(id: string): boolean {
    return this.dimmedCards()[id] === true;
  }

  // -- the cards' rich bodies ---------------------------------------------------

  /**
   * The proposal's two merged gate chains — the ticket's current delta
   * against the proposed one; null on any other command kind, so the
   * card renders the rich detail from the summary or the summary line
   * alone. A board without the card degrades to an empty "before" (the
   * current phase unknown) — the asymmetric-tolerance rule: absence reads
   * as "no detail", never a guess.
   */
  protected chainCompareFor(proposal: TimelineProposal): ChainCompare | null {
    const chain = proposal.chain;
    if (chain === undefined) {
      return null;
    }
    const card = parseBoardCard(this.state.board(), chain.id);
    return chainCompareOf(this.chainPhases(), card?.phase ?? '', card?.chain ?? [], chain.chain);
  }

  protected detailOf(proposal: TimelineProposal): ProposalDetail | null {
    return proposalDetailOf(proposal.summary);
  }

  /** The tickets directory a create card's diffbox names; null omits the line. */
  protected createDirOf(detail: ProposalDetail & { readonly kind: 'create' }): string | null {
    return phaseDirOf(this.state.board(), detail.phase);
  }

  /** The ticket's current priority — the "from" of a priority card's line. */
  protected priorityFromOf(id: string): string | null {
    return cardPriorityOf(this.state.board(), id);
  }

  /** The board's display title for a phase id; the raw id when unknown. */
  protected phaseTitle(id: string): string {
    return this.state.work().groups.find((group) => group.id === id)?.title ?? id;
  }

  /** The card's mono kicker while it waits. */
  protected ckOf(proposal: TimelineProposal): string {
    if (proposal.chain !== undefined) {
      return `${proposal.chain.id} · Chain`;
    }
    switch (proposalDetailOf(proposal.summary)?.kind) {
      case 'create':
        return 'New ticket · confirmation';
      case 'transition':
        return 'Transition · confirmation';
      case 'blocked':
        return 'Blocker · confirmation';
      case 'priority':
        return 'Priority · confirmation';
      case 'promote':
        return 'Promote · confirmation';
      default:
        return 'Needs confirmation';
    }
  }

  /** The done card's kicker — the create announces itself as angelegt. */
  protected ckDoneOf(proposal: TimelineProposal): string {
    return proposal.chain === undefined && proposalDetailOf(proposal.summary)?.kind === 'create'
      ? 'Angelegt'
      : 'Confirmed';
  }

  // -- toast ------------------------------------------------------------------

  /**
   * The state's toast pill (Agent A's slice on the state store): the message and
   * the kind tint. Errors stay inline on the card/composer — the toast
   * carries the decisions' feedback.
   */
  protected toast(message: string, kind: 'ok' | 'warn' | 'error' = 'ok'): void {
    this.state.toast(message, kind);
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
