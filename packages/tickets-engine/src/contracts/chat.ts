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
import type { TicketPriority } from './tickets';

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
}

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
  | { readonly kind: 'promote'; readonly id: string };

/** One chat session = one file under `tickets/_meta/chat/`. */
export interface ChatSession {
  /** Vault-relative path (`tickets/_meta/chat/<stamp>-<slug>.md`). */
  readonly file: string;
  readonly title: string;
  /** ISO stamp of the session's creation. */
  readonly createdAt: string;
  readonly messages: readonly ChatMessage[];
  readonly proposals: readonly ChatProposal[];
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
  send(input: { readonly file: string; readonly text: string }): Promise<ChatTurnResult>;
  /** Starts a fresh session and sends the first message. */
  start(input: { readonly title?: string; readonly text: string }): Promise<ChatTurnResult>;
  confirm(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;
  dismiss(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult>;
}

/** The listing entry — the UI shows title, age and pending cards. */
export interface ChatSessionMeta {
  readonly file: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pending: number;
}

/** What send/start return: the appended mission text and its proposals. */
export interface ChatTurnResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly file?: string;
  readonly say?: string;
  readonly thought?: string;
  readonly proposals?: readonly ChatProposal[];
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
    /** Receives the live stream: thought and text deltas. */
    emit(event: ChatStreamEvent): void;
  }): Promise<{
    readonly say: string;
    readonly thought: string | null;
    readonly commands: readonly ChatCommand[];
  }>;
}
