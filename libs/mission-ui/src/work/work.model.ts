/**
 * The work tab's local structural types and pure logic (E5b).
 *
 * `app/api` lands in parallel with this tab; instead of importing shapes
 * that do not exist yet, the work tab declares the minimal slice of the
 * device state it consumes (the `McWorkState` interface below) and the
 * parent reconciles it against the shipped `McState`. The shapes mirror
 * the gateway's wire JSON (`/api/board`, `/api/needs`, `/api/personas`)
 * read tolerantly: every optional reflects absence on the wire, never a
 * guess.
 */
import { InjectionToken } from '@angular/core';
import {
  DEFAULT_PRIORITY_CONFIG,
  isJumpPriority,
  parsePriorities,
  type McPriorityConfig,
  type McTicketUsage,
} from '../api/dto';

// --- the consumed device-state surface ---------------------------------------

/** One "Needs you" item: the owner is asked to act. */
export interface McNeed {
  readonly kind: string;
  /** The column the ticket stands in; absent when the need names none. */
  readonly phase?: string;
  readonly ticketId?: string | null;
  readonly title: string;
  /** The question, the tool call, the gate failure — '' for a checkpoint. */
  readonly summary: string;
  /**
   * E8 (concept §5.6): the parsed scout report, present exactly on a
   * 'report' need (the engine's guarantee); absent otherwise.
   */
  readonly report?: McScoutReport;
  /**
   * The run the need concerns (the engine's NeedItem.runId — the run the
   * option card's answer addresses); null/absent for a checkpoint or a
   * report. The wire slice rides in `api/dto` (`NeedView`); the shapes
   * stay in step because the shell binds the api's list directly.
   */
  readonly runId?: string | null;
  /** A question form's fields (OpenCode's `question` tool); absent otherwise. */
  readonly questions?: readonly McWaitQuestion[];
  /** A `QUESTION:` turn's parsed fixed shape (req-75 W2); absent otherwise. */
  readonly shaped?: McShapedQuestion;
}

/** One option of a worker's question form (the engine's WaitQuestion option). */
export interface McWaitOption {
  readonly label: string;
  readonly description: string | null;
}

/** One question of a worker's question form (the engine's WaitQuestion). */
export interface McWaitQuestion {
  /** The form field the answer goes to (`q0`, `q1`, …). */
  readonly key: string;
  readonly header: string | null;
  readonly question: string;
  readonly options: readonly McWaitOption[];
  readonly multiple: boolean;
}

/** One numbered option of a shaped `QUESTION:` turn (question-shape.ts). */
export interface McShapedOption {
  readonly n: number;
  readonly label: string;
  /** What the option concretely does; null when the line named none. */
  readonly consequence: string | null;
}

/** A `QUESTION:` turn's parsed fixed shape (the engine's ShapedQuestion). */
export interface McShapedQuestion {
  readonly question: string;
  readonly context: string | null;
  readonly where: string | null;
  readonly why: string | null;
  readonly options: readonly McShapedOption[];
  readonly recommended: number | null;
  readonly recommendationWhy: string | null;
}

/** One scout decision as the report card renders it. */
export interface McScoutDecision {
  /** The decision's short key (`D1`, `D2`, …). */
  readonly key: string;
  /** The question in the scout's words — what the owner decides. */
  readonly question: string;
  /** The scout's recommendation; null when the line carries none. */
  readonly recommendation: string | null;
  /** The owner's check mark; open decisions stay unchecked. */
  readonly resolved: boolean;
}

/** The parsed `## Report` riding on a 'report' need — the card's detail body. */
export interface McScoutReport {
  /** ISO stamp; '' when the desk omitted it. */
  readonly writtenAt: string;
  /** Who wrote it (the persona id); '' when unknown. */
  readonly by: string;
  /** The report's free-text summary; '' when absent. */
  readonly summary: string;
  readonly decisions: readonly McScoutDecision[];
}

/**
 * A priority id from the vault's configured vocabulary — the board's
 * `priorities` names it (`urgent` in the default list, or `p0`,
 * `critical`, …); the id IS the label and the order IS the weight.
 */
export type McPriority = string;

/** The frontmatter slice a work card renders. */
export interface McTicketMeta {
  readonly priority?: McPriority | null;
  /** The ticket's title as the desk stores it (TicketMeta.title). */
  readonly title?: string | null;
  /** The persona pin's id; the persona map resolves its colour and title. */
  readonly persona?: string | null;
  readonly claimedBy?: string | null;
  /** The `blocked-by:` ids as written. */
  readonly blockedBy?: readonly string[];
}

/** One ticket as the card renders it — one ticket = one card. */
export interface McTicket {
  readonly id: string;
  readonly title?: string | null;
  /** Vault-relative path (`tickets/<phase>/<id>.md`). */
  readonly path?: string;
  /** The OPEN blockers (derived); non-empty drives the blocked marker. */
  readonly blocked?: readonly string[];
  /**
   * The runs' accumulated cost in dollars, when the desk sends it; absent
   * (the wire carries none today) hides the card's cost slot — a missing
   * number never renders as a 0-fake.
   */
  readonly cost?: number | null;
  /**
   * The ticket's settled-run usage off the ledger (the engine's
   * TicketUsage — tokens, summed cost, run count); absent when the desk
   * has none. When present it drives the cost slot (`usage.cost`), the
   * legacy `cost` field above stays the fallback an older desk owes.
   */
  readonly usage?: McTicketUsage;
  /**
   * The live run's context fill in percent, when the desk sends it; absent
   * hides the card's ctx bar the same way.
   */
  readonly ctx?: number | null;
  readonly meta: McTicketMeta;
}

/** One pipeline phase (`/api/board` columns' phase head). */
export interface McPhase {
  readonly id: string;
  readonly title: string;
  /** The phase chip's colour (`#rrggbb`); absent = the token default. */
  readonly color?: string | null;
}

export interface McColumn {
  readonly phase: McPhase;
  readonly tickets: readonly McTicket[];
  /**
   * The phase directory exists but pipeline.md lost it: the group
   * renders, yet it never takes a move (the phone client's rule).
   */
  readonly unknown?: boolean;
}

/** One ticket of the archive (the board's `recentDone`, `/api/archive`): done and accepted. */
export interface McDoneEntry {
  readonly id: string;
  readonly title: string | null;
  /** The newest `— archived` Log stamp; '' when the Log has none. */
  readonly at: string;
}

export interface McBoard {
  readonly columns: readonly McColumn[];
  /** The tickets archived within the last seven days (E13-21: the Done-this-week group). */
  readonly recentDone?: readonly McDoneEntry[];
  readonly checkpoints?: readonly string[];
  /**
   * The board's priority vocabulary (`/api/board` `priorities`) — read
   * tolerantly when the groups map; the default list when absent or junk.
   */
  readonly priorities?: McPriorityConfig;
  /**
   * The vault's display name (the board snapshot's `vaultName`, the
   * initialized vault), read tolerantly; the header's mono sub shows it —
   * absent on an uninitialized vault, where `activeVaultName` may still
   * name the folder.
   */
  readonly vaultName?: string | null;
  /** The active vault folder's name; the sub's fallback when `vaultName` is blank. */
  readonly activeVaultName?: string | null;
}

/** The team tab's persona slice; work cards only need id/title/color. */
export interface McPersona {
  readonly id: string;
  readonly title: string;
  /** `#rrggbb`; the persona chip's dot. */
  readonly color: string;
}

/** The result of `POST /api/tickets/<id>/move` (the MutationResult shape). */
export interface McMoveResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * One fleet run as the header's Fleet chip counts it — the tolerant slice
 * of the `/api/fleet` runs list the adapter may expose; the card itself
 * never needs a run's ticket or persona.
 */
export interface McRun {
  readonly state?: string | null;
  /** The ticket the run works on (E13-20: the ticket opens on the run while it is live). */
  readonly ticketId?: string;
}

/**
 * Exactly what the work tab consumes of the device state. The api
 * module's `McState` is bound to `MC_WORK_STATE` by the shell; the tab
 * also renders a "not connected" note when nothing is bound. The optional
 * members (`runs`, `toast`) are tolerant: an adapter that lacks them keeps
 * the tab whole — the Fleet chip then shows its idle face and a tap stays
 * silent.
 */
export interface McWorkState {
  readonly needs: readonly McNeed[];
  readonly board: McBoard | null;
  readonly personas: readonly McPersona[];
  /** Read-only paired devices watch but never mutate: the move hides. */
  readonly readOnly: boolean;
  /**
   * The fleet's live runs, folded in by the adapter (the same snapshot the
   * Team tab reads); absent or null = no run data in the state — the chip
   * degrades to its idle face instead of guessing a count.
   */
  readonly runs?: readonly McRun[] | null;
  moveTicket(ticketId: string, phaseId: string): Promise<McMoveResult>;
  /** The archive of any age, newest first, for "Show older" (E13-21); absent = no such list. */
  loadArchive?(): Promise<readonly McDoneEntry[]>;
  /** Opens the ticket screen (E5c) — the card tap's destination. */
  openTicket?(ticketId: string): void;
  /**
   * Opens the ticket screen with the Send-back panel waiting — the card
   * back-swipe's one call: the state parks the ticket id and the ticket
   * screen opens its Send-back panel for it. Optional; absent = the
   * back-swipe offers no layer (a plain open would promise less than
   * the gesture's label says).
   */
  openTicketSendBack?(ticketId: string): void;
  /**
   * The report card's promote (E8): fills the chat composer with the
   * promote command and switches to the chat tab; absent = the report
   * card renders without the promote action.
   */
  promote?(ticketId: string): void;
  /**
   * Opens the persona's 1:1 detail (E6); absent = an improvements need
   * card renders non-interactive. The caller passes the need item's
   * title — the engine guarantees it IS the persona title — resolved
   * against the persona directory when it is known; the adapter accepts
   * a title or an id.
   */
  openPersona?(personaTitleOrId: string): void;
  /**
   * A transient status note (the prototype's toast pill); absent = the
   * tab skips the nicety silently. The kind picks the accent (the api
   * module's ToastKind).
   */
  toast?(message: string, kind?: 'ok' | 'warn' | 'error'): void;
  /**
   * Answers a run's question (req-64): the option card's send — one POST
   * to the desk, the run goes on with its step. `text` is the chosen
   * option's answer wording (`questionAnswerTextOf`). Optional while the
   * parent wires it; absent = the option card renders display-only.
   */
  answer?(runId: string, text: string): Promise<McAnswerReply>;
  /**
   * A manual step's Accept (E10-6): the ticket parked for the owner goes on
   * along its chain. Absent = the manual card shows no actions.
   */
  finishManual?(ticketId: string): Promise<McAnswerReply>;
  /** A manual step's Send back (E10-6); the note is mandatory. */
  sendBackManual?(ticketId: string, note: string): Promise<McAnswerReply>;
}

/** What an answer hands back (`McReply` in the app's api layer, restated). */
export type McAnswerReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

export const MC_WORK_STATE = new InjectionToken<McWorkState>('mc.work-state');

// --- view models ---------------------------------------------------------------

export interface NeedVm {
  readonly key: string;
  readonly need: McNeed;
  readonly kindLabel: string;
}

export interface TicketVm {
  readonly ticket: McTicket;
  readonly id: string;
  readonly title: string;
  readonly phaseId: string;
  readonly phaseTitle: string;
  readonly phaseColor: string | null;
  /** Resolved from the persona map; null = no pin or an unknown persona. */
  readonly persona: McPersona | null;
  /** The persona chip's initial; null when no persona resolves. */
  readonly personaInitial: string | null;
  readonly flagged: boolean;
  readonly blocked: boolean;
  /** The blocker ids the statline names (`wartet auf …`); non-empty exactly when blocked. */
  readonly blockers: readonly string[];
  /** The cost slot's label (`$0.44`); null = the desk sent none — the slot stays hidden. */
  readonly costLabel: string | null;
  /** The Σ token label (`Σ 173k`); null = no usable usage — the slot stays hidden. */
  readonly tokensLabel: string | null;
  /** The ctx bar's percent (1–100); null = no data, the slot stays hidden. */
  readonly ctxPercent: number | null;
}

/**
 * One render group: the needs-you group first, then one group per
 * non-empty board column, in the owner's reading order (concept §7) —
 * closest-to-done first, the terminal phase last (the archive), the
 * unknown directories after it (`groupsOf`).
 */
export type WorkGroup =
  | {
      readonly kind: 'needs';
      readonly key: 'needs';
      readonly title: 'Needs you';
      readonly needs: readonly NeedVm[];
    }
  | {
      readonly kind: 'phase';
      readonly key: string;
      readonly phaseId: string;
      readonly title: string;
      readonly unknown: boolean;
      readonly tickets: readonly TicketVm[];
    };

// --- pure logic ------------------------------------------------------------------

export const NEED_KIND_LABELS: Readonly<Record<string, string>> = {
  question: 'Asks you',
  permission: 'Wants permission',
  'red-gate': 'Gate red',
  failed: 'Run failed',
  checkpoint: 'Checkpoint',
  improvements: 'Improvements',
  'needs-decision': 'Needs decision',
  blocked: 'Blocked',
  report: 'Scout report',
  /** E9 (concept §5.7): a chain gate with a Bescheid rule just completed. */
  notify: 'Gate done',
  /** E10-6: a ticket parked at a manual step - the owner finishes it. */
  manual: 'Your turn',
};

/** The need card's kind chip; an unknown kind shows itself, never a guess. */
export function needKindLabelOf(kind: string, phase?: string): string {
  if (kind === 'checkpoint' && phase === 'ready') {
    return 'Ready to try';
  }
  return NEED_KIND_LABELS[kind] ?? kind;
}

// --- the question option card ('Auswahl nie = Aktion') ---------------------------

/** One option row the question card renders. */
export interface QuestionOptionVm {
  readonly label: string;
  /** What the option concretely does; null = the line named none. */
  readonly consequence: string | null;
  /** The recommendation badge's row (a shaped question's recommended option). */
  readonly recommended: boolean;
  /**
   * What sending hands the desk: `<n>. <label>` on a shaped question
   * (the engine's answerText), the bare label on a question form (the
   * runner's own matcher reads labels).
   */
  readonly answerText: string;
}

/** The question card's render slice; null = the need asks nothing readable. */
export interface QuestionCardVm {
  readonly question: string;
  readonly options: readonly QuestionOptionVm[];
  /** The run the answer addresses; null = nothing to answer (composer prefill only). */
  readonly runId: string | null;
}

/**
 * The question need's option card ('Auswahl nie = Aktion'): the shaped
 * `QUESTION:` shape wins — its numbered options with their consequences
 * and the recommendation badge; a question form (`questions`) renders
 * its first question's choices with their descriptions. A need with
 * neither shape — or without two readable options — yields null: the
 * card then shows the plain question text alone and the composer
 * carries the answer.
 */
export function questionCardOf(need: McNeed): QuestionCardVm | null {
  if (need.kind !== 'question') {
    return null;
  }
  const runId = need.runId ?? null;
  const shaped = need.shaped;
  if (shaped !== undefined && shaped.options.length >= 2) {
    return {
      question: shaped.question,
      runId,
      options: shaped.options.map((option) => ({
        label: option.label,
        consequence: option.consequence,
        recommended: shaped.recommended !== null && option.n === shaped.recommended,
        answerText: `${option.n}. ${option.label}`,
      })),
    };
  }
  const form = need.questions?.[0];
  if (form !== undefined && form.options.length >= 2) {
    return {
      question: form.question,
      runId,
      options: form.options.map((option) => ({
        label: option.label,
        consequence: option.description,
        recommended: false,
        answerText: option.label,
      })),
    };
  }
  return null;
}

/**
 * The open question need for one ticket: the first 'question' item whose
 * ticket id matches; null = none waits (the thread CTA degrades to the
 * ghost 'Open thread').
 */
export function questionNeedOf(needs: readonly McNeed[], ticketId: string): McNeed | null {
  return needs.find((need) => need.kind === 'question' && (need.ticketId ?? '') === ticketId) ?? null;
}

/**
 * The persona behind a ticket, resolved off the board's card pin — the
 * question chip and the CTA's label read it; null when the board holds
 * no such card, no pin, or the persona is unmapped (tolerant: the chip
 * stays hidden then).
 */
export function ticketPersonaOf(
  board: McBoard | null,
  ticketId: string,
  personas: readonly McPersona[],
): McPersona | null {
  for (const column of board?.columns ?? []) {
    for (const ticket of column.tickets) {
      if (ticket.id !== ticketId) {
        continue;
      }
      const id = ticket.meta.persona ?? null;
      return id === null ? null : (personaMapOf(personas).get(id) ?? null);
    }
  }
  return null;
}

/** The card title: the file title (top level or the desk's meta.title), the id when absent. */
export function displayTitleOf(ticket: McTicket): string {
  const title = ticket.title?.trim() ?? ticket.meta.title?.trim() ?? '';
  return title === '' ? ticket.id : title;
}

/**
 * The jump-class flag: the configured vocabulary's upper half (the order
 * IS the weight — first is highest, the split sits at `floor(len/2)`).
 * The default vocabulary flags `urgent` and `high`; a configured one
 * flags whatever the vault puts before its own middle — and an unknown
 * id never flags.
 */
export function isFlaggedTicket(
  ticket: McTicket,
  config: McPriorityConfig = DEFAULT_PRIORITY_CONFIG,
): boolean {
  return isJumpPriority(ticket.meta.priority ?? null, config.order);
}

/** The blocked marker: open blockers as derived, else the raw `blocked-by` list. */
export function isBlockedTicket(ticket: McTicket): boolean {
  return (ticket.blocked?.length ?? 0) > 0 || (ticket.meta.blockedBy?.length ?? 0) > 0;
}

/**
 * The blocker ids the statline names: the derived OPEN blockers when the
 * desk sent them, else the raw `blocked-by` ids as written. Empty = the
 * card is not blocked (or blocked with no readable ids).
 */
export function blockerIdsOf(ticket: McTicket): readonly string[] {
  return (ticket.blocked?.length ?? 0) > 0 ? (ticket.blocked ?? []) : (ticket.meta.blockedBy ?? []);
}

/**
 * The cost slot's label; null unless the desk sent a usable positive
 * number — absent, zero and junk hide the slot instead of faking a 0.
 */
export function costLabelOf(cost: number | null | undefined): string | null {
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0
    ? `$${cost.toFixed(2)}`
    : null;
}

/**
 * The Σ token label off the card's usage (`Σ 54k` — the Log's short
 * counts, mirrored from the engine's tokenWords); null when the usage
 * carries no usable tokens — absent, zero and junk hide the slot, never
 * a 0-fake.
 */
export function tokensSumLabelOf(usage: McTicketUsage | null | undefined): string | null {
  const side = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  const sum = side(usage?.tokensIn) + side(usage?.tokensOut);
  if (sum <= 0) {
    return null;
  }
  const words =
    sum >= 1_000_000
      ? `${(sum / 1_000_000).toFixed(1)}M`
      : sum >= 1_000
        ? `${Math.round(sum / 1_000)}k`
        : String(sum);
  return `Σ ${words}`;
}

/**
 * The ctx bar's percent, rounded; null unless the desk sent a usable
 * 1–100 number — 0 and out-of-range junk hide the bar, never fake it.
 */
export function ctxPercentOf(ctx: number | null | undefined): number | null {
  if (typeof ctx !== 'number' || !Number.isFinite(ctx)) {
    return null;
  }
  const percent = Math.round(ctx);
  return percent >= 1 && percent <= 100 ? percent : null;
}

/** The persona chip's initial: the title's first character, uppercased. */
export function personaInitialOf(title: string): string {
  return title.trim().charAt(0).toUpperCase();
}

/** The header's mono sub: the board's vault name, the folder name as fallback. */
export function vaultTitleOf(board: McBoard | null): string | null {
  for (const name of [board?.vaultName, board?.activeVaultName]) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed !== '') {
      return trimmed;
    }
  }
  return null;
}

/**
 * The run states that mean "live" — mirrored from the api module's
 * `LIVE_RUN_STATES` (`starting`/`running`/`stopping`/`detached`); the
 * rest is history and never counts.
 */
const LIVE_RUN_STATES: readonly string[] = ['starting', 'running', 'stopping', 'detached'];

/**
 * The Fleet chip's live-run count; null = no run data in the state (the
 * chip degrades to its idle face), 0 = data present, nothing live.
 */
export function liveRunCountOf(runs: readonly McRun[] | null | undefined): number | null {
  if (runs === null || runs === undefined) {
    return null;
  }
  let count = 0;
  for (const run of runs) {
    if (run.state !== null && run.state !== undefined && LIVE_RUN_STATES.includes(run.state)) {
      count += 1;
    }
  }
  return count;
}

/** The chip's label: the count when run data exist, the bare word when not. */
export function fleetLabelOf(count: number | null): string {
  return count === null ? 'Fleet' : `${count} active`;
}

/** Persona id → persona; the ticket's persona pin resolves here. */
export function personaMapOf(personas: readonly McPersona[]): ReadonlyMap<string, McPersona> {
  return new Map(personas.map((persona) => [persona.id, persona]));
}

/**
 * The need card's stable key. An improvements need's `ticketId` is '' and
 * its `title` IS the persona title (the engine's guarantee), so the title
 * is the key — an index would churn whenever another need joins the list.
 * Every other need keys on kind, ticket id and index.
 */
function needKeyOf(need: McNeed, index: number): string {
  if (need.kind === 'improvements' && need.title.trim() !== '') {
    return `improvements:${need.title.trim()}`;
  }
  return `${need.kind}:${need.ticketId ?? 'none'}:${index}`;
}

function ticketVmOf(
  ticket: McTicket,
  column: McColumn,
  personas: ReadonlyMap<string, McPersona>,
  config: McPriorityConfig,
): TicketVm {
  const personaId = ticket.meta.persona ?? null;
  const persona = personaId === null ? null : (personas.get(personaId) ?? null);
  return {
    ticket,
    id: ticket.id,
    title: displayTitleOf(ticket),
    phaseId: column.phase.id,
    phaseTitle: column.phase.title,
    phaseColor: column.phase.color ?? null,
    persona,
    personaInitial: persona === null ? null : personaInitialOf(persona.title),
    flagged: isFlaggedTicket(ticket, config),
    blocked: isBlockedTicket(ticket),
    blockers: blockerIdsOf(ticket),
    costLabel: costLabelOf(ticket.usage?.cost ?? ticket.cost),
    tokensLabel: tokensSumLabelOf(ticket.usage),
    ctxPercent: ctxPercentOf(ticket.ctx),
  };
}

/**
 * The groups in render order — the owner's reading order, not the
 * pipeline's: the needs-you group first (only when something waits),
 * then the board's phase groups with the phases closest to done first
 * (what a move pushes toward done leads the list), the terminal phase —
 * the pipeline's last column — as the last phase group (the archive),
 * and the unknown directories after it. Empty phase groups (0 tickets)
 * render nothing at all; `board` null (nothing fetched yet) yields just
 * the needs group.
 */
export function groupsOf(
  needs: readonly McNeed[],
  board: McBoard | null,
  personas: readonly McPersona[],
): WorkGroup[] {
  const personaMap = personaMapOf(personas);
  const priorities = parsePriorities(board?.priorities);
  const groups: WorkGroup[] = [];
  if (needs.length > 0) {
    groups.push({
      kind: 'needs',
      key: 'needs',
      title: 'Needs you',
      needs: needs.map((need, index) => ({
        key: needKeyOf(need, index),
        need,
        kindLabel: needKindLabelOf(need.kind, need.phase),
      })),
    });
  }
  if (board !== null) {
    const known = board.columns.filter((column) => column.unknown !== true);
    const terminal = known.length > 0 ? (known[known.length - 1] ?? null) : null;
    const leading = known.slice(0, -1).reverse();
    const trailing = board.columns.filter((column) => column.unknown === true);
    const ordered = [...leading, ...(terminal === null ? [] : [terminal]), ...trailing];
    for (const column of ordered) {
      if (column.tickets.length === 0) {
        continue;
      }
      groups.push({
        kind: 'phase',
        key: `phase:${column.phase.id}`,
        phaseId: column.phase.id,
        title: column.phase.title,
        unknown: column.unknown === true,
        tickets: column.tickets.map((ticket) => ticketVmOf(ticket, column, personaMap, priorities)),
      });
    }
  }
  return groups;
}

/**
 * The Done group's older tickets (E13-21 "Show older"): the archive minus this
 * week's, narrowed by the search words (id or title, every word must hit). The
 * engine already sends newest first.
 */
export function olderDoneOf(
  all: readonly McDoneEntry[],
  recent: readonly McDoneEntry[],
  query: string,
): readonly McDoneEntry[] {
  const skip = new Set(recent.map((entry) => entry.id));
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  return all.filter((entry) => {
    if (skip.has(entry.id)) {
      return false;
    }
    const hay = `${entry.id} ${entry.title ?? ''}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/**
 * The phase a card in `phaseId` moves on to: the next column in
 * PIPELINE order — the board's own order, not the render order (which
 * reads closest-to-done first). Unknown directories never take a move;
 * the result may name an empty column: moving into one is exactly how
 * it fills, so the empty filter on the render says nothing here.
 */
export function nextPhaseOf(board: McBoard | null, phaseId: string): McMoveTarget | null {
  const known = (board?.columns ?? []).filter((column) => column.unknown !== true);
  const index = known.findIndex((column) => column.phase.id === phaseId);
  const next = index < 0 ? null : (known[index + 1] ?? null);
  return next === null ? null : { phaseId: next.phase.id, title: next.phase.title };
}

/** The move a forward swipe fires: the next pipeline phase, titled. */
export interface McMoveTarget {
  readonly phaseId: string;
  readonly title: string;
}

// --- the card swipe ('die Headline bleibt stehen') --------------------------------

/** The swipe's trigger distance (px) — a release past it fires the action. */
export const SWIPE_TRIGGER_PX = 72;

/**
 * The action layer's full reach (px) — the optics grow toward it and
 * clamp; the card itself never translates, under the trigger nothing
 * snaps back because nothing ever moved.
 */
export const SWIPE_REACH_PX = 96;

/** Movement past this (px) reads as a gesture, not a tap — the tap stays silent. */
export const SWIPE_TAP_SLOP_PX = 8;

/** How long the fired card's done-optic (the edge flash) stays on (ms). */
export const SWIPE_FLASH_MS = 500;

/** What a released swipe fires: right = forward (move on), left = back (send back). */
export type SwipeAction = 'forward' | 'back';

/** The release's verdict: `forward` past +trigger, `back` past −trigger, null between. */
export function swipeActionOf(deltaX: number): SwipeAction | null {
  if (deltaX >= SWIPE_TRIGGER_PX) {
    return 'forward';
  }
  if (deltaX <= -SWIPE_TRIGGER_PX) {
    return 'back';
  }
  return null;
}

/**
 * The action layer's intensity 0..1 for the live |deltaX| — the optics'
 * alpha and width grow with the distance and clamp at the reach; the
 * sign never matters here (each side styles itself).
 */
export function swipeProgressOf(deltaX: number): number {
  const progress = Math.abs(deltaX) / SWIPE_REACH_PX;
  return Math.min(Math.max(progress, 0), 1);
}
