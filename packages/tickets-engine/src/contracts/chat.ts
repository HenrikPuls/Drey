/**
 * The Mission Control chat contract (E5a, ADR-0088 later change): the
 * shapes the chat service, the LLM bridge and the UI exchange. The
 * persistence format (one session = one file under `tickets/_meta/chat/`)
 * is core/chat-session.ts; the intent envelope's pure helpers are
 * core/chat-intents.ts.
 *
 * The one iron rule (concept §6): the chat never writes on its own.
 * Every mutation is a typed command wrapped in a proposal card; only
 * the owner's explicit confirm executes it — through the same board
 * methods the invoke channel exposes, never a second write path.
 */
import type { PriorityConfig, TicketPriority } from './tickets';

export type ChatRole = 'owner' | 'mission';
export type ChatProposalState = 'pending' | 'confirmed' | 'dismissed';

/** One message of a session, in file order. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly text: string;
  /** ISO stamp. */
  readonly at: string;
  /** The mission's thinking trace, folded away after completion. */
  readonly thought: string | null;
  /**
   * `plan-edit` marks the "You edited the plan" card (E10-2): the owner's
   * plan changes that went along with the next message, `text` the
   * summary and `diff` the diff the model read. Absent = a plain message.
   */
  readonly kind?: 'plan-edit' | 'question' | 'split';
  readonly diff?: string | null;
  /** The answer card's choices (kind `question`, E10-3); answered by the owner's next message. */
  readonly options?: readonly ChatQuestionOption[];
  /** The split card (kind `split`, E10-3): how many tickets the plan's parts would make. */
  readonly parts?: number;
  /** The owner's choice on a split card; null/absent while open. */
  readonly decision?: ChatSplitChoice | null;
}

/** One choice of an answer card (E10-3). */
export interface ChatQuestionOption {
  readonly label: string;
  readonly recommended: boolean;
}

/** The owner's choice on Paul's split proposal. */
export type ChatSplitChoice = 'keep' | 'split';

/**
 * A proposed mutation awaiting the owner's tap. `command` is the typed
 * payload the confirm executes; `summary` is the human sentence the
 * card shows. Proposals are append-only history — a decision adds a
 * line, never rewrites one.
 */
export interface ChatProposal {
  /** `p-<n>`, minted per session. */
  readonly id: string;
  readonly state: ChatProposalState;
  readonly summary: string;
  readonly command: ChatCommand;
  /** ISO stamp of the proposal. */
  readonly at: string;
  /** ISO stamp of the decision; null while pending. */
  readonly decidedAt: string | null;
  /** The outcome line the execution reported (e.g. the moved path). */
  readonly outcome: string | null;
}

/**
 * The mutation commands the chat may propose (E5a scope). The union
 * grows with the intents (configure in E5c/E6) — the confirm path
 * validates against exactly this union, nothing else reaches the board.
 */
export type ChatCommand =
  | {
      readonly kind: 'createTicket';
      readonly title: string;
      readonly description: string;
      readonly priority: TicketPriority;
      /** The phase the ticket is created in (e.g. `inbox` / `ideas`). */
      readonly phase: string;
    }
  | { readonly kind: 'transition'; readonly id: string; readonly from: string; readonly to: string }
  | { readonly kind: 'setPriority'; readonly id: string; readonly priority: TicketPriority }
  /**
   * E8 (concept §5.6): promote a scout ticket to ship — `form: scout`
   * flips to `form: ship`, the ticket enters the normal pipeline (plan,
   * worktree, gate) on its next run. The report chapter stays in the
   * file as history.
   */
  | { readonly kind: 'promote'; readonly id: string }
  /**
   * E9 (concept §5.7): replace the ticket's chain delta with the given
   * canonical entries (`insert security(ralf, notify) after review`,
   * `skip verify`, `notify build`); an empty list returns the ticket
   * to the pipeline's standard flow. The grammar and the semantic
   * validation run at execution — the proposal card shows the chain
   * before/after before the owner confirms.
   */
  | { readonly kind: 'setChain'; readonly id: string; readonly chain: readonly string[] }
  /**
   * T-0050 (T0): replace the ticket's whole `blocked-by:` list with the
   * given ticket ids — the ticket waits until every one of them reaches
   * the pipeline's terminal phase. An empty list clears the blockers (the
   * key leaves the file). Full replacement like setChain: the card shows
   * the whole new list before the owner confirms; the ids are checked
   * against the ticket-id grammar at parse time and their existence on
   * the board at execution (an unknown id stays written — it simply never
   * resolves, per the dependency pass's tolerance).
   */
  | { readonly kind: 'setBlockedBy'; readonly id: string; readonly blockedBy: readonly string[] };

/** One chat session = one file under `tickets/_meta/chat/`. */
export interface ChatSession {
  /** Vault-relative path (`tickets/_meta/chat/<stamp>-<slug>.md`). */
  readonly file: string;
  readonly title: string;
  /** ISO stamp of the session's creation. */
  readonly createdAt: string;
  readonly messages: readonly ChatMessage[];
  readonly proposals: readonly ChatProposal[];
  /** The ticket whose plan is shaped in this session (E10); null = a plain chat. */
  readonly ticket?: string | null;
  /** The repository files Paul has read in this shape session (E10-3), in reading order, distinct. */
  readonly sources?: readonly string[];
  /** The model that answers in a shape session (the chat model), for the context line. */
  readonly model?: string;
}

/** The streaming unit the UI renders (thought dim, then text, cards). */
export type ChatStreamEvent =
  | { readonly kind: 'thought'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'proposal'; readonly proposal: ChatProposal }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string };

/** The chat service's public surface (invoke + gateway share it). */
export interface ChatServicePort {
  /** Sessions, newest first. */
  sessions(): Promise<readonly ChatSessionMeta[]>;
  /** One session parsed from disk; null when the file is gone. */
  open(file: string): Promise<ChatSession | null>;
  /**
   * Sends one owner message: appends it, runs the mission turn (LLM
   * stream → events), appends the reply, and returns the finished
   * session slice. The stream arrives through `onEvent`.
   */
  send(input: { readonly file: string; readonly text: string; readonly planEdits?: boolean }): Promise<ChatTurnResult>;
  /** Starts a fresh session and sends the first message; `ticket` makes it a shape session for that ticket's plan. */
  start(input: { readonly title?: string; readonly text: string; readonly ticket?: string }): Promise<ChatTurnResult>;
  /** Where the shared plan of a ticket stands: version, the owner's edits since the model's last turn, the line marks (E10-2). */
  planStatus(ticket: string): Promise<PlanStatus>;
  /**
   * The owner's tap on Paul's split proposal (E10-3): `keep` moves the
   * ticket into the build queue, `split` records the choice for the plan
   * to approve (E10-4). Either way the decision line lands in the file.
   */
  shapeDecide(input: { readonly file: string; readonly choice: ChatSplitChoice }): Promise<ChatShapeResult>;
  /**
   * Paul drafts a flow (E10-5): the model reads the ticket's flow and
   * proposes the whole chain delta with a reason. Nothing is written; the
   * caller checks the draft against the pipeline before showing it.
   */
  draftFlow(input: { readonly ticket: string; readonly context: string; readonly ask: string | null }): Promise<ChatFlowDraft>;
  confirm(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;
  dismiss(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;
}

/** Paul's flow draft: the proposed delta and his reason, or why there is none. */
export type ChatFlowDraft =
  | { readonly ok: true; readonly chain: readonly string[]; readonly reason: string }
  | { readonly ok: false; readonly error: string };

/** One marked line of the shared plan. */
export interface PlanMark {
  /** 1-based line of the current Plan section. */
  readonly no: number;
  readonly text: string;
  /** Who changed it last: the owner since the model's last turn, or the model in its last turn. */
  readonly by: 'you' | 'model';
}

/** The shared plan's state for the composer chip, the status line and the line marks. */
export type PlanStatus =
  | {
      readonly ok: true;
      /** The model's turns that ended on this plan; null = it has not worked on the plan yet. */
      readonly version: number | null;
      /** When the model's last turn on this plan ended (ISO); null before its first or for a shadow without a stamp (E13-9). */
      readonly modelAt: string | null;
      /** The owner's edit groups since the model's last turn (what the chip counts). */
      readonly edits: number;
      /** `2 edits · +3 −1`; null when nothing changed. */
      readonly summary: string | null;
      readonly marks: readonly PlanMark[];
    }
  | { readonly ok: false; readonly error: string };

/** The listing entry — the UI shows title, age and pending cards. */
export interface ChatSessionMeta {
  readonly file: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pending: number;
  /** The ticket a shape session shapes (E10-3); absent on a plain chat. */
  readonly ticket?: string;
}

export type ChatFailureCode = 'not-configured' | 'unsupported' | 'unreachable' | 'refused' | 'timeout';

/**
 * Why a turn had no model (D-1) — the error card's content: provider,
 * endpoint and reason. `message` is the same in one sentence (the stream's
 * error event, the flow draft's error text).
 */
export interface ChatModelFailure {
  readonly code: ChatFailureCode;
  readonly provider: string;
  readonly providerLabel: string;
  readonly baseUrl: string | null;
  readonly model: string | null;
  /** The reason alone, without the provider and URL (the card shows those on their own lines). */
  readonly reason: string;
  readonly message: string;
}

/**
 * What send/start return: the appended mission text and its proposals.
 * When the model could not answer, `ok` is false, nothing is appended as
 * the mission's reply (the owner's line stays), and `failure` names why.
 */
export interface ChatTurnResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly failure?: ChatModelFailure;
  readonly file?: string;
  readonly say?: string;
  readonly thought?: string;
  readonly proposals?: readonly ChatProposal[];
}

export interface ChatShapeResult {
  readonly ok: boolean;
  readonly error?: string;
  /** What the choice did: the ticket's new path for `keep`, `split` otherwise. */
  readonly outcome?: string;
}

export interface ChatDecisionResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly proposal?: ChatProposal;
}

/**
 * The LLM seam the service composes (E5a): one mission turn. The bridge
 * owns provider speak (streaming, envelope prompting); the service owns
 * persistence and execution — the bridge never touches the vault.
 */
export interface ChatBridge {
  runTurn(input: {
    /** The owner's just-sent message. */
    readonly text: string;
    /** Recent session messages (oldest first) for continuity. */
    readonly history: readonly { readonly role: 'owner' | 'mission'; readonly text: string }[];
    /** The board digest the prompt embeds (columns, open tickets). */
    readonly board: string;
    /**
     * The board's priority vocabulary — what the reply's priority fields
     * are validated against (the chat service passes the snapshot's
     * config). Absent = the shipped default vocabulary.
     */
    readonly priorities?: PriorityConfig;
    /**
     * What the owner changed in the shared plan since the model's last
     * turn (E10-2), ready to read; absent = nothing went along.
     */
    readonly planDelta?: string;
    /**
     * Present on a shape turn (E10-3): the ticket Paul shapes, its file
     * text (description and the current plan, the owner's edits in) and
     * the read-only access to the ticket's repository.
     */
    readonly shape?: ChatShapeContext;
    /** Present on a flow draft (E10-5): the flow Paul reads, replacing the board digest. */
    readonly flow?: { readonly context: string };
    /** Receives the live stream: thought and text deltas. */
    emit(event: ChatStreamEvent): void;
  }): Promise<{
    readonly say: string;
    readonly thought: string | null;
    readonly commands: readonly ChatCommand[];
    /** Shape turns only: Paul's new Plan chapter (the whole body), the open question, the split reason, the files read. */
    readonly shape?: ChatShapeReply;
    /** Set when no model answered (not set up, unsupported provider, unreachable, refused): `say` then holds the failure's message. */
    readonly failure?: ChatModelFailure;
  }>;
}

/** What a shape turn hands the bridge. */
export interface ChatShapeContext {
  readonly ticket: string;
  readonly ticketText: string;
  /** Reads one repository file (or lists a directory when `path` ends in `/`); read-only, bounded. */
  readFile(path: string): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }>;
}

/** What Paul answered beyond the spoken reply. */
export interface ChatShapeReply {
  /** The whole new Plan chapter body; null = the plan stays as it is. */
  readonly plan: string | null;
  /** One question with choices, shown as an answer card above the composer. */
  readonly question: { readonly text: string; readonly options: readonly ChatQuestionOption[] } | null;
  /** Paul's reason for the split (or keep) proposal; null = no proposal this turn. */
  readonly splitReason: string | null;
  /** Repository paths read during the turn. */
  readonly sources: readonly string[];
}
