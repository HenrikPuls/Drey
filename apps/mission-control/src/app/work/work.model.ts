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

// --- the consumed device-state surface ---------------------------------------

/** One "Needs you" item: the owner is asked to act. */
export interface McNeed {
  readonly kind: string;
  readonly ticketId?: string | null;
  readonly title: string;
  /** The question, the tool call, the gate failure — '' for a checkpoint. */
  readonly summary: string;
}

export type McPriority = 'urgent' | 'high' | 'normal' | 'low' | (string & {});

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
  /** The ticket's blurb; the wire list may omit it — the sheet shows it when there. */
  readonly summary?: string | null;
  /** The OPEN blockers (derived); non-empty drives the blocked marker. */
  readonly blocked?: readonly string[];
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

export interface McBoard {
  readonly columns: readonly McColumn[];
  readonly checkpoints?: readonly string[];
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
 * Exactly what the work tab consumes of the device state. The api
 * module's `McState` is bound to `MC_WORK_STATE` by the shell; the tab
 * also renders a "not connected" note when nothing is bound.
 */
export interface McWorkState {
  readonly needs: readonly McNeed[];
  readonly board: McBoard | null;
  readonly personas: readonly McPersona[];
  /** Read-only paired devices watch but never mutate: the move hides. */
  readonly readOnly: boolean;
  moveTicket(ticketId: string, phaseId: string): Promise<McMoveResult>;
  /** Opens the ticket screen (E5c); absent = the sheet hides the button. */
  openTicket?(ticketId: string): void;
  /**
   * Opens the persona's 1:1 detail (E6); absent = an improvements need
   * card renders non-interactive. The caller passes the need item's
   * title — the engine guarantees it IS the persona title — resolved
   * against the persona directory when it is known; the adapter accepts
   * a title or an id.
   */
  openPersona?(personaTitleOrId: string): void;
}

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
  readonly flagged: boolean;
  readonly blocked: boolean;
}

/**
 * One render group: the needs-you group first, then one group per board
 * column, in board order — groups, not kanban columns (concept §7).
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
};

/** The need card's kind chip; an unknown kind shows itself, never a guess. */
export function needKindLabelOf(kind: string): string {
  return NEED_KIND_LABELS[kind] ?? kind;
}

/** The card title: the file title (top level or the desk's meta.title), the id when absent. */
export function displayTitleOf(ticket: McTicket): string {
  const title = ticket.title?.trim() ?? ticket.meta.title?.trim() ?? '';
  return title === '' ? ticket.id : title;
}

/** The urgent/high priority flag. */
export function isFlaggedTicket(ticket: McTicket): boolean {
  const priority = ticket.meta.priority;
  return priority === 'urgent' || priority === 'high';
}

/** The blocked marker: open blockers as derived, else the raw `blocked-by` list. */
export function isBlockedTicket(ticket: McTicket): boolean {
  return (ticket.blocked?.length ?? 0) > 0 || (ticket.meta.blockedBy?.length ?? 0) > 0;
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
): TicketVm {
  const personaId = ticket.meta.persona ?? null;
  return {
    ticket,
    id: ticket.id,
    title: displayTitleOf(ticket),
    phaseId: column.phase.id,
    phaseTitle: column.phase.title,
    phaseColor: column.phase.color ?? null,
    persona: personaId === null ? null : (personas.get(personaId) ?? null),
    flagged: isFlaggedTicket(ticket),
    blocked: isBlockedTicket(ticket),
  };
}

/**
 * The groups in render order: the needs-you group first (only when
 * something waits), then one group per board column, in board order.
 * Empty columns keep their group; `board` null (nothing fetched yet)
 * yields just the needs group.
 */
export function groupsOf(
  needs: readonly McNeed[],
  board: McBoard | null,
  personas: readonly McPersona[],
): WorkGroup[] {
  const personaMap = personaMapOf(personas);
  const groups: WorkGroup[] = [];
  if (needs.length > 0) {
    groups.push({
      kind: 'needs',
      key: 'needs',
      title: 'Needs you',
      needs: needs.map((need, index) => ({
        key: needKeyOf(need, index),
        need,
        kindLabel: needKindLabelOf(need.kind),
      })),
    });
  }
  if (board !== null) {
    for (const column of board.columns) {
      groups.push({
        kind: 'phase',
        key: `phase:${column.phase.id}`,
        phaseId: column.phase.id,
        title: column.phase.title,
        unknown: column.unknown === true,
        tickets: column.tickets.map((ticket) => ticketVmOf(ticket, column, personaMap)),
      });
    }
  }
  return groups;
}

type PhaseGroup = Extract<WorkGroup, { readonly kind: 'phase' }>;

function isPhaseGroup(group: WorkGroup): group is PhaseGroup {
  return group.kind === 'phase';
}

/**
 * The group a card in `phaseId` moves on to: the next phase group in
 * render order. The needs group is not a phase; unknown phase groups
 * render but never take a move, so a ticket sitting in one — or in the
 * last phase — has nothing to advance to (null).
 */
export function nextPhaseOf(groups: readonly WorkGroup[], phaseId: string): PhaseGroup | null {
  const phases = groups.filter(
    (group): group is PhaseGroup => isPhaseGroup(group) && !group.unknown,
  );
  const index = phases.findIndex((group) => group.phaseId === phaseId);
  return index < 0 || index + 1 >= phases.length ? null : phases[index + 1]!;
}
