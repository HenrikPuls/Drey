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
import type { ChatDecisionResult, ChatSession, ChatSessionMeta, ChatStreamEvent, ChatTurnResult } from './chat';
import type { FleetSnapshot } from '../services/fleet-client';
import type { ChainMaster, ChainStatus, ColumnMode, WaitQuestion } from '../fleet/protocol';
import type { ShapedQuestion } from './question-shape';
import type { BoardSnapshot, CreateResult, MutationResult, TicketCard } from './tickets';

/** What the "Needs you" list holds, in the order it shows them. */
export type NeedKind = 'question' | 'permission' | 'red-gate' | 'failed' | 'checkpoint';

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
}

export type RunReply = { readonly ok: boolean; readonly error?: string; readonly runId?: string };
export type ChainReply = { readonly ok: true; readonly status: ChainStatus } | { readonly ok: false; readonly error: string };
export type RemoteChange = 'board' | 'fleet' | 'remote' | 'chat';

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
  send(cmd: SendCommand): Promise<RunReply>;
  answer(cmd: AnswerCommand): Promise<RunReply>;
  permission(cmd: PermissionCommand): Promise<RunReply>;
  /** The run's stream tail (ndjson); '' when the runner has none. */
  stream(runId: string): Promise<string>;

  chainMaster(mode: ChainMaster): Promise<ChainReply>;
  chainColumn(phase: string, mode: ColumnMode): Promise<ChainReply>;
  chainColumnStop(phase: string): Promise<ChainReply>;
  chainAbort(): Promise<ChainReply>;

  /** The Mission Control chat surface (E5a) — the service's port verbatim. */
  chatSessions(): Promise<readonly ChatSessionMeta[]>;
  chatOpen(file: string): Promise<ChatSession | null>;
  chatSend(input: { readonly file: string; readonly text: string }): Promise<ChatTurnResult>;
  chatStart(input: { readonly title?: string; readonly text: string }): Promise<ChatTurnResult>;
  chatConfirm(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;
  chatDismiss(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;

  /** Board, fleet, remote or chat changed; returns the unsubscribe. Chat changes carry their stream payload. */
  onChanged(listener: (what: RemoteChange, payload?: ChatChangePayload) => void): () => void;
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
