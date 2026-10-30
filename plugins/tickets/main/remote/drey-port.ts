/**
 * Drey's implementation of the tickets remote port (req-66, ADR-0084):
 * the board service and the fleet client behind the host-neutral
 * `TicketsRemotePort`. It adds only the remote's own policy — the actor
 * on every write and the refusal of bypass runs — and leaves every
 * board rule where it already lives.
 */
import type {
  AnswerCommand,
  ClaimCommand,
  CreateCommand,
  PermissionCommand,
  ReorderCommand,
  SendCommand,
  StartRunCommand,
  StopRunCommand,
  TicketIdCommand,
  TransitionCommand,
} from '../commands';
import { chainResult } from '../commands';
import type { FleetSnapshot } from '../fleet-client';
import type { ChainMaster, ChainStatus, ColumnMode, PermissionDecision, QuestionAnswers, RunInfo } from '../fleet/protocol';
import type {
  ChainReply,
  NeedItem,
  RemoteChange,
  RunReply,
  TicketsRemotePort,
} from '../../shared/remote-protocol';
import type { BoardSnapshot, CreateResult, MutationResult } from '../../shared/tickets';
import { needsOf } from './needs';

/** The board service's part the remote uses (`BoardService` fits it). */
export interface RemoteBoard {
  refresh(): Promise<BoardSnapshot>;
  createTicket(input: CreateCommand & { actor?: string }): Promise<CreateResult>;
  transition(input: TransitionCommand & { actor?: string }): Promise<MutationResult>;
  reorder(input: ReorderCommand): Promise<MutationResult>;
  unpin(input: TicketIdCommand): Promise<MutationResult>;
  setClaim(input: ClaimCommand & { actor?: string }): Promise<MutationResult>;
  archive(input: TicketIdCommand & { actor?: string }): Promise<MutationResult>;
  startRun(input: StartRunCommand): Promise<RunReply>;
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

/** Fan-out of board/fleet changes to the remote's listeners. */
export class ChangeHub {
  private readonly listeners = new Set<(what: RemoteChange) => void>();

  emit(what: RemoteChange): void {
    for (const listener of [...this.listeners]) {
      listener(what);
    }
  }

  subscribe(listener: (what: RemoteChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface DreyPortOptions {
  /** Settings → Tickets → Remote access: bypass runs from a device (default off). */
  readonly allowBypass: boolean;
}

export const BYPASS_REFUSAL = 'bypass runs are not allowed from a remote device';

export class DreyTicketsPort implements TicketsRemotePort {
  constructor(
    private readonly boardService: RemoteBoard,
    private readonly fleetClient: RemoteFleet,
    private readonly changes: ChangeHub,
    private readonly options: DreyPortOptions,
  ) {}

  board(): Promise<BoardSnapshot> {
    return this.boardService.refresh();
  }

  async fleet(): Promise<FleetSnapshot> {
    const [runs, chain] = await Promise.all([this.fleetClient.runs(), this.fleetClient.chainStatus()]);
    return { runs, chain };
  }

  async needs(): Promise<readonly NeedItem[]> {
    const [board, runs] = await Promise.all([this.boardService.refresh(), this.fleetClient.runs()]);
    return needsOf(board, runs);
  }

  create(cmd: CreateCommand, actor: string): Promise<CreateResult> {
    return this.boardService.createTicket({ ...cmd, actor });
  }

  move(cmd: TransitionCommand, actor: string): Promise<MutationResult> {
    return this.boardService.transition({ ...cmd, actor });
  }

  reorder(cmd: ReorderCommand): Promise<MutationResult> {
    return this.boardService.reorder(cmd);
  }

  unpin(cmd: TicketIdCommand): Promise<MutationResult> {
    return this.boardService.unpin(cmd);
  }

  claim(cmd: ClaimCommand, actor: string): Promise<MutationResult> {
    return this.boardService.setClaim({ ...cmd, actor });
  }

  archive(cmd: TicketIdCommand, actor: string): Promise<MutationResult> {
    return this.boardService.archive({ ...cmd, actor });
  }

  async startRun(cmd: StartRunCommand): Promise<RunReply> {
    if (cmd.permissionMode === 'bypass' && !this.options.allowBypass) {
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

  onChanged(listener: (what: RemoteChange) => void): () => void {
    return this.changes.subscribe(listener);
  }
}
