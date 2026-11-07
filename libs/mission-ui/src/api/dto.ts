/**
 * Mission Control's view models and the tolerant mappers that build them
 * from the gateway's JSON (E5b). The mappers never import the engine
 * packages — the local readonly interfaces below are the contract the
 * components code against, and every mapper forgives missing or mistyped
 * fields with defaults instead of throwing: a partial desk answer must
 * never white-screen the phone.
 */
import { autopilotSwitchViewOf, autopilotViewOf, type AutopilotView } from '../../../../shared/autopilot';
import { maskFences } from '../../../../shared/markdown/fences';

// --- Work ------------------------------------------------------------------

/**
 * A priority id from the vault's configured vocabulary — `urgent` in the
 * default list, or whatever pipeline.md's `priorities:` names (`p0`,
 * `critical`, …). The vocabulary is the desk's, never a fixed four: the
 * id IS the label. The order of the list IS the weight: first is highest.
 */
export type McPriority = string;

/** The default vocabulary — what a board without `priorities:` gets. */
export const DEFAULT_PRIORITY_CONFIG: McPriorityConfig = {
  order: ['urgent', 'high', 'normal', 'low'],
  default: 'normal',
};

/**
 * The board's priority vocabulary (`/api/board` `priorities`, the desk's
 * PriorityConfig): `order` in weight order (first = highest), `default`
 * is what a ticket without `priority:` reads as.
 */
export interface McPriorityConfig {
  readonly order: readonly string[];
  readonly default: string;
}

/**
 * What a ticket's settled fleet runs consumed (the engine's TicketUsage,
 * contracts/tickets.ts — mirrored here tolerantly; the app imports no
 * engine file): tokens in/out summed over the ledger's `run_settled`
 * lines, the summed cost (null when no run reported a known one — a
 * missing cost is never a 0), the run count.
 */
export interface McTicketUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number | null;
  readonly runs: number;
}

/** One ticket as the Work tab's card renders it (concept §7: one ticket = one card). */
export interface TicketCardView {
  readonly id: string;
  readonly title: string;
  /** The pipeline phase the card currently sits in. */
  readonly phase: string;
  /** The configured priority id; null when the card carries none. */
  readonly priority: McPriority | null;
  /** The persona pin (`null` = the ladder decides). */
  readonly personaId: string | null;
  readonly claimedBy: string | null;
  /** The open blocker ids (`[]` = unblocked). */
  readonly blocked: readonly string[];
  /** The settled-run usage off the ledger; absent when the desk has none — the cost slots hide. */
  readonly usage?: McTicketUsage;
}

/** One board column as a card group. */
export interface GroupView {
  readonly id: string;
  readonly title: string;
  readonly cards: readonly TicketCardView[];
}

export interface WorkView {
  readonly groups: readonly GroupView[];
  /** The board's priority vocabulary; the default list when the desk omits or junks it. */
  readonly priorities: McPriorityConfig;
}

// --- Needs -----------------------------------------------------------------

/** One scout decision as the report card renders it (E8, concept §5.6). */
export interface ScoutDecisionView {
  /** The decision's short key (`D1`, `D2`, …); '' when the desk mangled it. */
  readonly key: string;
  readonly question: string;
  /** The scout's recommendation; null when the decision carries none. */
  readonly recommendation: string | null;
  readonly resolved: boolean;
}

/** The parsed `## Report` riding on a 'report' need — the card's detail body. */
export interface ScoutReportView {
  /** ISO stamp; '' when the desk omitted it. */
  readonly writtenAt: string;
  /** The persona id; '' when unknown. */
  readonly by: string;
  /** The `### Summary` block; '' when absent. */
  readonly summary: string;
  readonly decisions: readonly ScoutDecisionView[];
}

/**
 * One option of a worker's question form (the engine's WaitQuestion
 * option, fleet/protocol.ts — mirrored here tolerantly): the choice's
 * label and its description line; absent description reads as null.
 */
export interface WaitOptionView {
  readonly label: string;
  readonly description: string | null;
}

/**
 * One question of a worker's question form (the engine's WaitQuestion,
 * fleet/protocol.ts — mirrored here tolerantly): the form field the
 * answer goes to (`q0`, `q1`, …), the short header, the question text,
 * the choices (the owner may answer in their own words too) and whether
 * several may be picked.
 */
export interface WaitQuestionView {
  readonly key: string;
  readonly header: string | null;
  readonly question: string;
  readonly options: readonly WaitOptionView[];
  readonly multiple: boolean;
}

/** One numbered option of a shaped `QUESTION:` turn (question-shape.ts). */
export interface ShapedOptionView {
  readonly n: number;
  readonly label: string;
  /** What the option concretely does; null when the line named none. */
  readonly consequence: string | null;
}

/**
 * A `QUESTION:` turn's parsed fixed shape (the engine's ShapedQuestion,
 * contracts/question-shape.ts, req-75 W2 — mirrored here tolerantly):
 * the question, its context lines and the 2–4 numbered options with the
 * recommended one's `n`.
 */
export interface ShapedQuestionView {
  readonly question: string;
  /** The "Ticket:" line. */
  readonly context: string | null;
  /** The "Where:" line. */
  readonly where: string | null;
  /** The "Why:" line. */
  readonly why: string | null;
  readonly options: readonly ShapedOptionView[];
  /** The recommended option's `n`; null without a valid recommendation. */
  readonly recommended: number | null;
  readonly recommendationWhy: string | null;
}

/** One thing that waits on the owner, as the Needs-you list renders it. */
export interface NeedView {
  readonly kind: string;
  /** The column the ticket stands in; absent when the need names none. */
  readonly phase?: string;
  readonly ticketId: string | null;
  readonly title: string;
  readonly summary: string;
  /** E8: the parsed scout report; present exactly on a 'report' need. */
  readonly report?: ScoutReportView;
  /**
   * The run the need concerns (the engine's NeedItem.runId); null for a
   * checkpoint/report. The option card's answer addresses it.
   */
  readonly runId?: string | null;
  /** A question form's fields (OpenCode's `question` tool); absent otherwise. */
  readonly questions?: readonly WaitQuestionView[];
  /** A `QUESTION:` turn's parsed fixed shape (req-75 W2); absent otherwise. */
  readonly shaped?: ShapedQuestionView;
}

// --- Chain delta (E9, concept §5.7) ----------------------------------------------

/**
 * One `chain:` delta entry as the desk parsed it (the engine's ChainEntry,
 * contracts/chain.ts) — mirrored here tolerantly; the ticket screen's
 * model carries the same shape (`ticket/ticket.model.ts` stays the owner
 * of the render logic, this is the wire slice).
 */
export interface McChainEntry {
  readonly kind: 'insert' | 'skip' | 'notify';
  readonly phase: string;
  readonly anchor: string | null;
  readonly position: 'after' | 'before' | null;
  readonly persona: string | null;
  readonly notify: boolean;
}

// --- Team ------------------------------------------------------------------

/** A persona's live run, folded in from the fleet snapshot. */
export type RunStateView =
  'starting' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed' | 'detached';

export interface PersonaRun {
  readonly ticketId: string;
  readonly state: RunStateView;
}

/** The persona's routing policy inside its pool (the engine's PersonaRouter). */
export type PersonaRouterView = 'off' | 'budget' | 'escalate-on-fail';

/** One live run of a persona, as the Team card's run rows render it (E12-4). */
export interface LiveRunView {
  readonly runId: string;
  readonly ticketId: string;
  readonly state: RunStateView;
  /** The worker provider (`opencode`, `claude-code`). */
  readonly provider: string;
  /** ISO stamp of the start; '' when the desk omits it. */
  readonly startedAt: string;
  /** ISO stamp of the last worker event; '' when the desk omits it. */
  readonly lastActivity: string;
  /** What the worker is doing right now, in one short line; null when unknown. */
  readonly activity: string | null;
  /** The hang watchdog flagged the run ("looks stuck"). */
  readonly stuck: boolean;
  /** The context window's fill, 0 – 100; null while the provider reported none. */
  readonly contextPct: number | null;
}

/** One provider pool's load: running runs against the pool's effective size. */
export interface CapacityView {
  readonly provider: string;
  readonly label: string;
  readonly running: number;
  readonly size: number;
}

/** One team card: the persona directory slice plus what it is running now. */
export interface PersonaView {
  readonly id: string;
  /** `human` = the owner as a team member (E10-6); absent = an agent. */
  readonly kind?: 'agent' | 'human';
  readonly title: string;
  readonly role: string;
  readonly worker: string;
  readonly model: string;
  /** The persona's model pool (the assignment ring); `[]` when the desk omits it. */
  readonly pool: readonly string[];
  /** `#rrggbb`; the avatar ring's colour. */
  readonly color: string;
  /** The newest live run this persona dispatched, if any. */
  readonly currentRun: PersonaRun | null;
  /** Every live run of this persona (a builder may carry several); absent = none known. */
  readonly liveRuns?: readonly LiveRunView[];
  /**
   * The persona's daily budget in dollars (frontmatter `budget:`,
   * concept §4.3 — the team card shows the day's costs against it);
   * null = none set (or junk on the wire — never a guess).
   */
  readonly budget: number | null;
  /**
   * What the persona's runs settled for TODAY, summed off the ledger's
   * `run_settled` costs; absent when no known cost exists — never a fake 0.
   */
  readonly dailyCost?: number;
  /**
   * The chain phases the persona serves (the assignment's `phases:`),
   * in chain order; absent when the desk omits them — the team card's
   * phases slot hides then, never a fake empty line.
   */
  readonly phases?: readonly string[];
  /**
   * True while the owner paused this persona in the chain; absent when
   * the desk does not report it (the fleet's `pausedPersonas` list is
   * the fallback the card consults then).
   */
  readonly paused?: boolean;
  /**
   * The skill files under `_meta/skills/` the persona carries; absent
   * when the desk omits them — the setup tab's skills group hides then.
   */
  readonly skills?: readonly string[];
  /**
   * The routing policy inside the pool; absent when the desk omits it —
   * the setup tab reads that as the `off` its cycle starts from.
   */
  readonly router?: PersonaRouterView;
}

export interface TeamView {
  readonly personas: readonly PersonaView[];
  /** The fleet's runs with their raw state — the work tab counts the live ones. */
  readonly runs: readonly { readonly state: string | null; readonly ticketId?: string }[];
  /**
   * The chain master switch off the fleet snapshot (`run` dispatches,
   * `halted` lets running work finish); null = unknown — the team's
   * master strip shows its idle face instead of guessing.
   */
  readonly chainMaster?: 'run' | 'halted' | null;
  /** The Autopilot off the chain block (req-95b); absent while the desk reports no chain. */
  readonly autopilot?: AutopilotView;
  /** The persona ids the owner paused in the chain; `[]` when the desk sends none. */
  readonly pausedPersonas?: readonly string[];
  /** Per provider pool: running against effective size; absent when the desk sends no pool sizes. */
  readonly capacity?: readonly CapacityView[];
}

// --- Persona improvements (E6) ------------------------------------------------

/**
 * One aggregation proposal as the persona detail (the 1:1, concept §4.8)
 * renders it — the unit the owner applies or dismisses.
 */
export interface ImprovementProposalView {
  readonly id: string;
  readonly state: 'open' | 'accepted' | 'dismissed';
  /** The proposal's target — 'prompt.md', 'models.default' or 'memory'. */
  readonly target: string;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly content: string;
  readonly lesson: string | null;
  /** ISO stamp of the proposal; '' when the desk omits it. */
  readonly at: string;
  /** ISO stamp of the decision; null while open. */
  readonly decidedAt: string | null;
}

/**
 * The `GET /api/personas/<id>/improvements` answer as the 1:1 renders it:
 * the persona's directory facts, its proposals and the two counters the
 * header shows.
 */
export interface PersonaImprovementsView {
  /** The persona directory slice; null when the desk omitted it (the header falls back to the id). */
  readonly persona: PersonaView | null;
  readonly proposals: readonly ImprovementProposalView[];
  readonly openCount: number;
  readonly frictionCount: number;
}

// --- Persona thread & memory (the 1:1's chat and memory tabs) -----------------

/**
 * One message of a persona's 1:1 thread (`GET /api/personas/<id>/thread`):
 * the sender's role ('owner' = the device owner, anything else reads as
 * the persona), the text, the ISO stamp — '' when the desk omitted it.
 */
export interface PersonaThreadMessageView {
  readonly role: 'owner' | 'persona';
  readonly text: string;
  readonly at: string;
}

export interface PersonaThreadView {
  readonly messages: readonly PersonaThreadMessageView[];
}

/**
 * One memory entry (`GET /api/personas/<id>/memory`): the line's text
 * itself and whether it is pinned (pinned entries sort first desk-side
 * and carry the accent border here).
 */
export interface PersonaMemoryEntryView {
  readonly text: string;
  readonly pinned: boolean;
}

export interface PersonaMemoryView {
  readonly entries: readonly PersonaMemoryEntryView[];
}

/**
 * The persona fields a setup change rewrites in one commit
 * (`PATCH /api/personas/<id>`): every field optional — the desk applies
 * only what the patch carries.
 */
export interface PersonaPatch {
  readonly title?: string;
  readonly role?: string;
  readonly worker?: string;
  readonly model?: string;
  readonly pool?: readonly string[];
  readonly router?: PersonaRouterView;
  readonly color?: string;
  readonly skills?: readonly string[];
  readonly prompt?: string;
}

/** One thread message off the wire; null when the desk sent no usable text. */
function threadMessageOf(raw: unknown): PersonaThreadMessageView | null {
  const message = rec(raw);
  if (message === null) {
    return null;
  }
  const text = str(message['text']);
  if (text === '') {
    return null;
  }
  return {
    role: message['role'] === 'owner' ? 'owner' : 'persona',
    text,
    at: str(message['at']),
  };
}

/**
 * The persona thread answer (`{messages}`) tolerantly mapped; junk yields
 * an empty thread — a torn message drops out instead of throwing.
 */
export function parsePersonaThread(json: unknown): PersonaThreadView {
  return {
    messages: arr(rec(json)?.['messages'])
      .map(threadMessageOf)
      .filter((message): message is PersonaThreadMessageView => message !== null),
  };
}

/**
 * The persona memory answer (`{entries}`) tolerantly mapped; junk yields
 * no entries — the memory tab then shows its empty state.
 */
export function parsePersonaMemory(json: unknown): PersonaMemoryView {
  return {
    entries: arr(rec(json)?.['entries'])
      .map((raw) => {
        const entry = rec(raw);
        if (entry === null) {
          return null;
        }
        const text = str(entry['text']);
        return text === '' ? null : { text, pinned: entry['pinned'] === true };
      })
      .filter((entry): entry is PersonaMemoryEntryView => entry !== null),
  };
}

// --- Chat ------------------------------------------------------------------

export interface SessionMeta {
  readonly file: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Pending proposal cards — the sessions list bolds it. */
  readonly pending: number;
  /** The ticket a shape session shapes (E10-3); absent on a plain chat. */
  readonly ticket?: string;
}

export interface ChatMessageView {
  readonly role: 'owner' | 'mission';
  readonly text: string;
  /** The mission's thinking trace, folded away after completion. */
  readonly thought: string | null;
  /** ISO stamp. */
  readonly at: string;
  /**
   * `plan-edit` = the "You edited the plan" card (E10-2), `text` its summary;
   * `question` = Paul's answer card (E10-3), `text` the question; `split` =
   * his split proposal, `text` the reason.
   */
  readonly kind?: 'plan-edit' | 'question' | 'split';
  /** The diff the model read; only on a plan-edit card. */
  readonly diff?: string | null;
  /** The answer card's choices; only on a question. */
  readonly options?: readonly ChatQuestionOptionView[];
  /** How many tickets the plan's parts would make; only on a split proposal. */
  readonly parts?: number;
  /** The owner's choice on a split proposal; null while open. */
  readonly decision?: 'keep' | 'split' | null;
}

export interface ChatQuestionOptionView {
  readonly label: string;
  readonly recommended: boolean;
}

export interface ChatProposalView {
  readonly id: string;
  readonly state: 'pending' | 'confirmed' | 'dismissed';
  readonly summary: string;
  /** ISO stamp of the proposal; '' when the desk omits it. */
  readonly at: string;
  /** ISO stamp of the decision; null while pending. */
  readonly decidedAt: string | null;
  /** The outcome line the execution reported; null while pending. */
  readonly outcome: string | null;
  /**
   * E9 (concept §5.7): the setChain command the card wraps — the
   * before/after confirmation renders the proposed delta from it;
   * present exactly on a setChain proposal.
   */
  readonly chain?: { readonly id: string; readonly chain: readonly string[] };
}

export interface ActiveSession {
  readonly file: string;
  readonly title: string;
  readonly createdAt: string;
  readonly messages: readonly ChatMessageView[];
  readonly proposals: readonly ChatProposalView[];
  /** The ticket whose plan this session shapes (E10); null = a plain chat. */
  readonly ticket?: string | null;
  /** The repository files Paul read in this shape session (E10-3). */
  readonly sources?: readonly string[];
  /** The model that answers a shape session, for the context line. */
  readonly model?: string;
}

export interface ChatStateView {
  readonly sessions: readonly SessionMeta[];
  readonly active: ActiveSession | null;
}

/** The streaming unit the SSE `chat` events carry (mirrors the desk's ChatStreamEvent). */
export type ChatStreamView =
  | { readonly kind: 'thought'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'proposal'; readonly proposal: ChatProposalView }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string };

/** One `/api/events` frame as a typed union (`unknown` for names the app does not use). */
export type McEvent =
  | { readonly kind: 'board' }
  | { readonly kind: 'needs' }
  | { readonly kind: 'fleet' }
  | { readonly kind: 'remote' }
  | { readonly kind: 'chat'; readonly file: string; readonly event: ChatStreamView }
  | { readonly kind: 'unknown'; readonly name: string };

// --- Ticket screen (E5c) -----------------------------------------------------

/** One acceptance criterion's proof line from `### Criteria`. */
export interface VerificationCriterionView {
  /** The backticked command, exactly as written under the Plan. */
  readonly command: string;
  readonly passed: boolean;
  /** The screenshot file from `→ ![](../attachments/<name>)`; null when the run captured none. */
  readonly screenshot: string | null;
  /** The em-dash note ('— no screenshot: …'); null when the line carries none. */
  readonly note: string | null;
}

/**
 * The `## Verification` section as the proof card renders it (concept
 * §5.3): the Tested-on stamp, the criteria checklist with their screenshot
 * proofs, the findings list. Absent section means "not verified yet".
 */
export interface VerificationView {
  readonly testedAt: string;
  readonly tester: string;
  readonly environment: string;
  readonly criteria: readonly VerificationCriterionView[];
  readonly findings: readonly string[];
}

/** One phase of the current board view; the ticket's own phase is the highlighted one. */
export interface TicketPhaseOption {
  readonly id: string;
  readonly title: string;
}

/**
 * One `## Verlauf` line (concept §5.4 — the engine's VerlaufEntry,
 * core/verlauf.ts, mirrored here tolerantly; the app imports no engine
 * file): the machine-maintained record of one COMPLETED run — phase,
 * persona, model, the short token count, the dollars, the whole minutes
 * and the outcome.
 */
export interface McVerlaufEntry {
  readonly phase: string | null;
  readonly persona: string | null;
  readonly model: string | null;
  /** The compact token words the Log uses too (`48k`, `3.4M`, `800`); '' when the line lost it. */
  readonly tokens: string;
  readonly cost: number | null;
  /** Whole minutes (`12m`); '' when the line lost it. */
  readonly dauer: string;
  /** The settled outcome (`handed-over`/`failed`/`stopped`); null when unreadable. */
  readonly ausgang: string | null;
}

/**
 * Reads the ticket's `## Verlauf` chapter tolerantly — the same
 * asymmetric-tolerance rule as the engine's `parseVerlaufEntries`: an
 * absent heading yields no entries, a torn or hand-edited line degrades
 * to nulls and '' instead of throwing. The chapter ends at the next H2.
 */
export function parseVerlaufEntries(fileText: string): readonly McVerlaufEntry[] {
  if (typeof fileText !== 'string') {
    return [];
  }
  const scan = maskFences(fileText);
  const heading = /^##\s+Verlauf\s*$/m.exec(scan);
  if (heading === null) {
    return [];
  }
  const rest = scan.slice(heading.index);
  const bodyStart = rest.indexOf('\n') + 1;
  const next = /^## /gm.exec(rest.slice(bodyStart));
  const section = next === null ? rest : rest.slice(0, bodyStart + next.index);
  const entries: McVerlaufEntry[] = [];
  for (const line of section.split('\n')) {
    const match = /^- \{(.+)\}\s*$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const pair of match[1]!.split(',')) {
      const at = pair.indexOf(':');
      if (at === -1) {
        continue;
      }
      fields.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    const field = (key: string): string | null => {
      const value = fields.get(key);
      return value === undefined || value === '' || value === 'null' ? null : value;
    };
    const costRaw = field('cost');
    const cost = costRaw === null || Number.isNaN(Number(costRaw)) ? null : Number(costRaw);
    entries.push({
      phase: field('phase'),
      persona: field('persona'),
      model: field('model'),
      tokens: fields.get('tokens') ?? '',
      cost,
      dauer: fields.get('dauer') ?? '',
      ausgang: field('ausgang'),
    });
  }
  return entries;
}

/** One comment of a ticket kept in a dricket store (E14-6); `verb` names a status line (`needs-decision`, `blocked`, `resolved` ...). */
export interface McTicketComment {
  readonly author: string;
  /** ISO stamp of the comment file. */
  readonly at: string;
  readonly text: string;
  readonly verb: string | null;
  readonly key: string | null;
}

/** The loaded ticket document plus what the screen's chrome renders around it. */
export interface TicketDetail {
  readonly id: string;
  readonly title: string;
  /** The loaded file's revision — the base revision the next save sends. */
  readonly revision: string;
  /** The full markdown, exactly as the desk stores it. */
  readonly text: string;
  readonly verification: VerificationView | null;
  /** The phases of the current board view. */
  readonly phases: readonly TicketPhaseOption[];
  /** The card's phase (the highlighted entry of `phases`). */
  readonly phase: string;
  /**
   * The `chain:` delta parsed off the card's meta (E9, concept §5.7);
   * empty = the standard flow applies silently.
   */
  readonly chain: readonly McChainEntry[];
  /**
   * The ticket's priority id as the vault configures it — the id IS the
   * label (the vocabulary is the desk's, never a fixed four); null when
   * the card carries none.
   */
  readonly priority: McPriority | null;
  /** The `blocked-by:` ids as written (T-0050); `[]` when absent. */
  readonly blockedBy: readonly string[];
  /** The OPEN blockers, derived on the desk; `[]` = unblocked or omitted. */
  readonly blocked: readonly string[];
  /** The derived inverse: ids this ticket currently blocks; `[]` when omitted. */
  readonly blocks: readonly string[];
  /** The settled-run usage off the card (the head cost slot's figure); absent when the desk has none. */
  readonly usage?: McTicketUsage;
  /**
   * The `## Verlauf` chapter's entries parsed off the ticket text
   * (tolerantly, never throwing); empty = the file carries no chapter.
   */
  readonly verlauf: readonly McVerlaufEntry[];
  /** The ticket's comments, oldest first; absent when the desk keeps none (the files backend). */
  readonly comments?: readonly McTicketComment[];
}

/** One file's git patch off `/api/tickets/<id>/diff`. */
export interface TicketDiffFileView {
  readonly status: string;
  readonly path: string;
  readonly patch: string;
}

/** The worktree-vs-base diff the proof card renders as git (concept §5.3). */
export interface TicketDiffView {
  readonly files: readonly TicketDiffFileView[];
  readonly truncated: boolean;
}

// --- the mappers ------------------------------------------------------------

const rec = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const arr = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const strArray = (value: unknown): readonly string[] =>
  arr(value).filter((item): item is string => typeof item === 'string');

const isoNow = (): string => new Date().toISOString();

/**
 * The card's priority id as written — the vocabulary is the vault's, so
 * any non-empty string passes; anything else (missing, junk) reads as
 * none, never a guess.
 */
function priorityOf(value: unknown): McPriority | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The board's `priorities` read tolerantly: the order keeps its readable
 * strings (trimmed; junk and duplicates drop, first wins), an unreadable
 * or empty list takes the default vocabulary, and a `default` the order
 * does not hold derives from the split point (`floor(len/2)` — the
 * desk's own rule).
 */
export function parsePriorities(raw: unknown): McPriorityConfig {
  const body = rec(raw);
  if (body === null) {
    return DEFAULT_PRIORITY_CONFIG;
  }
  const order: string[] = [];
  for (const entry of arr(body['order'])) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (id !== '' && !order.includes(id)) {
      order.push(id);
    }
  }
  if (order.length === 0) {
    return DEFAULT_PRIORITY_CONFIG;
  }
  const named = typeof body['default'] === 'string' ? body['default'].trim() : '';
  return {
    order,
    default:
      named !== '' && order.includes(named)
        ? named
        : (order[Math.floor(order.length / 2)] ?? DEFAULT_PRIORITY_CONFIG.default),
  };
}

/**
 * The jump class (the desk's req-63 split, mirrored): the vocabulary
 * divides at `floor(len/2)` — the entries before it jump the queue (the
 * work card's flag accent), the entry at it is the default reading, the
 * rest is the calm half. An id the order does not know never jumps.
 */
export function isJumpPriority(priority: string | null, order: readonly string[]): boolean {
  if (priority === null) {
    return false;
  }
  const at = order.indexOf(priority);
  return at >= 0 && at < Math.floor(order.length / 2);
}

/** One chain entry's wire JSON; null when nothing renderable survives (no kind or no phase). */
function chainEntryOf(raw: unknown): McChainEntry | null {
  const entry = rec(raw);
  if (entry === null) {
    return null;
  }
  const phase = str(entry['phase']);
  if (phase === '') {
    return null;
  }
  const kind = str(entry['kind']);
  if (kind === 'skip' || kind === 'notify') {
    return { kind, phase, anchor: null, position: null, persona: null, notify: false };
  }
  if (kind === 'insert') {
    const anchor = str(entry['anchor']);
    if (anchor === '') {
      return null;
    }
    return {
      kind: 'insert',
      phase,
      anchor,
      position: entry['position'] === 'before' ? 'before' : 'after',
      persona: strOrNull(entry['persona']),
      notify: entry['notify'] === true,
    };
  }
  return null;
}

/** The `chain:` delta's wire JSON as entry views; junk entries drop out, never a throw. */
export function chainEntriesOf(raw: unknown): readonly McChainEntry[] {
  return arr(raw)
    .map(chainEntryOf)
    .filter((entry): entry is McChainEntry => entry !== null);
}

/**
 * The card's usage figure, tolerantly mapped; undefined when the wire
 * carries none (or nothing usable) — the cost slots hide then, never a
 * 0-fake. Junk counters read as 0, a missing or non-numeric cost as null.
 */
export function usageOf(raw: unknown): McTicketUsage | undefined {
  const usage = rec(raw);
  if (usage === null) {
    return undefined;
  }
  return {
    tokensIn: countOf(usage['tokensIn'], 0),
    tokensOut: countOf(usage['tokensOut'], 0),
    cost:
      typeof usage['cost'] === 'number' && Number.isFinite(usage['cost']) ? usage['cost'] : null,
    runs: countOf(usage['runs'], 0),
  };
}

function cardOf(raw: unknown, phaseFallback: string): TicketCardView {
  const card = rec(raw) ?? {};
  const meta = rec(card['meta']) ?? {};
  const phase = str(card['phase'], phaseFallback) || phaseFallback;
  const usage = usageOf(card['usage']);
  return {
    id: str(card['id'], str(meta['id'])),
    title: str(card['title'], str(meta['title'])) || str(card['id'], 'untitled'),
    phase,
    priority: priorityOf(meta['priority']),
    personaId: strOrNull(meta['persona']),
    claimedBy: strOrNull(meta['claimedBy']),
    blocked: strArray(card['blocked']),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** The board JSON (`{columns, checkpoints}`) as card groups; junk yields no groups. */
export function parseWork(json: unknown): WorkView {
  const board = rec(json);
  if (board === null) {
    return { groups: [], priorities: DEFAULT_PRIORITY_CONFIG };
  }
  const groups: GroupView[] = [];
  for (const raw of arr(board['columns'])) {
    const column = rec(raw);
    const phase = rec(column?.['phase']) ?? {};
    const id = str(phase['id']);
    if (column === null || id === '') {
      continue;
    }
    const cards = arr(column['tickets'])
      .map((ticket) => cardOf(ticket, id))
      .filter((card) => card.id !== '');
    groups.push({
      id,
      title: str(phase['title'], id),
      cards,
    });
  }
  return {
    groups,
    priorities: parsePriorities(board['priorities']),
  };
}

/** One decision's JSON; null when nothing renderable survives (no key and no question). */
function scoutDecisionOf(raw: unknown): ScoutDecisionView | null {
  const decision = rec(raw);
  if (decision === null) {
    return null;
  }
  const key = str(decision['key']);
  const question = str(decision['question']);
  if (key === '' && question === '') {
    return null;
  }
  return {
    key,
    question,
    recommendation: strOrNull(decision['recommendation']),
    resolved: decision['resolved'] === true,
  };
}

/**
 * The `report` field of a 'report' need; undefined when the desk sent
 * nothing usable — the card then shows the headline line alone (the
 * asymmetric-tolerance rule: absence reads as "no detail", never a guess).
 */
function scoutReportOf(raw: unknown): ScoutReportView | undefined {
  const report = rec(raw);
  if (report === null) {
    return undefined;
  }
  return {
    writtenAt: str(report['writtenAt']),
    by: str(report['by']),
    summary: str(report['summary']),
    decisions: arr(report['decisions'])
      .map(scoutDecisionOf)
      .filter((decision): decision is ScoutDecisionView => decision !== null),
  };
}

/**
 * A question form's field, tolerantly mapped (the engine's WaitQuestion);
 * null when the wire sent nothing usable — the option card degrades to
 * the plain question text then.
 */
function waitQuestionOf(raw: unknown): WaitQuestionView | null {
  const item = rec(raw);
  if (item === null) {
    return null;
  }
  const key = str(item['key']);
  const question = str(item['question']);
  if (key === '' || question === '') {
    return null;
  }
  return {
    key,
    header: strOrNull(item['header']),
    question,
    options: arr(item['options'])
      .map((option) => {
        const body = rec(option);
        return body === null
          ? null
          : { label: str(body['label']), description: strOrNull(body['description']) };
      })
      .filter((option): option is WaitOptionView => option !== null && option.label !== ''),
    multiple: item['multiple'] === true,
  };
}

/** One numbered option of a shaped question; null when the wire sent no label. */
function shapedOptionOf(raw: unknown): ShapedOptionView | null {
  const item = rec(raw);
  if (item === null) {
    return null;
  }
  const label = str(item['label']);
  if (label === '') {
    return null;
  }
  const n = typeof item['n'] === 'number' && Number.isFinite(item['n']) ? item['n'] : 0;
  return { n, label, consequence: strOrNull(item['consequence']) };
}

/**
 * A `QUESTION:` turn's fixed shape, tolerantly mapped (the engine's
 * ShapedQuestion); null when the wire sent nothing usable. Options the
 * shape cannot read drop out; an unreadable recommendation reads as none.
 */
function shapedQuestionOf(raw: unknown): ShapedQuestionView | null {
  const item = rec(raw);
  if (item === null) {
    return null;
  }
  const question = str(item['question']);
  if (question === '') {
    return null;
  }
  const recommended =
    typeof item['recommended'] === 'number' && Number.isFinite(item['recommended'])
      ? item['recommended']
      : null;
  return {
    question,
    context: strOrNull(item['context']),
    where: strOrNull(item['where']),
    why: strOrNull(item['why']),
    options: arr(item['options'])
      .map(shapedOptionOf)
      .filter((option): option is ShapedOptionView => option !== null),
    recommended,
    recommendationWhy: strOrNull(item['recommendationWhy']),
  };
}

/** The needs JSON (`[{kind, ticketId?, title, summary}]`); junk yields no needs. */
export function parseNeeds(json: unknown): NeedView[] {
  const NEED_KINDS = [
    'question',
    'permission',
    'red-gate',
    'failed',
    'checkpoint',
    'improvements',
    'needs-decision',
    'blocked',
    'report',
    /** E9 (concept §5.7): a chain gate with a Bescheid rule just completed. */
    'notify',
    /** E10-6: a ticket parked at a manual step. */
    'manual',
  ];
  const needs: NeedView[] = [];
  for (const raw of arr(json)) {
    const item = rec(raw);
    if (item === null) {
      continue;
    }
    const kind = str(item['kind']);
    const report = kind === 'report' ? scoutReportOf(item['report']) : undefined;
    const questions =
      kind === 'question'
        ? arr(item['questions'])
            .map(waitQuestionOf)
            .filter((q): q is WaitQuestionView => q !== null)
        : [];
    const shaped = kind === 'question' ? shapedQuestionOf(item['shaped']) : null;
    const runId = strOrNull(item['runId']);
    const need: NeedView = {
      kind: NEED_KINDS.includes(kind) ? kind : 'checkpoint',
      ...(typeof item['phase'] === 'string' ? { phase: item['phase'] } : {}),
      ticketId: strOrNull(item['ticketId']),
      title: str(item['title'], str(item['ticketId'], 'untitled')),
      summary: str(item['summary'], str(item['text'])),
      ...(report !== undefined ? { report } : {}),
      ...(runId !== null ? { runId } : {}),
      ...(questions.length > 0 ? { questions } : {}),
      ...(shaped !== null ? { shaped } : {}),
    };
    needs.push(need);
  }
  return needs;
}

/** Run states that mean "live on the board" (the rest is history). */
const LIVE_RUN_STATES: readonly RunStateView[] = ['starting', 'running', 'stopping', 'detached'];

/** Which tickets have a live run, as one comparable text: a change means the Needs-you list is stale (D-33). */
export function liveTicketsOf(runs: TeamView['runs']): string {
  return runs
    .filter((run) => LIVE_RUN_STATES.includes(run.state as RunStateView))
    .map((run) => run.ticketId ?? '')
    .sort()
    .join('|');
}

const runStateOf = (value: unknown): RunStateView | null =>
  LIVE_RUN_STATES.includes(value as RunStateView) ? (value as RunStateView) : null;

/** A non-negative money figure; junk (absent, mistyped, negative) reads as the fallback. */
const moneyOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** One persona directory entry, tolerantly mapped; null when the id is missing. */
function personaOf(raw: unknown): PersonaView | null {
  const persona = rec(raw);
  if (persona === null) {
    return null;
  }
  const id = str(persona['id']);
  if (id === '') {
    return null;
  }
  const dailyCost = moneyOf(persona['dailyCost']);
  const phases = strArray(persona['phases']);
  const skills = strArray(persona['skills']);
  const router = routerOf(persona['router']);
  const paused = personasPausedOf(persona['paused']);
  return {
    id,
    ...(persona['kind'] === 'human' ? { kind: 'human' as const } : {}),
    title: str(persona['title'], id),
    role: str(persona['role']),
    worker: str(persona['worker']),
    model: str(persona['model']),
    pool: strArray(persona['pool']),
    color: str(persona['color'], '#7aa2f7'),
    budget: moneyOf(persona['budget']),
    // A lone directory entry carries no fleet context; parseTeam folds the run in.
    currentRun: null,
    ...(dailyCost !== null ? { dailyCost } : {}),
    ...(phases.length > 0 ? { phases } : {}),
    ...(paused !== undefined ? { paused } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(router !== null ? { router } : {}),
  };
}

/** The persona's `paused` flag; undefined when the desk omits it or junks it. */
function personasPausedOf(value: unknown): boolean | undefined {
  return value === true ? true : value === false ? false : undefined;
}

/** The routing policy off the wire; anything unknown reads as omitted. */
function routerOf(value: unknown): PersonaRouterView | null {
  return value === 'budget' || value === 'escalate-on-fail' || value === 'off' ? value : null;
}

/**
 * The personas list with the fleet's live runs folded in: a persona's
 * `currentRun` is the newest run it dispatched that is still live. The
 * fleet snapshot's chain block rides along tolerantly — the master
 * switch's position and the paused-persona ids; a snapshot without them
 * leaves both unknown (`null` / `[]`).
 */
export function parseTeam(personasJson: unknown, fleetJson: unknown): TeamView {
  const fleet = rec(fleetJson) ?? {};
  const runs = arr(fleet['runs']);
  const chain = rec(fleet['chain']);
  const master = chain?.['master'];
  const chainMaster = master === 'run' || master === 'halted' ? master : null;
  // D-51: a snapshot that names no chain (`chain: null` — the runner is down,
  // req-110) reads as Off, so the switch stays usable; a snapshot without the
  // field at all leaves the Autopilot unknown.
  const autopilot = chain === null ? (fleet['chain'] === null ? autopilotSwitchViewOf(true, null) : null) : autopilotViewOf(chain);
  const pausedPersonas = strArray(fleet['pausedPersonas']);
  const capacity = capacityOf(chain, runs);
  const personas: PersonaView[] = [];
  for (const raw of arr(personasJson)) {
    const persona = personaOf(raw);
    if (persona === null) {
      continue;
    }
    const liveRun = runs
      .map((run) => rec(run))
      .find(
        (run) =>
          run !== null && str(run['persona']) === persona.id && runStateOf(run['state']) !== null,
      );
    const state = liveRun === null || liveRun === undefined ? null : runStateOf(liveRun['state']);
    const liveRuns = runs.flatMap((run): LiveRunView[] => {
      const r = rec(run);
      const runState = r === null ? null : runStateOf(r['state']);
      if (r === null || runState === null || str(r['persona']) !== persona.id) {
        return [];
      }
      return [liveRunOf(r, runState)];
    });
    personas.push({
      ...persona,
      ...(liveRuns.length > 0 ? { liveRuns } : {}),
      currentRun:
        liveRun === null || liveRun === undefined || state === null
          ? null
          : { ticketId: str(liveRun['ticketId']), state },
    });
  }
  return {
    personas,
    runs: runs
      .map((run) => rec(run))
      .map((run) => ({
        state: run !== null && typeof run['state'] === 'string' ? run['state'] : null,
        ...(run !== null && typeof run['ticketId'] === 'string' ? { ticketId: run['ticketId'] } : {}),
      })),
    ...(chainMaster !== null ? { chainMaster } : {}),
    ...(autopilot !== null ? { autopilot } : {}),
    ...(pausedPersonas.length > 0 ? { pausedPersonas } : {}),
    ...(capacity.length > 0 ? { capacity } : {}),
  };
}

const PROVIDER_LABEL: Readonly<Record<string, string>> = { opencode: 'Local', 'claude-code': 'Claude Code', kimi: 'Kimi Code' };

/** One live run, tolerantly mapped (the caller checked the state). */
function liveRunOf(run: Record<string, unknown>, state: RunStateView): LiveRunView {
  const tokens = run['contextTokens'];
  const window = run['contextWindow'];
  const pct =
    typeof tokens === 'number' && typeof window === 'number' && Number.isFinite(tokens) && window > 0
      ? Math.min(100, Math.round((tokens / window) * 100))
      : null;
  const activity = str(run['activity']);
  return {
    runId: str(run['id']),
    ticketId: str(run['ticketId']),
    state,
    provider: str(run['provider']),
    startedAt: str(run['startedAt']),
    lastActivity: str(run['lastActivity']),
    activity: activity === '' ? null : activity,
    stuck: run['stuck'] === true,
    contextPct: pct,
  };
}

/** The pools' load off the chain block's `poolSize` and the live runs per provider. */
function capacityOf(chain: Record<string, unknown> | null, runs: readonly unknown[]): CapacityView[] {
  const sizes = rec(chain?.['poolSize']);
  if (sizes === null) {
    return [];
  }
  const out: CapacityView[] = [];
  for (const provider of Object.keys(PROVIDER_LABEL)) {
    const size = sizes[provider];
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      continue;
    }
    const running = runs.filter((run) => {
      const r = rec(run);
      return r !== null && str(r['provider']) === provider && runStateOf(r['state']) !== null;
    }).length;
    out.push({ provider, label: PROVIDER_LABEL[provider]!, running, size });
  }
  return out;
}

/** The proposal's state; anything the desk got wrong degrades to open, never a guess. */
function improvementStateOf(value: unknown): 'open' | 'accepted' | 'dismissed' {
  return value === 'accepted' || value === 'dismissed' ? value : 'open';
}

function improvementProposalOf(raw: unknown): ImprovementProposalView | null {
  const proposal = rec(raw);
  if (proposal === null) {
    return null;
  }
  const id = str(proposal['id']);
  if (id === '') {
    return null;
  }
  return {
    id,
    state: improvementStateOf(proposal['state']),
    target: str(proposal['target']),
    title: str(proposal['title'], id),
    evidence: strArray(proposal['evidence']),
    content: str(proposal['content']),
    lesson: strOrNull(proposal['lesson']),
    at: str(proposal['at']),
    decidedAt: strOrNull(proposal['decidedAt']),
  };
}

/** A non-negative integer counter; anything else takes the fallback. */
function countOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

/**
 * The improvements answer (`{persona, proposals, openCount, frictionCount}`)
 * as the 1:1 renders it; null when the desk sent nothing usable. A
 * missing `openCount` falls back to counting the open proposals; a
 * missing `frictionCount` reads as 0; proposals without an id are dropped.
 */
export function parseImprovements(json: unknown): PersonaImprovementsView | null {
  const body = rec(json);
  if (body === null) {
    return null;
  }
  const proposals = arr(body['proposals'])
    .map(improvementProposalOf)
    .filter((proposal): proposal is ImprovementProposalView => proposal !== null);
  return {
    persona: personaOf(body['persona']),
    proposals,
    openCount: countOf(
      body['openCount'],
      proposals.filter((proposal) => proposal.state === 'open').length,
    ),
    frictionCount: countOf(body['frictionCount'], 0),
  };
}

function sessionMetaOf(raw: unknown): SessionMeta | null {
  const session = rec(raw);
  if (session === null) {
    return null;
  }
  const file = str(session['file']);
  if (file === '') {
    return null;
  }
  const pending =
    typeof session['pending'] === 'number' && Number.isFinite(session['pending'])
      ? Math.max(0, Math.trunc(session['pending']))
      : 0;
  return {
    file,
    title: str(session['title'], file),
    createdAt: str(session['createdAt']),
    updatedAt: str(session['updatedAt']),
    pending,
    ...(/^T-\d{4,}$/.test(str(session['ticket'])) ? { ticket: str(session['ticket']) } : {}),
  };
}

/** The sessions listing; junk yields no sessions. */
export function parseSessions(json: unknown): SessionMeta[] {
  return arr(json)
    .map(sessionMetaOf)
    .filter((session): session is SessionMeta => session !== null);
}

function messageOf(raw: unknown): ChatMessageView | null {
  const message = rec(raw);
  if (message === null) {
    return null;
  }
  return {
    role: message['role'] === 'owner' ? 'owner' : 'mission',
    text: str(message['text']),
    thought: strOrNull(message['thought']),
    at: str(message['at']),
    ...shapeCardOf(message),
  };
}

/** The kind-specific fields of the plan-edit, answer and split cards (E10-2/E10-3); nothing for a plain message. */
function shapeCardOf(message: Record<string, unknown>): Partial<ChatMessageView> {
  switch (message['kind']) {
    case 'plan-edit':
      return { kind: 'plan-edit', diff: strOrNull(message['diff']) };
    case 'question': {
      const options = arr(message['options'])
        .map((raw) => {
          const option = rec(raw);
          const label = option === null ? '' : str(option['label']);
          return label === '' ? null : { label, recommended: option?.['recommended'] === true };
        })
        .filter((option): option is ChatQuestionOptionView => option !== null);
      return options.length >= 2 ? { kind: 'question', options } : {};
    }
    case 'split': {
      const parts = typeof message['parts'] === 'number' && message['parts'] >= 1 ? Math.floor(message['parts']) : 1;
      const decision = message['decision'] === 'keep' || message['decision'] === 'split' ? message['decision'] : null;
      return { kind: 'split', parts, decision };
    }
    default:
      return {};
  }
}

function proposalOf(raw: unknown): ChatProposalView | null {
  const proposal = rec(raw);
  if (proposal === null) {
    return null;
  }
  const id = str(proposal['id']);
  const state = str(proposal['state']);
  const chain = chainCommandOf(proposal['command']);
  return {
    id,
    state: state === 'confirmed' || state === 'dismissed' ? state : 'pending',
    summary: str(proposal['summary']),
    at: str(proposal['at']),
    decidedAt: strOrNull(proposal['decidedAt']),
    outcome: strOrNull(proposal['outcome']),
    ...(chain !== undefined ? { chain } : {}),
  };
}

/**
 * The setChain payload of a proposal's command block; undefined when the
 * command is absent or another kind (the card then renders the summary
 * line alone — the asymmetric-tolerance rule).
 */
function chainCommandOf(
  raw: unknown,
): { readonly id: string; readonly chain: readonly string[] } | undefined {
  const command = rec(raw);
  if (command === null || str(command['kind']) !== 'setChain') {
    return undefined;
  }
  const id = str(command['id']);
  if (id === '') {
    return undefined;
  }
  return { id, chain: strArray(command['chain']) };
}

/** One proposal's JSON as the card view renders it; null when unusable. */
export function parseProposal(json: unknown): ChatProposalView | null {
  return proposalOf(json);
}

/**
 * Why a chat turn had no model (D-1, mirrors the desk's `ChatModelFailure`):
 * the error card shows provider, endpoint and reason. `code` picks the
 * card's headline.
 */
export interface ChatFailureView {
  readonly code: 'not-configured' | 'unsupported' | 'unreachable' | 'refused' | 'timeout';
  readonly providerLabel: string;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly reason: string;
  /** The session the turn belonged to (set by the app state); the card shows under that session only. */
  readonly file?: string;
}

const FAILURE_CODES: readonly ChatFailureView['code'][] = ['not-configured', 'unsupported', 'unreachable', 'refused', 'timeout'];

/** The `failure` of a refused chat turn; null when the answer carries none (or a malformed one). */
export function parseChatFailure(json: unknown): ChatFailureView | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const f = json as Record<string, unknown>;
  const code = FAILURE_CODES.find((c) => c === f['code']);
  if (code === undefined || typeof f['reason'] !== 'string') {
    return null;
  }
  return {
    code,
    providerLabel: str(f['providerLabel'], str(f['provider'], 'The model')),
    baseUrl: strOrNull(f['baseUrl']),
    model: strOrNull(f['model']),
    reason: f['reason'],
  };
}

/** One session's JSON; null when the desk sent nothing usable (e.g. the file is gone). */
export function parseActiveSession(json: unknown): ActiveSession | null {
  const session = rec(json);
  if (session === null) {
    return null;
  }
  const file = str(session['file']);
  if (file === '') {
    return null;
  }
  return {
    file,
    title: str(session['title'], file),
    createdAt: str(session['createdAt']),
    messages: arr(session['messages'])
      .map(messageOf)
      .filter((message): message is ChatMessageView => message !== null),
    proposals: arr(session['proposals'])
      .map(proposalOf)
      .filter((proposal): proposal is ChatProposalView => proposal !== null),
    ...(/^T-\d{4,}$/.test(str(session['ticket'])) ? { ticket: str(session['ticket']) } : {}),
    ...(strArray(session['sources']).length > 0 ? { sources: strArray(session['sources']) } : {}),
    ...(str(session['model']) !== '' ? { model: str(session['model']) } : {}),
  };
}

function parseStreamEvent(raw: unknown): ChatStreamView | null {
  const event = rec(raw);
  if (event === null) {
    return null;
  }
  switch (str(event['kind'])) {
    case 'thought':
      return { kind: 'thought', text: str(event['text']) };
    case 'text':
      return { kind: 'text', text: str(event['text']) };
    case 'proposal': {
      const proposal = proposalOf(event['proposal']);
      return proposal === null ? null : { kind: 'proposal', proposal };
    }
    case 'done':
      return { kind: 'done' };
    case 'error':
      return { kind: 'error', message: str(event['message'], 'the stream failed') };
    default:
      return null;
  }
}

/**
 * One `/api/events` frame as a typed union. `board`/`fleet`/`remote`
 * carry no payload; `chat` carries the `{file, event}` stream payload;
 * anything else (or a broken payload) lands on `unknown` and is ignored.
 */
export function parseChatEvent(name: string, data: string): McEvent {
  switch (name) {
    case 'board':
      return { kind: 'board' };
    case 'needs':
      return { kind: 'needs' };
    case 'fleet':
      return { kind: 'fleet' };
    case 'remote':
      return { kind: 'remote' };
    case 'chat': {
      let payload: unknown = null;
      try {
        payload = JSON.parse(data);
      } catch {
        payload = null;
      }
      const frame = rec(payload);
      const file = str(frame?.['file']);
      const event = parseStreamEvent(frame?.['event']);
      if (frame === null || file === '' || event === null) {
        return { kind: 'unknown', name };
      }
      return { kind: 'chat', file, event };
    }
    default:
      return { kind: 'unknown', name };
  }
}

// --- ticket screen mappers (E5c) ----------------------------------------------

const VERIFICATION_HEADING = '## Verification';

/** [start, end) of the `## Verification` block — end at the next H2 or EOF. */
function verificationBoundsOf(text: string): { start: number; end: number } | null {
  const heading = /^## Verification$/m.exec(maskFences(text));
  if (heading === null) {
    return null;
  }
  const rest = maskFences(text).slice(heading.index);
  const next = /^## /gm.exec(rest.slice(VERIFICATION_HEADING.length));
  const end =
    next === null ? text.length : heading.index + VERIFICATION_HEADING.length + next.index;
  return { start: heading.index, end };
}

/**
 * Reads the ticket's `## Verification` section tolerantly — the same
 * asymmetric-tolerance rule as the engine's `core/verification.ts`: an
 * absent heading means null ("not verified yet"), a partially unreadable
 * section degrades to defaults instead of throwing. The screenshot link
 * is the schema's `→ ![](../attachments/<name>)` proof reference.
 */
export function parseVerification(text: string): VerificationView | null {
  if (typeof text !== 'string') {
    return null;
  }
  const bounds = verificationBoundsOf(text);
  if (bounds === null) {
    return null;
  }
  const section = maskFences(text.slice(bounds.start, bounds.end));
  const tested =/^Tested on (\S+) by ([^—]+?)(?: — (.+?))?\.?$/m.exec(section);
  const criteria: VerificationCriterionView[] = [];
  const criterionRe =
    /^- \[([ xX])\] `([^`]+)`(?: → !\[\]\(\.\.\/attachments\/([^)]+)\))?(?: — (.+))?$/gm;
  for (let match = criterionRe.exec(section); match !== null; match = criterionRe.exec(section)) {
    criteria.push({
      command: match[2]!,
      passed: match[1]!.toLowerCase() === 'x',
      screenshot: match[3] ?? null,
      note: match[4] ?? null,
    });
  }
  const findings: string[] = [];
  const findingsAt = section.indexOf('### Findings');
  if (findingsAt >= 0) {
    for (const line of section.slice(findingsAt).split('\n')) {
      const match = /^- (.+)$/.exec(line.trim());
      if (match !== null) {
        findings.push(match[1]!);
      }
    }
  }
  return {
    testedAt: tested?.[1] ?? '',
    tester: tested?.[2]?.trim() ?? '',
    environment: tested?.[3]?.trim() ?? '',
    criteria,
    findings,
  };
}

/**
 * The `GET /api/tickets/<id>` answer (`{ok, card, text, revision}`) as the
 * ticket screen renders it; null when the desk sent no usable card. The
 * Verification section is parsed out of the full markdown; `phases` rides
 * along from the caller's current board view.
 */
export function parseTicketDetail(
  json: unknown,
  phases: readonly TicketPhaseOption[],
): TicketDetail | null {
  const body = rec(json);
  if (body === null || body['ok'] === false) {
    return null;
  }
  const card = rec(body['card']);
  if (card === null) {
    return null;
  }
  const meta = rec(card['meta']) ?? {};
  const id = str(card['id'], str(meta['id']));
  if (id === '') {
    return null;
  }
  const text = str(body['text']);
  const usage = usageOf(card['usage']);
  return {
    id,
    title: str(card['title'], str(meta['title'])) || id,
    revision: str(body['revision']),
    text,
    verification: parseVerification(text),
    phases,
    phase: str(card['phase']),
    chain: chainEntriesOf(meta['chain']),
    priority: priorityOf(meta['priority']),
    blockedBy: strArray(meta['blockedBy']),
    blocked: strArray(card['blocked']),
    blocks: strArray(card['blocks']),
    ...(usage !== undefined ? { usage } : {}),
    verlauf: parseVerlaufEntries(text),
    ...(commentsOf(body['comments']) !== undefined ? { comments: commentsOf(body['comments'])! } : {}),
  };
}

function commentsOf(value: unknown): readonly McTicketComment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: McTicketComment[] = [];
  for (const item of value) {
    const one = rec(item);
    if (one === null || str(one['text']) === '') {
      continue;
    }
    out.push({
      author: str(one['author']),
      at: str(one['at']),
      text: str(one['text']),
      verb: str(one['verb']) === '' ? null : str(one['verb']),
      key: str(one['key']) === '' ? null : str(one['key']),
    });
  }
  return out;
}

/**
 * One board card off `/api/board` by id — the chat's chain before/after
 * card reads the ticket's current delta and phase from it; null when the
 * board JSON holds no such card (a stale board degrades to no "before").
 */
export function parseBoardCard(
  json: unknown,
  id: string,
): { readonly phase: string; readonly chain: readonly McChainEntry[] } | null {
  const board = rec(json);
  for (const raw of arr(board?.['columns'])) {
    const column = rec(raw);
    for (const rawTicket of arr(column?.['tickets'])) {
      const card = rec(rawTicket);
      if (card === null || str(card['id']) !== id) {
        continue;
      }
      const meta = rec(card['meta']) ?? {};
      return { phase: str(card['phase']), chain: chainEntriesOf(meta['chain']) };
    }
  }
  return null;
}

/** The `/api/tickets/<id>/diff` answer as the proof card renders it; junk yields an empty diff. */
export function parseTicketDiff(json: unknown): TicketDiffView {
  const body = rec(json) ?? {};
  return {
    files: arr(body['files'])
      .map((raw) => rec(raw))
      .filter((file): file is Record<string, unknown> => file !== null)
      .map((file) => ({
        status: str(file['status']),
        path: str(file['path']),
        patch: str(file['patch']),
      }))
      .filter((file) => file.path !== ''),
    truncated: body['truncated'] === true,
  };
}

// --- the run estimate (E11-4) ---------------------------------------------------------

/** What the desk's `GET /api/estimate/<gate>/<persona>/<model>` answers when it has a basis. */
export interface McEstimate {
  readonly gate: string;
  readonly persona: string;
  readonly model: string;
  /** How many earlier runs the figures rest on (at least three). */
  readonly runs: number;
  readonly cost: number;
  /** The middle half's low and high end (req-98); null from an engine that sends only the median. */
  readonly costLow: number | null;
  readonly costHigh: number | null;
  readonly minutes: number | null;
  readonly tokens: number | null;
}

/** Reads the estimate answer tolerantly; null = no estimate (fewer than three similar runs, or junk). */
export function parseEstimate(json: unknown): McEstimate | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const raw = (json as Record<string, unknown>)['estimate'];
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const e = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const runs = num(e['runs']);
  const cost = num(e['cost']);
  if (typeof e['gate'] !== 'string' || typeof e['persona'] !== 'string' || typeof e['model'] !== 'string' || runs === null || cost === null || runs < 3) {
    return null;
  }
  return { gate: e['gate'], persona: e['persona'], model: e['model'], runs, cost, costLow: num(e['costLow']), costHigh: num(e['costHigh']), minutes: num(e['minutes']), tokens: num(e['tokens']) };
}

// --- the shared plan (E10-2) -----------------------------------------------------------

export interface McPlanMark {
  readonly no: number;
  readonly text: string;
  readonly by: 'you' | 'model';
}

/** Where a ticket's shared plan stands (`GET /api/tickets/<id>/plan`). */
export interface McPlanStatus {
  /** The model's turns that ended on this plan; null = it has not worked on it yet. */
  readonly version: number | null;
  /** The owner's edit groups since the model's last turn. */
  readonly edits: number;
  readonly summary: string | null;
  readonly marks: readonly McPlanMark[];
}

/** Reads the plan answer tolerantly; null = the desk has no readable plan. */
export function parsePlanStatus(json: unknown): McPlanStatus | null {
  const body = rec(json);
  if (body === null || body['ok'] !== true) {
    return null;
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const marks: McPlanMark[] = [];
  for (const raw of arr(body['marks'])) {
    const mark = rec(raw);
    const no = mark === null ? null : num(mark['no']);
    if (mark !== null && no !== null && no >= 1 && (mark['by'] === 'you' || mark['by'] === 'model')) {
      marks.push({ no, text: str(mark['text']), by: mark['by'] });
    }
  }
  return { version: num(body['version']), edits: num(body['edits']) ?? 0, summary: strOrNull(body['summary']), marks };
}

// --- the plan to accept (E10-4) -------------------------------------------------------

export type McPartState = 'new' | 'queued' | 'running' | 'active' | 'done';

/** One gate of a part's flow, from the build step on. */
export interface McPartFlowStep {
  readonly phase: string;
  readonly title: string;
  readonly persona: string | null;
  readonly inserted: boolean;
  readonly skipped: boolean;
  readonly notify: boolean;
}

/** One card of the plan to accept (`GET /api/tickets/<id>/parts`). */
export interface McPartCard {
  readonly index: number;
  readonly title: string;
  readonly reason: string | null;
  /** The pinned builder; null = the default builder decides. */
  readonly persona: string | null;
  readonly chain: readonly string[];
  readonly flow: readonly McPartFlowStep[];
  /** The ticket the part became; null while it is only a line of the plan. */
  readonly ticket: string | null;
  readonly state: McPartState;
  readonly phase: string | null;
  /** True once the part is a ticket: no move, delete or persona change. */
  readonly locked: boolean;
  readonly start: string;
}

export interface McPartPersona {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly color: string;
  readonly model: string;
}

export interface McPlanApproval {
  readonly ticket: string;
  readonly title: string;
  readonly parts: readonly McPartCard[];
  /** The build gate's phase id — the gate the estimate is asked for. */
  readonly gate: string;
  readonly defaultPersona: string | null;
  readonly personas: readonly McPartPersona[];
  readonly warnings: readonly string[];
}

const PART_STATES: ReadonlySet<string> = new Set(['new', 'queued', 'running', 'active', 'done']);

/** Reads the parts answer tolerantly; null = the desk has no readable parts for the ticket. */
export function parsePlanApproval(json: unknown): McPlanApproval | null {
  const body = rec(json);
  if (body === null || body['ok'] !== true || typeof body['ticket'] !== 'string') {
    return null;
  }
  const parts: McPartCard[] = [];
  for (const raw of arr(body['parts'])) {
    const card = rec(raw);
    if (card === null || typeof card['title'] !== 'string' || typeof card['index'] !== 'number') {
      continue;
    }
    const flow: McPartFlowStep[] = [];
    for (const rawStep of arr(card['flow'])) {
      const step = rec(rawStep);
      if (step !== null && typeof step['phase'] === 'string') {
        flow.push({
          phase: step['phase'],
          title: str(step['title'], step['phase']),
          persona: strOrNull(step['persona']),
          inserted: step['inserted'] === true,
          skipped: step['skipped'] === true,
          notify: step['notify'] === true,
        });
      }
    }
    const state = str(card['state']);
    parts.push({
      index: card['index'],
      title: card['title'],
      reason: strOrNull(card['reason']),
      persona: strOrNull(card['persona']),
      chain: arr(card['chain']).filter((c): c is string => typeof c === 'string'),
      flow,
      ticket: strOrNull(card['ticket']),
      state: PART_STATES.has(state) ? (state as McPartState) : 'new',
      phase: strOrNull(card['phase']),
      locked: card['locked'] === true,
      start: str(card['start']),
    });
  }
  const personas: McPartPersona[] = [];
  for (const raw of arr(body['personas'])) {
    const persona = rec(raw);
    if (persona !== null && typeof persona['id'] === 'string') {
      personas.push({
        id: persona['id'],
        title: str(persona['title'], persona['id']),
        role: str(persona['role']),
        color: str(persona['color']),
        model: str(persona['model']),
      });
    }
  }
  return {
    ticket: body['ticket'],
    title: str(body['title'], body['ticket']),
    parts,
    gate: str(body['gate'], 'build'),
    defaultPersona: strOrNull(body['defaultPersona']),
    personas,
    warnings: arr(body['warnings']).filter((w): w is string => typeof w === 'string'),
  };
}

// --- the flow editor (E10-5) --------------------------------------------------------------

/** Which flow: the ticket's own chain, or one part of a split plan. */
export type McFlowScope = { readonly kind: 'ticket' } | { readonly kind: 'part'; readonly index: number; readonly title: string };

/** One gate of a flow, from the current gate on (`GET /api/tickets/<id>/flow`). */
export interface McFlowStep {
  /** Position in the merged chain — what an edit addresses. */
  readonly index: number;
  readonly phase: string;
  readonly title: string;
  readonly state: 'current' | 'future';
  readonly inserted: boolean;
  readonly skipped: boolean;
  readonly moved: boolean;
  readonly notify: boolean;
  readonly persona: string | null;
  /** The delta pinned the persona. */
  readonly pinned: boolean;
  readonly model: string | null;
  /** A gate the owner works by hand. */
  readonly owner: boolean;
  readonly locked: boolean;
}

export interface McFlowPersona {
  readonly id: string;
  /** `human` = the owner (E10-6); the manual step offers only these. */
  readonly kind: 'agent' | 'human';
  readonly title: string;
  readonly color: string;
  readonly model: string;
}

export interface McFlow {
  readonly ticket: string;
  readonly title: string;
  readonly scope: McFlowScope;
  /** The chain shown: the saved delta, an edit's result or Paul's draft. */
  readonly chain: readonly string[];
  /** The delta in the file now. */
  readonly saved: readonly string[];
  readonly steps: readonly McFlowStep[];
  readonly phases: readonly { readonly id: string; readonly title: string }[];
  readonly personas: readonly McFlowPersona[];
  /** Why nothing can be saved (a live run, a released part); null = editable. */
  readonly readOnly: string | null;
  /** Paul's reason, present on a draft only. */
  readonly reason: string | null;
}

/** Reads a flow answer tolerantly; null = the desk has no readable flow. */
export function parseFlow(json: unknown): McFlow | null {
  const body = rec(json);
  if (body === null || body['ok'] !== true || typeof body['ticket'] !== 'string') {
    return null;
  }
  const scopeRaw = rec(body['scope']);
  const scope: McFlowScope =
    scopeRaw !== null && scopeRaw['kind'] === 'part' && typeof scopeRaw['index'] === 'number'
      ? { kind: 'part', index: scopeRaw['index'], title: str(scopeRaw['title']) }
      : { kind: 'ticket' };
  const steps: McFlowStep[] = [];
  for (const raw of arr(body['steps'])) {
    const step = rec(raw);
    if (step === null || typeof step['phase'] !== 'string' || typeof step['index'] !== 'number') {
      continue;
    }
    steps.push({
      index: step['index'],
      phase: step['phase'],
      title: str(step['title'], step['phase']),
      state: step['state'] === 'current' ? 'current' : 'future',
      inserted: step['inserted'] === true,
      skipped: step['skipped'] === true,
      moved: step['moved'] === true,
      notify: step['notify'] === true,
      persona: strOrNull(step['persona']),
      pinned: step['pinned'] === true,
      model: strOrNull(step['model']),
      owner: step['owner'] === true,
      locked: step['locked'] === true,
    });
  }
  const phases: { id: string; title: string }[] = [];
  for (const raw of arr(body['phases'])) {
    const phase = rec(raw);
    if (phase !== null && typeof phase['id'] === 'string') {
      phases.push({ id: phase['id'], title: str(phase['title'], phase['id']) });
    }
  }
  const personas: McFlowPersona[] = [];
  for (const raw of arr(body['personas'])) {
    const persona = rec(raw);
    if (persona !== null && typeof persona['id'] === 'string') {
      personas.push({
        id: persona['id'],
        kind: persona['kind'] === 'human' ? 'human' : 'agent',
        title: str(persona['title'], persona['id']),
        color: str(persona['color']),
        model: str(persona['model']),
      });
    }
  }
  const strings = (value: unknown): string[] => arr(value).filter((c): c is string => typeof c === 'string');
  return {
    ticket: body['ticket'],
    title: str(body['title'], body['ticket']),
    scope,
    chain: strings(body['chain']),
    saved: strings(body['saved']),
    steps,
    phases,
    personas,
    readOnly: strOrNull(body['readOnly']),
    reason: strOrNull(body['reason']),
  };
}
