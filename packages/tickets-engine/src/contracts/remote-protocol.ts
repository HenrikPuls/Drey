/**
 * The tickets remote's contract (req-66, ADR-0086): what a host offers
 * the remote gateway, independent of the host. In Drey the adapter in
 * `main/remote/drey-port.ts` implements it over the board and the fleet
 * client; a later standalone or VS Code host implements the same
 * interface and the gateway and phone client stay unchanged.
 */
import type {
  AnswerCommand,
  AttachmentCommand,
  ClaimCommand,
  CreateCommand,
  RefineCommand,
  PermissionCommand,
  SendCommand,
  StartRunCommand,
  StopRunCommand,
  TicketIdCommand,
  TransitionCommand,
} from '../core/commands';
import type { ChatDecisionResult, ChatSession, ChatSessionMeta, ChatStreamEvent, ChatTurnResult, PlanStatus } from './chat';
import type { FleetSnapshot } from '../services/fleet-client';
import type { ChainMaster, ChainStatus, ColumnMode, WaitQuestion } from '../fleet/protocol';
import type { ShapedQuestion } from './question-shape';
import type { BoardSnapshot, CreateResult, MutationResult, TicketCard } from './tickets';
import type { ImprovementProposal, ImprovementState } from '../core/improvements';
import type { Persona, PersonaRouter } from '../core/persona';
import type { ScoutReport } from './scout';

/** What the "Needs you" list holds, in the order it shows them. */
export type NeedKind =
  | 'question'
  | 'permission'
  | 'red-gate'
  | 'failed'
  | 'checkpoint'
  | 'improvements'
  /** E7: an open decision key in the ticket's status log. */
  | 'needs-decision'
  /** E7: an open blocker in the ticket's status log. */
  | 'blocked'
  /** E8 (concept §5.6): a scout ticket's report waits for the owner. */
  | 'report'
  /** E9 (concept §5.7): a chain gate with a Bescheid rule just completed. */
  | 'notify';

/** One thing that waits on the owner. */
export interface NeedItem {
  readonly kind: NeedKind;
  readonly ticketId: string;
  readonly title: string;
  /** The pipeline phase id the ticket sits in. */
  readonly phase: string;
  /** The run it concerns; null for a checkpoint ticket. */
  readonly runId: string | null;
  /** The question, the tool call, the gate failure — or '' for a checkpoint. */
  readonly text: string;
  /** Since when it waits (ISO); null when unknown. */
  readonly since: string | null;
  /** A question form's fields (OpenCode's `question` tool); absent otherwise. */
  readonly questions?: readonly WaitQuestion[];
  /** A `QUESTION:` turn's parsed fixed shape (req-75 W2); absent when the text does not follow it. */
  readonly shaped?: ShapedQuestion;
  /** E8 (concept §5.6): the parsed scout report; present exactly on a 'report' need. */
  readonly report?: ScoutReport;
}

export type RunReply = { readonly ok: boolean; readonly error?: string; readonly runId?: string };
export type ChainReply = { readonly ok: true; readonly status: ChainStatus } | { readonly ok: false; readonly error: string };

/** The 1:1's two outcomes (E6); an open proposal carries none of them yet. */
export type ImprovementDecision = Exclude<ImprovementState, 'open'>;

/**
 * The E6 improvements card (concept §4.8): one persona's proposals file
 * plus the counts that gate the aggregation and the "needs you" entry.
 * `frictionCount` is the raw findings still waiting in friction.md.
 */
export type PersonaImprovementsReply =
  | {
      readonly ok: true;
      readonly persona: Persona;
      readonly proposals: readonly ImprovementProposal[];
      readonly openCount: number;
      readonly frictionCount: number;
    }
  | { readonly ok: false; readonly error: string };
export type RemoteChange = 'board' | 'fleet' | 'remote' | 'chat';

/**
 * The persona thread's read (U4, concept §4.5): the coaching protocol's
 * messages, file order (oldest first). Only owner messages exist today.
 */
export type PersonaThreadReply =
  | { readonly ok: true; readonly messages: readonly { readonly at: string; readonly role: 'owner'; readonly text: string }[] }
  | { readonly ok: false; readonly error: string };

/**
 * The persona memory's read (U4, concept §4.4): the curated entries in
 * file order (oldest first), each with its pin state. The pin toggle's
 * `index` addresses this list.
 */
export type PersonaMemoryReply =
  | { readonly ok: true; readonly entries: readonly { readonly text: string; readonly pinned: boolean }[] }
  | { readonly ok: false; readonly error: string };

/** The chain's persona pause (U4): applied, with the state echoed back. */
export type ChainPersonaPauseReply =
  | { readonly ok: true; readonly persona: string; readonly paused: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * What a `chat` change carries to the subscribers (and the `/api/events`
 * SSE payload): the session file the stream event belongs to and the
 * event itself. Board/fleet/remote changes carry no payload.
 */
export interface ChatChangePayload {
  readonly file: string;
  readonly event: ChatStreamEvent;
}
/** A refine's outcome: the new revision, or why not (`conflict` when the file changed meanwhile). */
// The reply shapes live in the engine contracts (ADR-0088, E2a) — this
// re-export keeps every existing import path working.
export type { RefineReply, TicketReply, AttachmentReply } from './replies';
import type { RefineReply, TicketReply, AttachmentReply } from './replies';
import type { EstimateKey, RunEstimate } from '../core/estimate';
import type { ReviewComment } from '../core/review-feedback';
import type { TicketDiff, TicketFileReply, WorktreeFile } from '../core/worktree-changes';

/**
 * The host's remote surface. Every writing call carries the actor the
 * ticket Log records (`owner@<device>`); the gateway derives it from the
 * paired device, never from the request.
 */
export interface TicketsRemotePort {
  board(): Promise<BoardSnapshot>;
  fleet(): Promise<FleetSnapshot>;
  needs(): Promise<readonly NeedItem[]>;
  ticket(id: string): Promise<TicketReply>;

  create(cmd: CreateCommand, actor: string): Promise<CreateResult>;
  move(cmd: TransitionCommand, actor: string): Promise<MutationResult>;
  claim(cmd: ClaimCommand, actor: string): Promise<MutationResult>;
  archive(cmd: TicketIdCommand, actor: string): Promise<MutationResult>;
  refine(cmd: RefineCommand, actor: string): Promise<RefineReply>;
  /** Saves a device's image upload under `tickets/attachments/` (req-66 R8). */
  saveAttachment(cmd: AttachmentCommand, actor: string): Promise<AttachmentReply>;

  startRun(cmd: StartRunCommand): Promise<RunReply>;
  stopRun(cmd: StopRunCommand): Promise<RunReply>;
  /**
   * The Team tab's "Hand to Claude Code" (E12-4): stops a stuck run and starts
   * the same ticket again on the Claude Code worker, fresh.
   */
  handoffRun(cmd: { readonly runId: string }): Promise<RunReply>;
  send(cmd: SendCommand): Promise<RunReply>;
  answer(cmd: AnswerCommand): Promise<RunReply>;
  permission(cmd: PermissionCommand): Promise<RunReply>;
  /** The run's stream tail (ndjson); '' when the runner has none. */
  stream(runId: string): Promise<string>;

  chainMaster(mode: ChainMaster): Promise<ChainReply>;
  chainColumn(phase: string, mode: ColumnMode): Promise<ChainReply>;
  chainColumnStop(phase: string): Promise<ChainReply>;
  chainAbort(): Promise<ChainReply>;

  /** The team: every persona, read-only (the Team tab's cards). */
  personas(): Promise<readonly PersonaView[]>;

  /** The persona chat's read (U4, concept §4.5): the coaching thread's owner messages. */
  personaThread(personaId: string): Promise<PersonaThreadReply>;
  /** Appends one owner message to the coaching thread; one commit. */
  personaThreadAppend(cmd: { readonly persona: string; readonly text: string }): Promise<PersonaThreadReply>;
  /** The persona memory's read (U4, concept §4.4): entries with their pin state. */
  personaMemory(personaId: string): Promise<PersonaMemoryReply>;
  /** Appends one owner-taught memory entry; one commit. */
  personaMemoryAppend(cmd: { readonly persona: string; readonly text: string }): Promise<PersonaMemoryReply>;
  /** Flips one memory entry's pin (index = its position in the GET list); one commit. */
  personaMemoryPin(cmd: { readonly persona: string; readonly index: number; readonly pinned: boolean }): Promise<PersonaMemoryReply>;
  /** The persona setup's PATCH (U4, concept §4.5): only sent keys are written; one commit. */
  personaPatch(cmd: {
    readonly persona: string;
    readonly title?: string;
    readonly role?: string;
    readonly worker?: string;
    readonly model?: string;
    readonly pool?: readonly string[];
    readonly router?: PersonaRouter;
    readonly color?: string;
    readonly skills?: readonly string[];
    readonly prompt?: string;
  }): Promise<MutationResult>;
  /** The chain's persona pause (U4): a paused persona's tickets hold until played again. */
  chainPersonaPause(cmd: { readonly persona: string; readonly paused: boolean }): Promise<ChainPersonaPauseReply>;

  /** The E6 improvements card: one persona's proposals, open count and friction count. */
  personaImprovements(personaId: string): Promise<PersonaImprovementsReply>;
  /** The E6 1:1 decision (apply = accepted, dismiss = dismissed); one commit on the desk. */
  personaImprovementDecide(cmd: { readonly persona: string; readonly proposal: string; readonly decision: ImprovementDecision }): Promise<MutationResult>;

  /** The phone edit mode's raw-text save (E5c). */
  ticketSave(cmd: { id: string; text: string; baseRevision?: string }, actor: string): Promise<RefineReply>;
  /** The proof card's accept — merges/archives per the pipeline (E5c). */
  ticketAccept(cmd: TicketIdCommand, actor: string): Promise<MutationResult>;
  /** The proof card's send-back; the note is mandatory (E5c). */
  ticketSendBack(cmd: { id: string; note: string; comments?: readonly ReviewComment[] }, actor: string): Promise<MutationResult>;
  /** The proof card's file stat list (E5c). */
  ticketWorktreeChanges(id: string): Promise<readonly WorktreeFile[]>;
  /** The proof card's unified diff (E5c). */
  ticketDiff(id: string): Promise<TicketDiff>;
  /** A file on the ticket's branch for the diff's "Whole file" view (E11-2). */
  ticketFile(id: string, path: string): Promise<TicketFileReply>;
  /** The run estimate from the owner's own history; null below three similar runs (E11-4). */
  estimate(key: EstimateKey): Promise<RunEstimate | null>;

  /** The Mission Control chat surface (E5a) — the service's port verbatim. */
  chatSessions(): Promise<readonly ChatSessionMeta[]>;
  chatOpen(file: string): Promise<ChatSession | null>;
  chatSend(input: { readonly file: string; readonly text: string; readonly planEdits?: boolean }): Promise<ChatTurnResult>;
  chatStart(input: { readonly title?: string; readonly text: string; readonly ticket?: string }): Promise<ChatTurnResult>;
  /** The shared plan's state: version, the owner's edits since the model's last turn, the line marks (E10-2). */
  planStatus(ticket: string): Promise<PlanStatus>;
  chatConfirm(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;
  chatDismiss(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;

  /** Board, fleet, remote or chat changed; returns the unsubscribe. Chat changes carry their stream payload. */
  onChanged(listener: (what: RemoteChange, payload?: ChatChangePayload) => void): () => void;
}

/**
 * The team card's persona shape (E5b): the display slice of the
 * persona directory, without prompt and memory.
 */
export interface PersonaView {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly worker: string;
  /** The default model (`models.default`). */
  readonly model: string;
  readonly pool: readonly string[];
  /** `#rrggbb`; the chips' and avatars' colour. */
  readonly color: string;
  /**
   * The persona's daily budget in USD (frontmatter `budget:`, concept
   * §4.3 — the Team card shows the day's costs against it); null = none.
   */
  readonly budget: number | null;
  /**
   * What the persona's runs settled for TODAY (UTC day, summed from the
   * fleet ledger's `run_settled` costs). Present only when a known cost
   * exists — absent means "nothing settled today or the costs are
   * unknown", never a fake 0.
   */
  readonly dailyCost?: number;
  /**
   * The phase ids whose pipeline entry names this persona (`persona:` in
   * pipeline.md, U4) — the Team card's phase assignment, derived from the
   * board snapshot at read time. Present even when empty once a board
   * exists; absent on older servers.
   */
  readonly phases?: readonly string[];
  /**
   * The chain's persona pause (U4, concept §4.3 "Pausieren"): true while
   * the dispatcher holds this persona's tickets. Absent when the chain
   * state is unknown (the runner is down) — never a guessed false.
   */
  readonly paused?: boolean;
}

/**
 * The Log actor for a paired device (`owner@ipad`): the device name
 * lowercased and reduced to `[a-z0-9-]`, so it fits the schema's
 * `<who>@<host>` grammar; an empty result falls back to `remote`.
 */
export function remoteActorOf(deviceName: string): string {
  const host = deviceName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `owner@${host === '' ? 'remote' : host}`;
}
