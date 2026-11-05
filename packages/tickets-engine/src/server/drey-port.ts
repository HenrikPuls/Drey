/**
 * Drey's implementation of the tickets remote port (req-66, ADR-0086):
 * the board service and the fleet client behind the host-neutral
 * `TicketsRemotePort`. It adds only the remote's own policy — the actor
 * on every write and the refusal of bypass runs — and leaves every
 * board rule where it already lives.
 */
import type {
  AnswerCommand,
  AttachmentCommand,
  ClaimCommand,
  CreateCommand,
  PermissionCommand,
  RefineCommand,
  SendCommand,
  StartRunCommand,
  StopRunCommand,
  TicketIdCommand,
  TransitionCommand,
} from '../core/commands';
import { chainResult } from '../core/commands';
import type { FleetSnapshot } from '../services/fleet-client';
import type { ChainMaster, ChainStatus, ColumnMode, PermissionDecision, QuestionAnswers, RunInfo } from '../fleet/protocol';
import type {
  AttachmentReply,
  ChainPersonaPauseReply,
  ChainReply,
  ChatChangePayload,
  ImprovementDecision,
  NeedItem,
  PersonaImprovementsReply,
  PersonaMemoryReply,
  PersonaThreadReply,
  PersonaView,
  RemoteChange,
  RefineReply,
  RunReply,
  TicketReply,
  TicketsRemotePort,
} from '../contracts/remote-protocol';
import type { BoardSnapshot, CreateResult, MutationResult } from '../contracts/tickets';
import type { EstimateKey, RunEstimate } from '../core/estimate';
import type { PlanPartsEdit, PlanPartsReply, PlanReleaseReply, PlanReleaseScope } from '../contracts/plan-approval';
import type { FlowDraftReply, FlowOp, FlowReply, FlowSaveReply, FlowTarget } from '../contracts/flow';
import type { ReviewComment } from '../core/review-feedback';
import type { TicketDiff, TicketFileReply, WorktreeFile } from '../core/worktree-changes';
import type { ChatDecisionResult, ChatServicePort, ChatShapeResult, ChatSplitChoice, ChatSession, ChatSessionMeta, ChatTurnResult, PlanStatus } from '../contracts/chat';
import { IMPROVEMENTS_THRESHOLD } from '../core/improvements';
import { openStatusItems } from '../core/status-log';
import type { StatusLine } from '../core/status-log';
import { parseScoutReportSection } from '../core/scout';
import { parseLedger, personaDailyCosts } from '../core/ledger';
import { needsOf, notifyNeedsOf, reportNeedOf } from './needs';

/** How many status-log needs (E7) one needs() pass appends at most. */
const STATUS_NEEDS_CAP = 20;

/** The board service's part the remote uses (`BoardService` fits it). */
export interface RemoteBoard {
  refresh(): Promise<BoardSnapshot>;
  readTicket(id: string): Promise<TicketReply>;
  refineTicket(input: RefineCommand & { actor?: string }): Promise<RefineReply>;
  saveAttachment(input: AttachmentCommand & { actor?: string }): Promise<AttachmentReply>;
  createTicket(input: CreateCommand & { actor?: string }): Promise<CreateResult>;
  transition(input: TransitionCommand & { actor?: string }): Promise<MutationResult>;
  setClaim(input: ClaimCommand & { actor?: string }): Promise<MutationResult>;
  archive(input: TicketIdCommand & { actor?: string }): Promise<MutationResult>;
  startRun(input: StartRunCommand): Promise<RunReply>;
  /** The Team tab's cards (E5b). */
  listPersonas(): Promise<readonly import('../core/persona').Persona[]>;
  /** Creates the owner's own persona on first sight (E10-6); a fake without it is fine. */
  ensureHumanPersona?(): Promise<void>;
  /** The fleet ledger's raw text (`tickets/_meta/ledger.jsonl`); null without a vault or ledger. */
  ledgerText(): Promise<string | null>;
  /** The raw-text save behind the phone edit mode (E5c). */
  saveTicket(input: { id: string; text: string; baseRevision?: string; actor?: string }): Promise<RefineReply>;
  /** The proof card's unified diff (E5c). */
  ticketDiff(id: string): Promise<TicketDiff>;
  /** A file on the ticket's branch for the diff's "Whole file" view (E11-2). */
  ticketFile(id: string, path: string): Promise<TicketFileReply>;
  /** The run estimate from the owner's own history; null below three similar runs (E11-4). */
  estimateOf(key: EstimateKey): Promise<RunEstimate | null>;
  /** The plan to approve's cards, edits and release (E10-4). */
  planParts(id: string): Promise<PlanPartsReply>;
  flowOf(target: FlowTarget): Promise<FlowReply>;
  flowEdit(input: FlowTarget & { chain: readonly string[]; edit: FlowOp }): Promise<FlowReply>;
  saveFlow(input: FlowTarget & { chain: readonly string[]; actor?: string }): Promise<FlowSaveReply>;
  flowDraftContext(target: FlowTarget): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }>;
  editPlanParts(input: { id: string; edit: PlanPartsEdit; actor?: string }): Promise<MutationResult>;
  releasePlan(input: { id: string; scope: PlanReleaseScope; actor?: string }): Promise<PlanReleaseReply>;
  /** The proof card's file stat list (E5c). */
  worktreeChangesOf(id: string): Promise<readonly WorktreeFile[]>;
  /** The Ready card's accept (E5c). */
  acceptTicket(input: { id: string; actor?: string }): Promise<MutationResult>;
  /** The owner's answer to a Needs-you decision: a `resolved` status line / comment (E14-6). */
  answerNeed(input: { id: string; key?: string; text?: string; actor?: string }): Promise<MutationResult>;
  /** The proof card's send-back with a mandatory note (E5c). */
  sendBack(input: { id: string; note: string; actor?: string; comments?: readonly ReviewComment[] }): Promise<MutationResult>;
  /** The E6 improvements card: one persona's proposals and counts. */
  personaImprovements(personaId: string): Promise<PersonaImprovementsReply>;
  /** The E6 1:1 decision; the apply lands in exactly one commit on the desk. */
  decideImprovement(input: { id: string; proposalId: string; decision: ImprovementDecision; now?: string }): Promise<MutationResult>;
  /** The E7 status read: the ticket's status-log lines; [] when absent or broken. */
  statusOf(ticketId: string): Promise<readonly StatusLine[]>;
  /** The assembled board from the files (a read — no normalize, no migration). */
  snapshot(): Promise<BoardSnapshot>;
  /** The persona chat's read (U4, concept §4.5). */
  personaThread(personaId: string): Promise<PersonaThreadReply>;
  /** One owner message into the coaching thread; one commit. */
  personaThreadAppend(input: { id: string; text: string }): Promise<PersonaThreadReply>;
  /** The persona memory's read (U4, concept §4.4). */
  personaMemory(personaId: string): Promise<PersonaMemoryReply>;
  /** One owner-taught memory entry; one commit. */
  personaMemoryAppend(input: { id: string; text: string }): Promise<PersonaMemoryReply>;
  /** One memory entry's pin toggle (index = GET-list position); one commit. */
  personaMemoryPin(input: { id: string; index: number; pinned: boolean }): Promise<PersonaMemoryReply>;
  /** The persona setup's PATCH (U4): only sent keys written; one commit. */
  personaPatch(input: {
    id: string;
    title?: string;
    role?: string;
    worker?: string;
    model?: string;
    pool?: readonly string[];
    router?: string;
    color?: string;
    skills?: readonly string[];
    prompt?: string;
  }): Promise<MutationResult>;
}

/** The fleet client's part the remote uses (`FleetClient` fits it). */
export interface RemoteFleet {
  runs(): Promise<readonly RunInfo[]>;
  chainStatus(): Promise<ChainStatus | null>;
  stop(runId: string, reason: string | null): Promise<RunReply>;
  send(runId: string, text: string): Promise<RunReply>;
  answerPermission(runId: string, decision: PermissionDecision): Promise<RunReply>;
  answerQuestion(runId: string, answers: QuestionAnswers): Promise<RunReply>;
  stream(runId: string): Promise<string | null>;
  setMaster(mode: ChainMaster): Promise<ChainStatus | null>;
  setColumn(phase: string, mode: ColumnMode): Promise<ChainStatus | null>;
  stopColumn(phase: string): Promise<ChainStatus | null>;
  abortAll(): Promise<ChainStatus | null>;
  /** The persona pause (U4): a paused persona's tickets hold until played again. */
  setPersonaPaused(persona: string, paused: boolean): Promise<ChainStatus | null>;
}

/** Fan-out of board/fleet/remote/chat changes to the remote's listeners. */
export class ChangeHub {
  private readonly listeners = new Set<(what: RemoteChange, payload?: ChatChangePayload) => void>();

  /** Chat changes carry their stream payload; every other change travels bare. */
  emit(what: 'chat', payload: ChatChangePayload): void;
  emit(what: Exclude<RemoteChange, 'chat'>): void;
  emit(what: RemoteChange, payload?: ChatChangePayload): void {
    for (const listener of [...this.listeners]) {
      listener(what, payload);
    }
  }

  subscribe(listener: (what: RemoteChange, payload?: ChatChangePayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readonly pathListeners = new Set<(change: PathsChange) => void>();

  /**
   * The files an engine write touched (G-08 / D-3). Deliberately NOT a
   * RemoteChange: the gateway and the phone never see it -- only the Drey
   * plugin's own event stream carries it, to tell Drey's vault layer.
   */
  emitPaths(change: PathsChange): void {
    for (const listener of [...this.pathListeners]) {
      listener(change);
    }
  }

  subscribePaths(listener: (change: PathsChange) => void): () => void {
    this.pathListeners.add(listener);
    return () => this.pathListeners.delete(listener);
  }
}

/** Vault-relative paths one engine write changed / removed (a move = both). */
export interface PathsChange {
  /** Absolute root of the vault the engine hosts, so Drey can match its own registration. */
  readonly vaultPath: string;
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

export interface DreyPortOptions {
  /** Settings → Tickets → Remote access: bypass runs from a device (default off); asked per run. */
  readonly allowBypass: () => boolean;
}

/** The run states that still hold the ticket (the hand-off waits them out). */
const LIVE_RUN_STATES: readonly string[] = ['starting', 'running', 'stopping', 'detached'];
const HANDOFF_WAIT_MS = 30_000;
const HANDOFF_POLL_MS = 500;

export const BYPASS_REFUSAL = 'bypass runs are not allowed from a remote device';

export class DreyTicketsPort implements TicketsRemotePort {
  constructor(
    private readonly boardService: RemoteBoard,
    private readonly fleetClient: RemoteFleet,
    private readonly changes: ChangeHub,
    private readonly options: DreyPortOptions,
    private readonly chatService: ChatServicePort | null = null,
  ) {}

  /** The chat delegations throw a clear line when the engine did not wire the service. */
  private chat(): ChatServicePort {
    if (this.chatService === null) {
      throw new Error('the chat service is not wired on this port');
    }
    return this.chatService;
  }

  board(): Promise<BoardSnapshot> {
    return this.boardService.refresh();
  }

  async fleet(): Promise<FleetSnapshot> {
    const [runs, chain] = await Promise.all([this.fleetClient.runs(), this.fleetClient.chainStatus()]);
    return { runs, chain };
  }

  async needs(): Promise<readonly NeedItem[]> {
    const [board, runs] = await Promise.all([this.boardService.refresh(), this.fleetClient.runs()]);
    const items = [...needsOf(board, runs)];
    // E6: a persona whose open proposals reached the threshold waits for
    // the owner's 1:1 — after the ticket-scoped needs, one line per persona.
    const personas = await this.boardService.listPersonas();
    for (const persona of personas) {
      const improvements = await this.boardService.personaImprovements(persona.id);
      if (improvements.ok && improvements.openCount >= IMPROVEMENTS_THRESHOLD) {
        items.push({
          kind: 'improvements',
          ticketId: '',
          title: persona.title,
          phase: '',
          runId: null,
          text: `${improvements.openCount} improvement proposals wait for the 1:1`,
          since: null,
        });
      }
    }
    // E7: the tickets' status logs — every open decision or blocker is a
    // needs-you line (capped; a broken read appends nothing).
    items.push(...(await this.statusNeeds(board)));
    // E8: the scout tickets' report cards — a `form: scout` ticket whose
    // file carries a `## Report` waits for the owner's promotion decision.
    items.push(...(await this.reportNeeds(board)));
    // E9: the Bescheid cards — a chain gate with a notify rule whose
    // completion is still fresh. Pure over the snapshot (chain + entered
    // stamps); no file reads, so no sweep of its own.
    items.push(...notifyNeedsOf(board, Date.now()));
    return items;
  }

  /**
   * The E7 status needs (concept §3.3): one board sweep, every ticket's
   * open-decisions fold, oldest open item first per ticket. The cap keeps
   * a neglected board from flooding the phone; a ticket whose log cannot
   * be read contributes nothing — never a failed needs() for one file.
   */
  private async statusNeeds(board: BoardSnapshot): Promise<readonly NeedItem[]> {
    const items: NeedItem[] = [];
    for (const column of board.columns) {
      for (const card of column.tickets) {
        if (items.length >= STATUS_NEEDS_CAP) {
          return items;
        }
        const lines = await this.boardService.statusOf(card.id).catch(() => [] as readonly StatusLine[]);
        for (const item of openStatusItems(lines)) {
          if (items.length >= STATUS_NEEDS_CAP) {
            return items;
          }
          items.push({
            kind: item.verb,
            ticketId: card.id,
            title: card.meta.title ?? card.id,
            phase: column.phase.id,
            runId: null,
            text: item.key !== null ? `[${item.key}] ${item.text}`.trim() : item.text,
            since: item.since,
          });
        }
      }
    }
    return items;
  }

  /**
   * The E8 report needs (concept §5.6): one board sweep, every
   * `form: scout` ticket's `## Report` section read from its own file and
   * parsed tolerant. A scout ticket without a section contributes
   * nothing — its run has not written one yet; a broken read neither —
   * never a failed needs() for one file. The form filter keeps promoted
   * tickets (form: ship, the chapter kept as history) off the list.
   */
  private async reportNeeds(board: BoardSnapshot): Promise<readonly NeedItem[]> {
    const items: NeedItem[] = [];
    for (const column of board.columns) {
      for (const card of column.tickets) {
        if ((card.meta.form ?? 'ship') !== 'scout') {
          continue;
        }
        const reply = await this.boardService.readTicket(card.id).catch(() => null);
        if (reply === null || !reply.ok) {
          continue;
        }
        const report = parseScoutReportSection(reply.text);
        if (report === null) {
          continue;
        }
        items.push(reportNeedOf(card, column.phase.id, report));
      }
    }
    return items;
  }

  ticket(id: string): Promise<TicketReply> {
    return this.boardService.readTicket(id);
  }

  create(cmd: CreateCommand, actor: string): Promise<CreateResult> {
    return this.boardService.createTicket({ ...cmd, actor });
  }

  move(cmd: TransitionCommand, actor: string): Promise<MutationResult> {
    return this.boardService.transition({ ...cmd, actor });
  }

  claim(cmd: ClaimCommand, actor: string): Promise<MutationResult> {
    return this.boardService.setClaim({ ...cmd, actor });
  }

  archive(cmd: TicketIdCommand, actor: string): Promise<MutationResult> {
    return this.boardService.archive({ ...cmd, actor });
  }

  refine(cmd: RefineCommand, actor: string): Promise<RefineReply> {
    return this.boardService.refineTicket({ ...cmd, actor });
  }

  saveAttachment(cmd: AttachmentCommand, actor: string): Promise<AttachmentReply> {
    return this.boardService.saveAttachment({ ...cmd, actor });
  }

  async startRun(cmd: StartRunCommand): Promise<RunReply> {
    if (cmd.permissionMode === 'bypass' && !this.options.allowBypass()) {
      return { ok: false, error: BYPASS_REFUSAL };
    }
    return this.boardService.startRun(cmd);
  }

  stopRun(cmd: StopRunCommand): Promise<RunReply> {
    return this.fleetClient.stop(cmd.runId, cmd.reason);
  }

  /**
   * Hands a run to Claude Code (E12-4): stop it, wait for the runner to
   * let go of the ticket, start the ticket again with the worker pinned
   * to `claude-code` and a fresh brief (the provider session of the old
   * run cannot be resumed by another provider).
   */
  async handoffRun(cmd: { readonly runId: string }): Promise<RunReply> {
    const run = (await this.fleetClient.runs()).find((candidate) => candidate.id === cmd.runId);
    if (run === undefined) {
      return { ok: false, error: 'no such run' };
    }
    if (run.provider === 'claude-code') {
      return { ok: false, error: 'this run is already on Claude Code' };
    }
    const stopped = await this.fleetClient.stop(cmd.runId, 'handed to Claude Code');
    if (!stopped.ok) {
      return stopped;
    }
    const deadline = Date.now() + HANDOFF_WAIT_MS;
    for (;;) {
      const current = (await this.fleetClient.runs()).find((candidate) => candidate.id === cmd.runId);
      if (current === undefined || !LIVE_RUN_STATES.includes(current.state)) {
        break;
      }
      if (Date.now() > deadline) {
        return { ok: false, error: 'the run did not stop in time — try again in a moment' };
      }
      await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
    }
    return this.boardService.startRun({
      ticketId: run.ticketId,
      workerChoice: 'claude-code',
      permissionMode: 'accept-edits',
      handover: 'fresh',
      interactive: null,
    });
  }

  send(cmd: SendCommand): Promise<RunReply> {
    return this.fleetClient.send(cmd.runId, cmd.text);
  }

  answer(cmd: AnswerCommand): Promise<RunReply> {
    return this.fleetClient.answerQuestion(cmd.runId, cmd.answers);
  }

  permission(cmd: PermissionCommand): Promise<RunReply> {
    return this.fleetClient.answerPermission(cmd.runId, cmd.decision);
  }

  async stream(runId: string): Promise<string> {
    return (await this.fleetClient.stream(runId)) ?? '';
  }

  async chainMaster(mode: ChainMaster): Promise<ChainReply> {
    return chainResult(await this.fleetClient.setMaster(mode));
  }

  async chainColumn(phase: string, mode: ColumnMode): Promise<ChainReply> {
    return chainResult(await this.fleetClient.setColumn(phase, mode));
  }

  async chainColumnStop(phase: string): Promise<ChainReply> {
    return chainResult(await this.fleetClient.stopColumn(phase));
  }

  async chainAbort(): Promise<ChainReply> {
    return chainResult(await this.fleetClient.abortAll());
  }

  async personas(): Promise<readonly PersonaView[]> {
    await this.boardService.ensureHumanPersona?.();
    const [personas, ledgerText, snapshot, chain] = await Promise.all([
      this.boardService.listPersonas(),
      this.boardService.ledgerText(),
      this.boardService.snapshot(),
      this.fleetClient.chainStatus().catch(() => null),
    ]);
    // The Team view's "Tageskosten gegen Budget" (concept §4.3): today's
    // settled costs, persona-keyed from the fleet ledger; UTC day — the
    // same convention the chain's token budgets use.
    const daily = personaDailyCosts(parseLedger(ledgerText ?? ''), new Date().toISOString().slice(0, 10));
    // U4: the phases each persona owns (`persona:` in pipeline.md), from
    // the same snapshot; and the chain's persona pause — absent while the
    // chain state is unknown (the runner is down), never a guessed false.
    const phases: Record<string, string[]> = {};
    for (const phase of snapshot.pipeline) {
      if (phase.persona !== null && phase.persona !== '') {
        (phases[phase.persona] ??= []).push(phase.id);
      }
    }
    const paused = chain?.pausedPersonas;
    return personas.map((p) => ({
      id: p.id,
      ...(p.kind === 'human' ? { kind: 'human' as const } : {}),
      title: p.title,
      role: p.kind === 'human' ? 'owner' : p.role,
      worker: p.kind === 'human' ? '' : p.worker,
      model: p.kind === 'human' ? '' : p.models.default,
      pool: p.kind === 'human' ? [] : p.models.pool,
      color: p.color,
      budget: p.budget,
      ...(daily[p.id] !== undefined ? { dailyCost: daily[p.id] } : {}),
      ...(phases[p.id] !== undefined ? { phases: phases[p.id] } : {}),
      ...(paused !== undefined ? { paused: paused.includes(p.id) } : {}),
    }));
  }

  personaImprovements(personaId: string): Promise<PersonaImprovementsReply> {
    return this.boardService.personaImprovements(personaId);
  }

  personaImprovementDecide(cmd: { readonly persona: string; readonly proposal: string; readonly decision: ImprovementDecision }): Promise<MutationResult> {
    return this.boardService.decideImprovement({ id: cmd.persona, proposalId: cmd.proposal, decision: cmd.decision });
  }

  personaThread(personaId: string): Promise<PersonaThreadReply> {
    return this.boardService.personaThread(personaId);
  }

  personaThreadAppend(cmd: { readonly persona: string; readonly text: string }): Promise<PersonaThreadReply> {
    return this.boardService.personaThreadAppend({ id: cmd.persona, text: cmd.text });
  }

  personaMemory(personaId: string): Promise<PersonaMemoryReply> {
    return this.boardService.personaMemory(personaId);
  }

  personaMemoryAppend(cmd: { readonly persona: string; readonly text: string }): Promise<PersonaMemoryReply> {
    return this.boardService.personaMemoryAppend({ id: cmd.persona, text: cmd.text });
  }

  personaMemoryPin(cmd: { readonly persona: string; readonly index: number; readonly pinned: boolean }): Promise<PersonaMemoryReply> {
    return this.boardService.personaMemoryPin({ id: cmd.persona, index: cmd.index, pinned: cmd.pinned });
  }

  personaPatch(cmd: Parameters<TicketsRemotePort['personaPatch']>[0]): Promise<MutationResult> {
    const { persona, ...patch } = cmd;
    return this.boardService.personaPatch({ id: persona, ...patch });
  }

  async chainPersonaPause(cmd: { readonly persona: string; readonly paused: boolean }): Promise<ChainPersonaPauseReply> {
    const status = await this.fleetClient.setPersonaPaused(cmd.persona, cmd.paused);
    if (status === null) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return { ok: true, persona: cmd.persona.trim(), paused: cmd.paused };
  }

  ticketSave(cmd: { id: string; text: string; baseRevision?: string }, actor: string): Promise<RefineReply> {
    return this.boardService.saveTicket({ ...cmd, actor });
  }

  ticketAccept(cmd: TicketIdCommand, actor: string): Promise<MutationResult> {
    return this.boardService.acceptTicket({ ...cmd, actor });
  }

  ticketSendBack(cmd: { id: string; note: string; comments?: readonly ReviewComment[] }, actor: string): Promise<MutationResult> {
    return this.boardService.sendBack({ ...cmd, actor });
  }

  ticketAnswerNeed(cmd: { id: string; key?: string; text?: string }, actor: string): Promise<MutationResult> {
    return this.boardService.answerNeed({ ...cmd, actor });
  }

  ticketWorktreeChanges(id: string): Promise<readonly WorktreeFile[]> {
    return this.boardService.worktreeChangesOf(id);
  }

  ticketDiff(id: string): Promise<TicketDiff> {
    return this.boardService.ticketDiff(id);
  }

  ticketFile(id: string, path: string): Promise<TicketFileReply> {
    return this.boardService.ticketFile(id, path);
  }

  estimate(key: EstimateKey): Promise<RunEstimate | null> {
    return this.boardService.estimateOf(key);
  }

  planParts(id: string): Promise<PlanPartsReply> {
    return this.boardService.planParts(id);
  }

  planPartsEdit(cmd: { id: string; edit: PlanPartsEdit }, actor: string): Promise<MutationResult> {
    return this.boardService.editPlanParts({ ...cmd, actor });
  }

  planRelease(cmd: { id: string; scope: PlanReleaseScope }, actor: string): Promise<PlanReleaseReply> {
    return this.boardService.releasePlan({ ...cmd, actor });
  }

  flow(target: FlowTarget): Promise<FlowReply> {
    return this.boardService.flowOf(target);
  }

  flowEdit(cmd: FlowTarget & { chain: readonly string[]; edit: FlowOp }): Promise<FlowReply> {
    return this.boardService.flowEdit(cmd);
  }

  flowSave(cmd: FlowTarget & { chain: readonly string[] }, actor: string): Promise<FlowSaveReply> {
    return this.boardService.saveFlow({ ...cmd, actor });
  }

  /** Paul's draft (E10-5): he reads the flow, proposes a delta; the draft is read back through the same guard as any edit. */
  async flowDraft(cmd: FlowTarget & { ask: string | null }): Promise<FlowDraftReply> {
    const target: FlowTarget = { id: cmd.id, part: cmd.part };
    const context = await this.boardService.flowDraftContext(target);
    if (!context.ok) {
      return context;
    }
    const drafted = await this.chat().draftFlow({ ticket: cmd.id, context: context.text, ask: cmd.ask });
    if (!drafted.ok) {
      return drafted;
    }
    const view = await this.boardService.flowEdit({ ...target, chain: drafted.chain, edit: { op: 'view' } });
    return view.ok ? { ...view, reason: drafted.reason } : { ok: false, error: `Paul's draft does not hold: ${view.error}` };
  }

  chatSessions(): Promise<readonly ChatSessionMeta[]> {
    return this.chat().sessions();
  }

  chatOpen(file: string): Promise<ChatSession | null> {
    return this.chat().open(file);
  }

  chatSend(input: { readonly file: string; readonly text: string; readonly planEdits?: boolean }): Promise<ChatTurnResult> {
    return this.chat().send(input);
  }

  chatStart(input: { readonly title?: string; readonly text: string; readonly ticket?: string }): Promise<ChatTurnResult> {
    return this.chat().start(input);
  }

  planStatus(ticket: string): Promise<PlanStatus> {
    return this.chat().planStatus(ticket);
  }

  chatConfirm(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult> {
    return this.chat().confirm(input);
  }

  chatShapeDecide(input: { readonly file: string; readonly choice: ChatSplitChoice }): Promise<ChatShapeResult> {
    return this.chat().shapeDecide(input);
  }

  chatDismiss(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult> {
    return this.chat().dismiss(input);
  }

  onChanged(listener: (what: RemoteChange, payload?: ChatChangePayload) => void): () => void {
    return this.changes.subscribe(listener);
  }
}
