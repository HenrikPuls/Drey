/**
 * The plan to accept's view models and pure helpers (E10-4, concept v2
 * §5.9, design boards "iPad: Plan to accept" and the phone's full-screen
 * version): one card per part, the owner's list edits, the start rule,
 * the build estimate (only with at least three similar runs, decision
 * D9) and Mission Control's proposal. The wire is `GET/POST
 * /api/tickets/<id>/parts` and `POST …/release`; nothing here imports
 * engine code.
 *
 * No overlap, no touched files, no routing: decision D5 dropped them.
 */
import { InjectionToken } from '@angular/core';
import { estimateText, noEstimateText } from '../../../../shared/cost-text';
import type { I18n } from '../../../../shared/i18n';
import type { McEstimate, McPartCard, McPartFlowStep, McPartPersona, McPlanApproval, McPlanStatus } from '../api/dto';

export type McApproveReply = { readonly ok: true; readonly tickets?: readonly string[] } | { readonly ok: false; readonly error: string };

/** The owner's list edits, as the desk takes them. */
export type McPartsEdit =
  | { readonly op: 'persona'; readonly index: number; readonly persona: string | null }
  | { readonly op: 'move'; readonly from: number; readonly to: number }
  | { readonly op: 'delete'; readonly index: number };

/** Exactly what the plan-to-approve screen consumes of the app state. */
export interface McApproveState {
  /** The ticket whose plan is up for approval; null = the screen is closed. */
  open(): string | null;
  /** The cards as the desk answered; null while they load. */
  approval(): McPlanApproval | null;
  /** The last load failure; null when all is well. */
  error(): string | null;
  readOnly(): boolean;
  /** The build gate's estimate for a persona on its own model; null = no basis (fewer than three similar runs). */
  estimate(gate: string, persona: string): McEstimate | null;
  /** One list edit (persona pick, move, delete). */
  edit(edit: McPartsEdit): Promise<McApproveReply>;
  /** The approval: `all` new parts or only the `first` one. */
  release(scope: 'all' | 'first'): Promise<McApproveReply>;
  /** The ticket's text (the phone's Goal); absent = no Goal section. */
  ticketText?(id: string): Promise<string | null>;
  /** The plan's version and the owner's edits (the phone's title line and highlights). */
  planStatus?(id: string): McPlanStatus | null;
  /** What the ticket's runs cost so far (the phone's Cost row); null = nothing known. */
  spent?(id: string): number | null;
  /** The ticket's state in words (the phone's pill). */
  phaseTitle?(id: string): string;
  /** A reply on the plan: the shape dialog opens with the text in the composer. */
  replyInShape?(text: string): void;
  /** Opens the flow editor on one part's flow (E10-5). */
  changeFlow(part: number): void;
  /** Back to the shape dialog: the split changes in the plan or by asking Mission Control. */
  changeSplit(): void;
  close(): void;
  openTicket(id: string): void;
}

export const MC_APPROVE_STATE = new InjectionToken<McApproveState>('mc-approve-state');

// --- the cards ---------------------------------------------------------------

/** The person a part is built by: the pinned persona, else the default builder. */
/** The Ready to try stage's id (`pipeline-states.ts`): the lib does not reach the engine at runtime. */
const READY_STATE = 'ready';

/** The Flow row of the iPad's plan (board 5c): Shape is done, the first step is the one the plan waits at. */
export interface PadFlowLine {
  readonly past: string;
  readonly current: string;
  readonly note: string | null;
  readonly rest: string;
}

/**
 * The desktop card's line (`flowItemsOf`): a plan page sits after Shape and before its
 * first step, and the owner's Accept ends the flow, whatever the Ready stage is called.
 */
export function padFlowLineOf(flow: readonly McPartFlowStep[], waitsForYou: boolean, i18n: I18n): PadFlowLine | null {
  const live = flow.filter((step) => !step.skipped && step.phase !== READY_STATE);
  const [current, ...rest] = live;
  if (current === undefined) {
    return null;
  }
  return {
    past: `✓ ${i18n.t('ticket.flow.shape')}`,
    current: current.title,
    note: waitsForYou ? i18n.t('ticket.flow.waits_for_you') : null,
    rest: `· ${[...rest.map((step) => step.title), i18n.t('ticket.flow.accept')].join(' · ')}`,
  };
}

export function builderOf(card: McPartCard, approval: McPlanApproval): McPartPersona | null {
  const id = card.persona ?? approval.defaultPersona;
  return id === null ? null : (approval.personas.find((p) => p.id === id) ?? { id, title: id, role: '', color: '', model: '' });
}

/** A persona's display name; the id when the persona file is gone. */
export function personaNameOf(id: string | null, approval: McPlanApproval): string {
  return id === null ? '' : (approval.personas.find((p) => p.id === id)?.title ?? id);
}

/** The state badge of a released part; '' for one that is still a line of the plan. */
export function partBadgeOf(card: McPartCard): string {
  switch (card.state) {
    case 'running':
      return '● running · locked';
    case 'queued':
      return '● queued · locked';
    case 'active':
      return `● ${card.phase ?? 'in progress'} · locked`;
    case 'done':
      return '✓ done · locked';
    default:
      return '';
  }
}

/** One segment of the flow row: `Build · Ben`, an inserted gate with its mark, a skipped one struck. */
export interface FlowSegment {
  readonly text: string;
  readonly inserted: boolean;
  readonly skipped: boolean;
}

export function flowSegmentsOf(card: McPartCard, approval: McPlanApproval): FlowSegment[] {
  return card.flow.map((step: McPartFlowStep) => {
    const who = personaNameOf(step.persona, approval);
    const base = who === '' ? step.title : `${step.title} · ${who}`;
    return { text: step.notify ? `${base} (tell me)` : base, inserted: step.inserted, skipped: step.skipped };
  });
}

/** `standard` when the part runs the pipeline as it is, else how many changes it carries. */
export function flowNoteOf(card: McPartCard): string {
  return card.chain.length === 0 ? 'standard' : `standard + ${card.chain.length} ${card.chain.length === 1 ? 'change' : 'changes'}`;
}

/** The "Gate" line under a card: what lets the next part start. The last part has none. */
export function gateLineOf(index: number, total: number): string | null {
  return index < total - 1 ? `Part ${index + 2} starts when this one is done.` : null;
}

// --- the estimate ----------------------------------------------------------------

/** A dollar figure the way every cost slot writes it: `$1.87`. */
export function dollarsOf(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The card's estimate in the canvas's one format (decision 20): the
 * middle half of the similar runs with its basis, `$3.00–5.20 · from 3
 * runs`, or `no estimate yet (first run)` where there is no basis (D9).
 */
export function estimateLineOf(i18n: I18n, estimate: McEstimate | null): string {
  return estimate === null ? noEstimateText(i18n) : estimateText(i18n, estimate);
}

/**
 * The foot's total over the parts that are still to run: the summed
 * median of those that have a basis, with how many that covers. Parts
 * already released do not count — they cost what they cost.
 */
export function totalLineOf(i18n: I18n, estimates: readonly (McEstimate | null)[]): string {
  const known = estimates.filter((e): e is McEstimate => e !== null);
  if (known.length === 0) {
    return noEstimateText(i18n);
  }
  const ranged = known.every((e) => e.costLow !== null && e.costHigh !== null);
  const sum = {
    // The parts' runs are summed as the fewest basis any of them rests on: the claim only holds that far.
    runs: Math.min(...known.map((e) => e.runs)),
    cost: known.reduce((total, e) => total + e.cost, 0),
    costLow: ranged ? known.reduce((total, e) => total + e.costLow!, 0) : null,
    costHigh: ranged ? known.reduce((total, e) => total + e.costHigh!, 0) : null,
  };
  const text = estimateText(i18n, sum);
  return known.length < estimates.length
    ? i18n.t('cost.estimate.partial', { estimate: text, known: known.length, total: estimates.length })
    : text;
}

// --- Mission Control's proposal ----------------------------------------------------

export interface PlanProposal {
  /** What Mission Control proposes, in one or two sentences. */
  readonly text: string;
  /** The button that approves all of it; null = nothing is left to release. */
  readonly approveLabel: string | null;
  /** The second button; null when only one part is left to release. */
  readonly firstLabel: string | null;
}

/**
 * Mission Control's proposal for the parts still to release. Nothing
 * runs before the owner taps (the iron rule); the text only says what
 * the tap does and in which order.
 */
export function proposalOf(cards: readonly McPartCard[]): PlanProposal {
  const open = cards.filter((c) => !c.locked);
  if (cards.length === 0) {
    return { text: 'This plan lists no parts yet.', approveLabel: null, firstLabel: null };
  }
  if (open.length === 0) {
    return { text: 'Every part is released. Follow them on Work.', approveLabel: null, firstLabel: null };
  }
  const first = open[0]!;
  const released = cards.length - open.length;
  const lead =
    released === 0
      ? `Mission Control proposes to accept all ${open.length} parts.`
      : `Mission Control proposes to release the ${open.length === 1 ? 'last part' : `remaining ${open.length} parts`}.`;
  const rule =
    first.index === 0
      ? 'Part 1 runs now; each part after it starts when the one before it is done.'
      : `Part ${first.index + 1} starts when part ${first.index} is done; each part after it follows the one before.`;
  return {
    text: `${lead} ${rule}`,
    approveLabel: 'Accept and run',
    firstLabel: open.length > 1 ? `Run part ${first.index + 1} only` : null,
  };
}

/** Whether a card may move one place up or down (the same rules the desk enforces). */
export function moveRoomOf(cards: readonly McPartCard[], index: number): { readonly up: boolean; readonly down: boolean } {
  const card = cards[index];
  if (card === undefined || card.locked) {
    return { up: false, down: false };
  }
  const above = cards[index - 1];
  const below = cards[index + 1];
  return { up: above !== undefined && !above.locked, down: below !== undefined };
}
