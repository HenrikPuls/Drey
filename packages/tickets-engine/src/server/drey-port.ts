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
  ChainReply,
  ChatChangePayload,
  ImprovementDecision,
  NeedItem,
  PersonaImprovementsReply,
  PersonaView,
  RemoteChange,
  RefineReply,
  RunReply,
  TicketReply,
  TicketsRemotePort,
} from '../contracts/remote-protocol';
import type { BoardSnapshot, CreateResult, MutationResult } from '../contracts/tickets';
import type { TicketDiff, WorktreeFile } from '../core/worktree-changes';
import type { ChatDecisionResult, ChatServicePort, ChatSession, ChatSessionMeta, ChatTurnResult } from '../contracts/chat';
import { IMPROVEMENTS_THRESHOLD } from '../core/improvements';
import { openStatusItems } from '../core/status-log';
import type { StatusLine } from '../core/status-log';
import { parseScoutReportSection } from '../core/scout';
import { needsOf, reportNeedOf } from './needs';

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
  /** The raw-text save behind the phone edit mode (E5c). */
  saveTicket(input: { id: string; text: string; baseRevision?: string; actor?: string }): Promise<RefineReply>;
  /** The proof card's unified diff (E5c). */
  ticketDiff(id: string): Promise<TicketDiff>;
  /** The proof card's file stat list (E5c). */
  worktreeChangesOf(id: string): Promise<readonly WorktreeFile[]>;
  /** The Ready card's accept (E5c). */
  acceptTicket(input: { id: string; actor?: string }): Promise<MutationResult>;
  /** The proof card's send-back with a mandatory note (E5c). */
  sendBack(input: { id: string; note: string; actor?: string }): Promise<MutationResult>;
  /** The E6 improvements card: one persona's proposals and counts. */
  personaImprovements(personaId: string): Promise<PersonaImprovementsReply>;
  /** The E6 1:1 decision; the apply lands in exactly one commit on the desk. */
  decideImprovement(input: { id: string; proposalId: string; decision: ImprovementDecision; now?: string }): Promise<MutationResult>;
  /** E7: the ticket's status-log lines (`<card>.status.log`); [] when absent or broken. */
  statusOf(ticketId: string): Promise<readonly StatusLine[]>;
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
}

export interface DreyPortOptions {
  /** Settings → Tickets → Remote access: bypass runs from a device (default off); asked per run. */
  readonly allowBypass: () => boolean;
}

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
    const personas = await this.boardService.listPersonas();
    return personas.map((p) => ({
      id: p.id,
      title: p.title,
      role: p.role,
      worker: p.worker,
      model: p.models.default,
      pool: p.models.pool,
      color: p.color,
    }));
  }

  personaImprovements(personaId: string): Promise<PersonaImprovementsReply> {
    return this.boardService.personaImprovements(personaId);
  }

  personaImprovementDecide(cmd: { readonly persona: string; readonly proposal: string; readonly decision: ImprovementDecision }): Promise<MutationResult> {
    return this.boardService.decideImprovement({ id: cmd.persona, proposalId: cmd.proposal, decision: cmd.decision });
  }

  ticketSave(cmd: { id: string; text: string; baseRevision?: string }, actor: string): Promise<RefineReply> {
    return this.boardService.saveTicket({ ...cmd, actor });
  }

  ticketAccept(cmd: TicketIdCommand, actor: string): Promise<MutationResult> {
    return this.boardService.acceptTicket({ ...cmd, actor });
  }

  ticketSendBack(cmd: { id: string; note: string }, actor: string): Promise<MutationResult> {
    return this.boardService.sendBack({ ...cmd, actor });
  }

  ticketWorktreeChanges(id: string): Promise<readonly WorktreeFile[]> {
    return this.boardService.worktreeChangesOf(id);
  }

  ticketDiff(id: string): Promise<TicketDiff> {
    return this.boardService.ticketDiff(id);
  }

  chatSessions(): Promise<readonly ChatSessionMeta[]> {
    return this.chat().sessions();
  }

  chatOpen(file: string): Promise<ChatSession | null> {
    return this.chat().open(file);
  }

  chatSend(input: { readonly file: string; readonly text: string }): Promise<ChatTurnResult> {
    return this.chat().send(input);
  }

  chatStart(input: { readonly title?: string; readonly text: string }): Promise<ChatTurnResult> {
    return this.chat().start(input);
  }

  chatConfirm(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult> {
    return this.chat().confirm(input);
  }

  chatDismiss(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult> {
    return this.chat().dismiss(input);
  }

  onChanged(listener: (what: RemoteChange, payload?: ChatChangePayload) => void): () => void {
    return this.changes.subscribe(listener);
  }
}
