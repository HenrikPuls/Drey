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
  ChatFlowDraft,
  ChatDecisionResult,
  ChatMessage,
  ChatProposal,
  ChatServicePort,
  ChatShapeContext,
  ChatShapeResult,
  ChatSplitChoice,
  ChatSession,
  ChatSessionMeta,
  ChatStreamEvent,
  PlanMark,
  PlanStatus,
  ChatTurnResult,
} from '../contracts/chat';
import { titleFromDescription, type BoardSnapshot, type TicketForm, type TicketPriority } from '../contracts/tickets';
import { parsePlanParts } from '../core/plan-parts';
import { ticketRefsOf } from '../core/chat-ticket-refs';
import { changedLinesOf, editsSummary, planDelta, planDeltaForModel, planSectionOf } from '../core/plan-delta';
import type { PlanShadowStore } from './plan-shadow';
import {
  appendMission,
  appendOwner,
  appendPlanEdit,
  appendQuestion,
  appendSources,
  appendSplit,
  decideSplit,
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
/** The ticket text a shape turn embeds in the prompt, ceiling in characters. */
const TICKET_TEXT_CAP = 30_000;
/** A named ticket's file in a mission turn, ceiling in characters (up to five ride one turn), and how many of its latest comments. */
const NAMED_TICKET_CAP = 8_000;
const NAMED_COMMENTS = 20;

/** The result shape of a board mutation the confirm path executes. */
export type ChatMutationResult =
  | { readonly ok: true; readonly warning?: string; readonly path?: string; readonly id?: string }
  | { readonly ok: false; readonly error: string };

/**
 * The board surface the chat composes (ADR-0088, E5a): the snapshot for
 * the digest and the vault lookup, plus exactly the mutation methods a
 * proposal card can carry — no second write path. The board service fits
 * this port unchanged.
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
  /** E10-2: a ticket's file text (the shared plan lives in it); optional so plain chats need nothing. */
  readTicket?(
    id: string,
  ): Promise<
    | { readonly ok: true; readonly text: string; readonly comments?: readonly { readonly author: string; readonly at: string; readonly text: string }[] }
    | { readonly ok: false; readonly error: string }
  >;
  /**
   * E10-3: replaces the ticket's `## Plan` chapter — the one write a shape
   * turn lets the model make, and nothing else of the ticket changes.
   */
  setPlan?(input: { readonly id: string; readonly plan: string; readonly actor?: string }): Promise<ChatMutationResult>;
  /** E10-3: a read-only look into the ticket's repository (a trailing `/` lists a directory). */
  readRepoFile?(
    id: string,
    path: string,
  ): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }>;
  /**
   * D-7a: a ticket by id wherever it is — on the board, done or archived —
   * for the tickets the owner names; the chat falls back to `readTicket`.
   */
  readAnyTicket?(
    id: string,
  ): Promise<
    | { readonly ok: true; readonly text: string; readonly comments?: readonly { readonly author: string; readonly at: string; readonly text: string }[] }
    | { readonly ok: false; readonly error: string }
  >;
  /** T-0050: the whole `blocked-by:` list replacement (empty = cleared). */
  setBlockedBy(input: { readonly id: string; readonly blockedBy: readonly string[]; readonly actor?: string }): Promise<ChatMutationResult>;
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
  /** E10-2: the plan shadow copies; absent = shape sessions carry no plan delta. */
  readonly shadows?: PlanShadowStore;
  /** E10-3: the model a shape turn runs on (the chat model), shown in the context line. */
  readonly modelName?: () => Promise<string | undefined>;
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
    case 'setBlockedBy':
      return command.blockedBy.length === 0
        ? `Clear ${command.id} blockers`
        : `Block ${command.id} by ${command.blockedBy.join(', ')}`;
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
  // The configured priority vocabulary (weight order) — the model never
  // invents a priority word, it picks one from here.
  if (snap.priorities.order.length > 0) {
    lines.push(`priorities (weight order): ${snap.priorities.order.join(' → ')}`);
  }
  if (snap.columns.length > 0) {
    lines.push(`columns: ${snap.columns.map((c) => `${c.phase.id} (${c.tickets.length})`).join(' → ')}`);
    // D-7a: the digest lists open tickets only, and the model must not read
    // that as "the ticket does not exist".
    lines.push('Closed (terminal-column) tickets and tickets that do not fit are not listed; a ticket the owner names by id is attached below.');
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
    const found = await this.boardAndVault();
    if (found === null) {
      return [];
    }
    const { vault, snap } = found;
    const files = (await this.deps.host.listMarkdownFiles(vault.id)).filter((f) => CHAT_FILE_PATTERN.test(f));
    const metas: ChatSessionMeta[] = [];
    for (const file of files) {
      const text = await this.deps.host.read(vault.id, file).catch(() => null);
      if (text === null) {
        continue;
      }
      const session = parseSessionFile(text, file, snap.priorities);
      if (session === null) {
        continue;
      }
      metas.push({
        file,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: (await this.mtimeOf(vault, file)) ?? session.createdAt,
        pending: session.proposals.filter((p) => p.state === 'pending').length,
        ...(session.ticket == null ? {} : { ticket: session.ticket }),
      });
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.file.localeCompare(a.file));
    return metas;
  }

  /** One session parsed from disk; null when the file is gone or holds no session. */
  async open(file: string): Promise<ChatSession | null> {
    const found = await this.boardAndVault();
    if (found === null) {
      return null;
    }
    const { vault, snap } = found;
    const text = await this.deps.host.read(vault.id, file).catch(() => null);
    const session = text === null ? null : parseSessionFile(text, file, snap.priorities);
    if (session === null || session.ticket == null || this.deps.modelName === undefined) {
      return session;
    }
    const model = await this.deps.modelName().catch(() => undefined);
    return model === undefined || model === '' ? session : { ...session, model };
  }

  async send(input: { readonly file: string; readonly text: string; readonly planEdits?: boolean; readonly context?: string }): Promise<ChatTurnResult> {
    if (input.text.trim() === '') {
      return { ok: false, error: 'the message is empty' };
    }
    if (this.inFlight.has(input.file)) {
      return { ok: false, error: `${input.file} already has a mission turn in flight — wait for it to finish` };
    }
    this.inFlight.add(input.file);
    try {
      return await this.turn(input.file, input.text, input.planEdits !== false, input.context);
    } finally {
      this.inFlight.delete(input.file);
    }
  }

  async start(input: { readonly title?: string; readonly text: string; readonly ticket?: string; readonly context?: string }): Promise<ChatTurnResult> {
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
    await this.deps.host.write(vault.id, file, newSessionText(title, stamp, input.ticket));
    await this.commit(vault, [file], `tickets: chat started ${file}`);
    this.deps.host.announceChanges(vault.id, [file]);
    return this.turn(file, input.text, true, input.context);
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
  private async turn(file: string, text: string, planEdits = true, reference?: string): Promise<ChatTurnResult> {
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
    // `text`, it must not double into the continuity history. The board's
    // priority vocabulary validates the proposal blocks with it.
    const session = parseSessionFile(current, file, snap.priorities);
    const history = (session?.messages ?? [])
      .filter((m: ChatMessage) => m.kind !== 'plan-edit')
      .slice(-HISTORY_LIMIT)
      .map((m: ChatMessage) => ({ role: m.role, text: m.text }));

    // E10-2: a shape session shares one plan with the model. Only what the
    // owner changed since the model's last turn goes along — as a diff for
    // the model and a "You edited the plan" card in the history. Switched
    // off (the chip deselected), the edits are acknowledged but never sent.
    const ticket = session?.ticket ?? null;
    const planBefore = ticket === null ? null : await this.planOf(ticket);
    const shadow = ticket === null || this.deps.shadows === undefined ? null : await this.deps.shadows.get(ticket);
    const delta = planEdits && planBefore !== null && shadow !== null ? planDelta(shadow.text, planBefore) : null;
    if (delta !== null) {
      current = appendPlanEdit(current, this.now(), delta.summary, delta.diff);
    }

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
      const shape = ticket === null ? undefined : await this.shapeContext(ticket);
      const named = await this.namedTickets(text, history);
      const reply = await this.deps.bridge.runTurn({
        text,
        history,
        board: boardDigest(snap),
        priorities: snap.priorities,
        ...(named === null ? {} : { named }),
        ...(delta === null ? {} : { planDelta: planDeltaForModel(delta) }),
        ...(reference === undefined || reference.trim() === '' ? {} : { reference }),
        ...(shape === undefined ? {} : { shape }),
        emit: (event) => this.deps.onEvent(file, event),
      });
      if (reply.failure !== undefined) {
        // D-1: no model answered. The owner's line stays in the file, the
        // failure is never written down as the mission's reply (the next
        // turn's history would feed it to the model as if it had said it);
        // the card on the owner's screen names provider, endpoint, reason.
        this.log(`mission turn for ${file}: ${reply.failure.message}`, 'warn');
        this.deps.onEvent(file, { kind: 'error', message: reply.failure.message });
        return { ok: false, error: reply.failure.message, failure: reply.failure, file };
      }
      say = reply.say;
      thought = reply.thought;
      let wrote = true;
      if (ticket !== null && reply.shape?.plan != null) {
        const saved = await this.deps.board.setPlan?.({ id: ticket, plan: reply.shape.plan, actor: this.deps.actor });
        if (saved === undefined || !saved.ok) {
          wrote = false;
          say = `${say}\n\nThe plan could not be saved: ${saved === undefined ? 'this desk cannot write plans' : saved.error}`;
        }
      }
      block = appendMission(block, stamp, say, reply.thought);
      if (ticket !== null && reply.shape !== undefined) {
        block = appendSources(block, stamp, reply.shape.sources);
        if (reply.shape.question !== null) {
          block = appendQuestion(block, stamp, reply.shape.question.text, reply.shape.question.options);
        }
        if (reply.shape.splitReason !== null && wrote) {
          block = appendSplit(block, stamp, reply.shape.splitReason, await this.partCount(ticket));
        }
      }
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
    // The shadow is the plan at the end of the model's turn: its own edits
    // are in it and never come back as the owner's delta.
    if (ticket !== null && planBefore !== null && this.deps.shadows !== undefined) {
      const planAfter = (await this.planOf(ticket)) ?? planBefore;
      await this.deps.shadows.set(ticket, {
        version: (shadow?.version ?? 0) + 1,
        text: planAfter,
        modelLines: changedLinesOf(planBefore, planAfter),
        at: this.now().toISOString(),
      });
    }
    return {
      ok: true,
      file,
      say,
      ...(thought === null ? {} : { thought }),
      proposals,
    };
  }

  /**
   * D-7a: the tickets the owner named, read on demand. The ids come from
   * this message, else from the latest owner messages (a follow-up such as
   * "and who merged it?" keeps its ticket). Each ticket's file (and its
   * comments on a store) is a block of its own; a missing one says so.
   * Null = nothing was named.
   */
  private async namedTickets(text: string, history: readonly { readonly role: string; readonly text: string }[]): Promise<string | null> {
    let ids = ticketRefsOf(text);
    if (ids.length === 0) {
      const recent = history.filter((m) => m.role === 'owner').slice(-3).reverse();
      for (const message of recent) {
        ids = ticketRefsOf(message.text);
        if (ids.length > 0) {
          break;
        }
      }
    }
    const reader = this.deps.board.readAnyTicket ?? this.deps.board.readTicket;
    if (ids.length === 0 || reader === undefined) {
      return null;
    }
    const blocks: string[] = [];
    for (const id of ids) {
      const reply = await reader.call(this.deps.board, id).catch((error: unknown) => ({ ok: false as const, error: messageOf(error) }));
      if (!reply.ok) {
        blocks.push(`### ${id}\n\nError: ${reply.error}`);
        continue;
      }
      const body = reply.text.length > NAMED_TICKET_CAP ? `${reply.text.slice(0, NAMED_TICKET_CAP)}\n… (cut)` : reply.text;
      const thread = (reply.comments ?? []).slice(-NAMED_COMMENTS).map((c) => `- ${c.author} · ${c.at}: ${c.text.trim()}`);
      blocks.push(`### ${id}\n\n${body.trim()}${thread.length === 0 ? '' : `\n\n#### Thread\n\n${thread.join('\n')}`}`);
    }
    return `## Tickets the owner named\n\nThese are the tickets' own files, read just now — they hold the truth for these ids, whatever column they sit in (the digest above lists open tickets only).\n\n${blocks.join('\n\n')}`;
  }

  // --- shape mode (E10-3) -----------------------------------------------------

  /** What a shape turn hands the bridge: the ticket's file text and the read-only repository access. */
  private async shapeContext(ticket: string): Promise<ChatShapeContext | undefined> {
    const reader = this.deps.board.readTicket;
    const reply = reader === undefined ? null : await reader.call(this.deps.board, ticket).catch(() => null);
    if (reply === null || !reply.ok) {
      return undefined;
    }
    const readRepo = this.deps.board.readRepoFile;
    return {
      ticket,
      ticketText: reply.text.length > TICKET_TEXT_CAP ? `${reply.text.slice(0, TICKET_TEXT_CAP)}\n… (cut)` : reply.text,
      readFile: async (path) =>
        readRepo === undefined
          ? { ok: false, error: 'this ticket has no repository to read' }
          : readRepo.call(this.deps.board, ticket, path),
    };
  }

  /** How many parts the ticket's plan lists now (never fewer than one) — the "N" of "Split into N tickets". */
  private async partCount(ticket: string): Promise<number> {
    const reader = this.deps.board.readTicket;
    const reply = reader === undefined ? null : await reader.call(this.deps.board, ticket).catch(() => null);
    return reply !== null && reply.ok ? Math.max(1, parsePlanParts(reply.text).parts.length) : 1;
  }

  /**
   * The owner's tap on Paul's split proposal. `keep` moves the ticket from
   * its phase into the build queue through the board's own transition —
   * the same path a confirmed card takes; `split` only records the choice
   * (the plan to approve, E10-4, picks it up). Either way the decision
   * line lands in the session file.
   */
  async shapeDecide(input: { readonly file: string; readonly choice: ChatSplitChoice }): Promise<ChatShapeResult> {
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
    const session = parseSessionFile(text, input.file, snap.priorities);
    if (session === null || session.ticket === undefined || session.ticket === null) {
      return { ok: false, error: `${input.file} is not a shape session` };
    }
    const open = [...session.messages].reverse().find((m) => m.kind === 'split');
    if (open === undefined || (open.decision ?? null) !== null) {
      return { ok: false, error: 'there is no open split proposal' };
    }
    const ticket = session.ticket;
    let outcome = 'split';
    let summary = `Split into ${open.parts ?? 1} tickets`;
    if (input.choice === 'keep') {
      const column = snap.columns.find((c) => c.tickets.some((t) => t.id === ticket));
      if (column === undefined) {
        return { ok: false, error: `${ticket} is not on the board` };
      }
      const phases = snap.pipeline.map((p) => p.id);
      const from = column.phase.id;
      const to = phases.includes('build') ? 'build' : (phases[phases.indexOf(from) + 1] ?? null);
      if (to === null || phases.indexOf(to) <= phases.indexOf(from)) {
        return { ok: false, error: `${ticket} is already past the build queue` };
      }
      const moved = await this.deps.board.transition({ id: ticket, from, to, actor: this.deps.actor });
      if (!moved.ok) {
        return { ok: false, error: moved.error };
      }
      outcome = moved.path ?? 'ok';
      summary = 'Keep as one ticket';
    }
    const decided = decideSplit(text, this.now(), input.choice, summary);
    if (decided === null) {
      return { ok: false, error: 'there is no open split proposal' };
    }
    await this.deps.host.write(vault.id, input.file, decided);
    await this.commit(vault, [input.file], `tickets: chat ${input.file}`);
    this.deps.host.announceChanges(vault.id, [input.file]);
    return { ok: true, outcome };
  }

  // --- the shared plan (E10-2) ------------------------------------------------

  /** The ticket's Plan section; null when the ticket cannot be read. */
  private async planOf(ticket: string): Promise<string | null> {
    const reader = this.deps.board.readTicket;
    if (reader === undefined) {
      return null;
    }
    const reply = await reader.call(this.deps.board, ticket).catch(() => null);
    return reply !== null && reply.ok ? planSectionOf(reply.text) : null;
  }

  /**
   * Paul drafts a flow (E10-5): one bridge turn under the flow prompt, the
   * single setChain command read back as the proposed delta. No session
   * file, no write — the draft lives on the owner's screen until "Save flow".
   */
  async draftFlow(input: { readonly ticket: string; readonly context: string; readonly ask: string | null }): Promise<ChatFlowDraft> {
    const text = input.ask ?? 'Draft the flow for this ticket.';
    let reply: Awaited<ReturnType<ChatBridge['runTurn']>>;
    try {
      reply = await this.deps.bridge.runTurn({ text, history: [], board: '', flow: { context: input.context }, emit: () => undefined });
    } catch (error) {
      return { ok: false, error: `Paul could not be reached (${error instanceof Error ? error.message : String(error)}).` };
    }
    if (reply.failure !== undefined) {
      return { ok: false, error: reply.failure.message };
    }
    const command = reply.commands.find((c) => c.kind === 'setChain');
    if (command === undefined || command.kind !== 'setChain') {
      return { ok: false, error: reply.say.trim() === '' ? 'Paul did not propose a flow.' : reply.say.trim() };
    }
    return { ok: true, chain: command.chain, reason: reply.say.trim() };
  }

  /**
   * Where the shared plan stands: the version the model last saw, the
   * owner's edit groups since, and the marked lines — the owner's changed
   * lines against the shadow, the model's lines from its last turn.
   * `ticketText` stands in for the file on disk.
   */
  async planStatus(ticket: string, ticketText?: string): Promise<PlanStatus> {
    // The desktop passes the open buffer's text (E13-9): its unsaved edits are marked too.
    const plan = ticketText === undefined ? await this.planOf(ticket) : planSectionOf(ticketText);
    if (plan === null) {
      return { ok: false, error: `${ticket} has no readable plan` };
    }
    const shadow = this.deps.shadows === undefined ? null : await this.deps.shadows.get(ticket);
    const delta = shadow === null ? null : planDelta(shadow.text, plan);
    const lines = plan.split('\n');
    const marks: PlanMark[] = [];
    for (const no of shadow === null ? [] : shadow.modelLines) {
      if (no >= 1 && no <= lines.length && !(delta?.lines.includes(no) ?? false)) {
        marks.push({ no, text: lines[no - 1]!, by: 'model' });
      }
    }
    for (const no of delta?.lines ?? []) {
      marks.push({ no, text: lines[no - 1]!, by: 'you' });
    }
    marks.sort((a, b) => a.no - b.no);
    return {
      ok: true,
      version: shadow?.version ?? null,
      modelAt: shadow?.at ?? null,
      edits: delta?.edits ?? 0,
      summary: delta === null ? null : editsSummary(delta.edits, delta.added, delta.removed),
      marks: marks.slice(0, 60),
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
    const session = parseSessionFile(text, input.file, snap.priorities);
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
    const reread = parseSessionFile(decided, input.file, snap.priorities);
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
      case 'setBlockedBy': {
        const result = await this.deps.board.setBlockedBy({ id: command.id, blockedBy: command.blockedBy, actor });
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
