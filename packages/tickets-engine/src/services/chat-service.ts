/**
 * The Mission Control chat service (E5a, concept §6): the engine-side
 * owner of the chat session files under `tickets/_meta/chat/`. The iron
 * rule — the chat NEVER writes to the board on its own. Every mutation
 * the mission proposes lands in the session file as a pending proposal
 * card; only the owner's explicit confirm executes the card's typed
 * command, through exactly the board methods the invoke channel exposes
 * (the same single-writer queue, the same commits), and then appends the
 * decision line with the outcome. Dismiss appends the decision without
 * executing. Proposals are append-only history.
 *
 * Persistence mirrors the verify service: one chat-file write per round
 * (the owner line, the turn block, the decision), each its own commit
 * through a locate+commitPaths helper; the board mutations behind a
 * confirm carry their own commits through the board port. All file IO
 * goes through the host; the bridge never touches the vault.
 *
 * A session runs one mission turn at a time: a send while the stream is
 * still running refuses politely instead of interleaving a second owner
 * line the file could not order honestly.
 */
import { promises as fsp } from 'node:fs';
import type {
  ChatBridge,
  ChatCommand,
  ChatDecisionResult,
  ChatMessage,
  ChatProposal,
  ChatServicePort,
  ChatSession,
  ChatSessionMeta,
  ChatStreamEvent,
  ChatTurnResult,
} from '../contracts/chat';
import { titleFromDescription, type BoardSnapshot, type TicketForm, type TicketPriority } from '../contracts/tickets';
import {
  appendMission,
  appendOwner,
  appendProposal,
  CHAT_DIR,
  chatFileName,
  decideProposal,
  newSessionText,
  parseSessionFile,
} from '../core/chat-session';
import { TicketsGit } from '../core/tickets-git';
import type { EngineHost, EngineVault } from './host';

/** The session files this service reads and writes — direct children only. */
const CHAT_FILE_PATTERN = /^tickets\/_meta\/chat\/[^/]+\.md$/;
/** Recent messages handed to the bridge for continuity. */
const HISTORY_LIMIT = 20;
/** The board digest's rough ceiling — the prompt stays small and cheap. */
const DIGEST_CAP = 2_000;

/** The result shape of a board mutation the confirm path executes. */
export type ChatMutationResult =
  | { readonly ok: true; readonly warning?: string; readonly path?: string; readonly id?: string }
  | { readonly ok: false; readonly error: string };

/**
 * The board surface the chat composes (ADR-0088, E5a): the snapshot for
 * the digest and the vault lookup, plus exactly the three mutation
 * methods a proposal card can carry — no second write path. The board
 * service fits this port unchanged.
 */
export interface ChatBoardPort {
  snapshot(): Promise<BoardSnapshot>;
  createTicket(input: {
    readonly title: string;
    readonly actor?: string;
    readonly priority: TicketPriority;
    readonly repo: string | null;
    readonly description: string;
  }): Promise<ChatMutationResult>;
  transition(input: { readonly id: string; readonly actor?: string; readonly from: string; readonly to: string }): Promise<ChatMutationResult>;
  setPriority(input: { readonly id: string; readonly priority: TicketPriority; readonly actor?: string }): Promise<ChatMutationResult>;
  /** E8 (concept §5.6): the scout → ship promotion's form flip. */
  setForm(input: { readonly id: string; readonly form: TicketForm; readonly actor?: string }): Promise<ChatMutationResult>;
  /** E9 (concept §5.7): the chain-delta replacement. */
  setChain(input: { readonly id: string; readonly chain: readonly string[]; readonly actor?: string }): Promise<ChatMutationResult>;
}

export interface ChatServiceDeps {
  readonly host: EngineHost;
  readonly board: ChatBoardPort;
  /** The LLM seam (E5b): one mission turn — streaming, envelope prompting. */
  readonly bridge: ChatBridge;
  /** The acting owner (`owner@<host>`): the board mutations' actor. */
  readonly actor: string;
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** The live stream sink: every bridge event, tagged with its session file. */
  readonly onEvent: (file: string, event: ChatStreamEvent) => void;
  /** The clock; the specs pin it for deterministic stamps and file names. */
  readonly now?: () => Date;
  /** The git seam — the engine passes its shared TicketsGit, the specs a fake. */
  readonly git?: TicketsGit;
}

/** The card's human sentence — what the proposal line and the UI show. */
function summaryOf(command: ChatCommand): string {
  switch (command.kind) {
    case 'transition':
      return `Move ${command.id} from ${command.from} to ${command.to}`;
    case 'createTicket':
      return `Create ticket "${command.title}" in ${command.phase}`;
    case 'setPriority':
      return `Set ${command.id} priority to ${command.priority}`;
    case 'promote':
      return `Promote ${command.id} to a ship ticket`;
    case 'setChain':
      return command.chain.length === 0
        ? `Return ${command.id} to the standard flow`
        : `Set ${command.id} chain to ${command.chain.length} ${command.chain.length === 1 ? 'entry' : 'entries'}`;
  }
}

/**
 * The board digest the mission prompt embeds: the columns with their
 * counts, then every open ticket (everything but the terminal column)
 * as one line each. Capped — a board too big to fit is reported with an
 * elision line, never cut mid-ticket.
 */
function boardDigest(snap: BoardSnapshot): string {
  const lines: string[] = [];
  if (snap.columns.length > 0) {
    lines.push(`columns: ${snap.columns.map((c) => `${c.phase.id} (${c.tickets.length})`).join(' → ')}`);
  }
  const terminal = snap.columns.length === 0 ? null : snap.columns[snap.columns.length - 1]!.phase.id;
  const open = snap.columns
    .filter((column) => column.phase.id !== terminal)
    .flatMap((column) => column.tickets.map((t) => ({ id: t.id, title: t.meta.title, phase: column.phase.id })));
  if (open.length > 0) {
    lines.push('open tickets:');
    for (const ticket of open) {
      lines.push(ticket.title === null ? `- ${ticket.id} — ${ticket.phase}` : `- ${ticket.id} "${ticket.title}" — ${ticket.phase}`);
    }
  }
  let out = '';
  let dropped = 0;
  for (const line of lines) {
    const cut = line.length > DIGEST_CAP ? `${line.slice(0, DIGEST_CAP - 1)}…` : line;
    // Room for the closing elision line is reserved up front, so the
    // digest never exceeds the cap it advertises.
    if (out !== '' && out.length + cut.length + 41 > DIGEST_CAP) {
      dropped += 1;
      continue;
    }
    out = out === '' ? cut : `${out}\n${cut}`;
  }
  return dropped === 0 ? out : `${out}\n… ${dropped} more line(s) did not fit`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ChatService implements ChatServicePort {
  private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  private readonly git: TicketsGit;
  /** The sessions with a mission turn in flight — one turn at a time. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ChatServiceDeps) {
    this.log = deps.log ?? (() => undefined);
    this.git = deps.git ?? new TicketsGit(() => 'git');
  }

  /** The chat sessions, newest first, each with its pending card count. */
  async sessions(): Promise<readonly ChatSessionMeta[]> {
    const vault = await this.vault();
    if (vault === null) {
      return [];
    }
    const files = (await this.deps.host.listMarkdownFiles(vault.id)).filter((f) => CHAT_FILE_PATTERN.test(f));
    const metas: ChatSessionMeta[] = [];
    for (const file of files) {
      const text = await this.deps.host.read(vault.id, file).catch(() => null);
      if (text === null) {
        continue;
      }
      const session = parseSessionFile(text, file);
      if (session === null) {
        continue;
      }
      metas.push({
        file,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: (await this.mtimeOf(vault, file)) ?? session.createdAt,
        pending: session.proposals.filter((p) => p.state === 'pending').length,
      });
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.file.localeCompare(a.file));
    return metas;
  }

  /** One session parsed from disk; null when the file is gone or holds no session. */
  async open(file: string): Promise<ChatSession | null> {
    const vault = await this.vault();
    if (vault === null) {
      return null;
    }
    const text = await this.deps.host.read(vault.id, file).catch(() => null);
    return text === null ? null : parseSessionFile(text, file);
  }

  async send(input: { readonly file: string; readonly text: string }): Promise<ChatTurnResult> {
    if (input.text.trim() === '') {
      return { ok: false, error: 'the message is empty' };
    }
    if (this.inFlight.has(input.file)) {
      return { ok: false, error: `${input.file} already has a mission turn in flight — wait for it to finish` };
    }
    this.inFlight.add(input.file);
    try {
      return await this.turn(input.file, input.text);
    } finally {
      this.inFlight.delete(input.file);
    }
  }

  async start(input: { readonly title?: string; readonly text: string }): Promise<ChatTurnResult> {
    if (input.text.trim() === '') {
      return { ok: false, error: 'the message is empty' };
    }
    const found = await this.boardAndVault();
    if (found === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const { vault } = found;
    // A missing title derives from the owner's first words — the file name
    // stays readable in the vault's file listing either way.
    const title = (input.title ?? '').trim() !== '' ? input.title!.trim() : titleFromDescription(input.text);
    const stamp = this.now();
    const file = `${CHAT_DIR}/${chatFileName(stamp, title)}`;
    await this.deps.host.write(vault.id, file, newSessionText(title, stamp));
    await this.commit(vault, [file], `tickets: chat started ${file}`);
    this.deps.host.announceChanges(vault.id, [file]);
    return this.turn(file, input.text);
  }

  async confirm(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult> {
    return this.decide(input, 'confirmed');
  }

  async dismiss(input: { readonly file: string; readonly id: string }): Promise<ChatDecisionResult> {
    return this.decide(input, 'dismissed');
  }

  // --- the mission turn ----------------------------------------------------

  /**
   * One round of the conversation: the owner line lands as its own write
   * and commit, then the bridge streams the mission's answer and the
   * whole turn block (thinking trace, reply, every proposal card) lands
   * as one write and one commit. A crashed bridge leaves the owner line
   * as the honest record and reports the error through the stream.
   */
  private async turn(file: string, text: string): Promise<ChatTurnResult> {
    const found = await this.boardAndVault();
    if (found === null) {
      return { ok: false, error: 'no tickets vault detected', file };
    }
    const { vault, snap } = found;
    let current: string;
    try {
      current = await this.deps.host.read(vault.id, file);
    } catch {
      return { ok: false, error: `${file} does not exist`, file };
    }

    // The reader forgives a hand-edited file: history degrades to empty
    // rather than refusing the owner their turn. The session is parsed
    // BEFORE the owner line lands — the just-sent message arrives as
    // `text`, it must not double into the continuity history.
    const session = parseSessionFile(current, file);
    const history = (session?.messages ?? []).slice(-HISTORY_LIMIT).map((m: ChatMessage) => ({ role: m.role, text: m.text }));

    current = appendOwner(current, this.now(), text.trim());
    await this.deps.host.write(vault.id, file, current);
    await this.commit(vault, [file], `tickets: chat ${file}`);
    this.deps.host.announceChanges(vault.id, [file]);

    const stamp = this.now();
    let block = current;
    let say: string;
    let thought: string | null;
    let proposals: ChatProposal[];
    try {
      const reply = await this.deps.bridge.runTurn({
        text,
        history,
        board: boardDigest(snap),
        emit: (event) => this.deps.onEvent(file, event),
      });
      say = reply.say;
      thought = reply.thought;
      block = appendMission(block, stamp, reply.say, reply.thought);
      proposals = [];
      for (const command of reply.commands) {
        const summary = summaryOf(command);
        const appended = appendProposal(block, stamp, summary, command);
        block = appended.text;
        proposals.push({
          id: appended.id,
          state: 'pending',
          summary,
          command,
          at: stamp.toISOString(),
          decidedAt: null,
          outcome: null,
        });
      }
    } catch (error) {
      const message = messageOf(error);
      this.log(`mission turn for ${file} failed: ${message}`, 'warn');
      this.deps.onEvent(file, { kind: 'error', message });
      return { ok: false, error: message, file };
    }
    await this.deps.host.write(vault.id, file, block);
    await this.commit(vault, [file], `tickets: chat ${file}`);
    this.deps.host.announceChanges(vault.id, [file]);
    return {
      ok: true,
      file,
      say,
      ...(thought === null ? {} : { thought }),
      proposals,
    };
  }

  // --- the owner's decision ------------------------------------------------

  /**
   * The shared decision path: the pending proposal is re-read from disk
   * (a hand-decided or foreign file refuses instead of guessing), a
   * confirm executes the card's command through the board port first —
   * a failed execution leaves the proposal pending —, then the decision
   * line lands as one write and one commit.
   */
  private async decide(
    input: { readonly file: string; readonly id: string },
    state: 'confirmed' | 'dismissed',
  ): Promise<ChatDecisionResult> {
    const found = await this.boardAndVault();
    if (found === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const { vault, snap } = found;
    let text: string;
    try {
      text = await this.deps.host.read(vault.id, input.file);
    } catch {
      return { ok: false, error: `${input.file} does not exist` };
    }
    const session = parseSessionFile(text, input.file);
    if (session === null) {
      return { ok: false, error: `${input.file} is not a chat session` };
    }
    const proposal = session.proposals.find((p) => p.id === input.id) ?? null;
    if (proposal === null) {
      return { ok: false, error: `${input.file} has no proposal ${input.id}` };
    }
    if (proposal.state !== 'pending') {
      return { ok: false, error: `proposal ${input.id} was already ${proposal.state}` };
    }
    let outcome: string | null = null;
    if (state === 'confirmed') {
      const executed = await this.execute(proposal.command, snap);
      if (!executed.ok) {
        return { ok: false, error: executed.error };
      }
      outcome = executed.outcome;
    }
    const decided = decideProposal(text, this.now(), input.id, state, outcome);
    if (decided === null) {
      return { ok: false, error: `proposal ${input.id} is not pending` };
    }
    await this.deps.host.write(vault.id, input.file, decided);
    await this.commit(vault, [input.file], `tickets: chat ${input.file}`);
    this.deps.host.announceChanges(vault.id, [input.file]);
    // The file is the truth — hand the caller back exactly what it now holds.
    const reread = parseSessionFile(decided, input.file);
    return { ok: true, proposal: reread!.proposals.find((p) => p.id === input.id)! };
  }

  /**
   * The confirm's execution — the iron rule in code: the typed command
   * reaches the board ONLY through these five methods, always with the
   * acting owner. The outcome line records what happened: a transition's
   * moved path, a create's minted id, `ok` otherwise. A create lands in
   * the pipeline's first phase (the board's capture target); when the
   * card named another phase, the card walks there through the same
   * transition the invoke channel exposes.
   */
  private async execute(
    command: ChatCommand,
    snap: BoardSnapshot,
  ): Promise<{ readonly ok: true; readonly outcome: string } | { readonly ok: false; readonly error: string }> {
    const actor = this.deps.actor;
    switch (command.kind) {
      case 'transition': {
        const result = await this.deps.board.transition({ id: command.id, from: command.from, to: command.to, actor });
        return result.ok ? { ok: true, outcome: result.path ?? 'ok' } : { ok: false, error: result.error };
      }
      case 'createTicket': {
        const result = await this.deps.board.createTicket({
          title: command.title,
          description: command.description,
          priority: command.priority,
          repo: null,
          actor,
        });
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        const first = snap.pipeline[0]?.id ?? null;
        const id = result.id ?? null;
        if (first !== null && command.phase !== first && id !== null) {
          const moved = await this.deps.board.transition({ id, from: first, to: command.phase, actor });
          if (!moved.ok) {
            return { ok: false, error: moved.error };
          }
        }
        return { ok: true, outcome: result.id ?? 'ok' };
      }
      case 'setPriority': {
        const result = await this.deps.board.setPriority({ id: command.id, priority: command.priority, actor });
        return result.ok ? { ok: true, outcome: 'ok' } : { ok: false, error: result.error };
      }
      case 'promote': {
        const result = await this.deps.board.setForm({ id: command.id, form: 'ship', actor });
        return result.ok ? { ok: true, outcome: 'ok' } : { ok: false, error: result.error };
      }
      case 'setChain': {
        const result = await this.deps.board.setChain({ id: command.id, chain: command.chain, actor });
        return result.ok ? { ok: true, outcome: 'ok' } : { ok: false, error: result.error };
      }
    }
  }

  // --- the host plumbing ----------------------------------------------------

  /** The board's vault — the snapshot names it, the host registry holds it. */
  private async boardAndVault(): Promise<{ readonly snap: BoardSnapshot; readonly vault: EngineVault } | null> {
    const snap = await this.deps.board.snapshot();
    const vaultId = snap.vaultId;
    if (vaultId === null) {
      return null;
    }
    const vault = (await this.deps.host.listVaults()).find((v) => v.id === vaultId) ?? null;
    return vault === null ? null : { snap, vault };
  }

  /** The vault alone — for reads that need no board data. */
  private async vault(): Promise<EngineVault | null> {
    const found = await this.boardAndVault();
    return found === null ? null : found.vault;
  }

  /** The file's mtime as an ISO stamp — null when the stat fails. */
  private async mtimeOf(vault: EngineVault, file: string): Promise<string | null> {
    const abs = this.deps.host.resolveAssetPath(vault.id, file);
    if (abs === null) {
      return null;
    }
    try {
      return (await fsp.stat(abs)).mtime.toISOString();
    } catch {
      return null;
    }
  }

  /** One commit for exactly these vault-relative paths; failures log, never throw. */
  private async commit(vault: EngineVault, vaultRelPaths: readonly string[], message: string): Promise<void> {
    const location = await this.git.locate(vault.path);
    if (location === null) {
      this.log('the tickets vault is not a git repository — the chat change is not versioned', 'info');
      return;
    }
    try {
      await this.git.commitPaths(
        location.root,
        vaultRelPaths.map((p) => `${location.prefix}${p}`),
        message,
      );
    } catch (error) {
      this.log(`git commit failed: ${messageOf(error)}`, 'warn');
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
