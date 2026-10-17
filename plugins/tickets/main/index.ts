/**
 * The Tickets plugin's main entry (ADR-0076, milestone 83): detects the
 * tickets vault (a registered vault with `tickets/_meta/pipeline.md`),
 * assembles board snapshots from files, and performs the mutations —
 * capture, transitions (move + stamp + log + one git commit), order
 * pins, claims, initialization. All mutations run through one queue
 * (single-writer discipline) and re-resolve the tickets vault's state
 * inside the queue, so nothing interleaves.
 *
 * The renderer only ever sees BoardSnapshot payloads — parsing,
 * validation and YAML stay here.
 */
import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import type {
  MainPluginContext,
  MainPluginModule,
  VaultChangeEvent,
} from '../../../shared/plugin-api';
import {
  nextTicketId,
  type BoardSnapshot,
  type TicketCard,
  type TicketPriority,
  TICKET_PRIORITIES,
} from '../shared/tickets';
import {
  assembleBoard,
  orderAfterInsert,
  parseOrderFile,
  pinsAfterDrop,
  rewriteOrderSection,
} from './ticket-board';
import { newTicketFileText, patchTicketFile } from './ticket-files';
import { TicketsGit, type RepoLocation } from './tickets-git';

const PIPELINE_PATH = 'tickets/_meta/pipeline.md';
const ORDER_PATH = 'tickets/_meta/order.md';
const REPOS_PATH = 'tickets/_meta/repos.md';

const OWNER = `owner@${hostname().toLowerCase()}`;

const DEFAULT_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: plan, title: Plan, wip: 1, handover: manual }
  - { id: plan-review, title: Plan review, handover: manual }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }
  - { id: review, title: Review, handover: manual }
  - { id: commit, title: Commit, handover: manual }
  - { id: done, title: Done, handover: none }
---
The pipeline: ordered phases (first = capture target, last = terminal),
configurable per handover (manual | agent <prompt-ref> | ci | none).
See specs/ticket-schema.md. Edit freely; the board follows on refresh.
`;

const DEFAULT_ORDER = `# Column order pins — listed ids form the top of their column

Unlisted tickets follow the derived order (priority, rank, entered).
A drag in the board rewrites the affected section; sections are
sparse on purpose so independent additions merge cleanly.
`;

const DEFAULT_REPOS = `---
repos: {}
---
Work repositories a ticket's \`repo:\` field may name. Example:

  lariscus:
    url: https://dev.azure.com/org/project/_git/lariscus
    branch: main
    policy: Azure DevOps branch policies protect main
`;

type MutationResult =
  | { readonly ok: true; readonly warning?: string }
  | { readonly ok: false; readonly error: string };

interface VaultLike {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

class BoardService {
  private queueTail: Promise<unknown> = Promise.resolve();
  private readonly gitLocations = new Map<string, RepoLocation | null>();
  private emitDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: MainPluginContext,
    private readonly git: TicketsGit,
  ) {}

  /** The board's emit, debounced — one push per burst of changes. */
  announceChanged(): void {
    if (this.emitDebounce !== null) {
      return;
    }
    this.emitDebounce = setTimeout(() => {
      this.emitDebounce = null;
      this.ctx.ipc.emit('board-changed');
    }, 200);
  }

  private async readOptional(vaultId: string, path: string): Promise<string | null> {
    try {
      return await this.ctx.vault.read(path, { vaultId });
    } catch {
      return null;
    }
  }

  /** A registered, existing vault containing the pipeline marker file. */
  async detect(): Promise<VaultLike | null> {
    const vaults = await this.ctx.vault.listVaults();
    const candidates = vaults.filter((v) => v.exists);
    const configured = await this.ctx.config.get<string>('vaultId');
    const ordered = configured === undefined ? candidates : [
      ...candidates.filter((v) => v.id === configured),
      ...candidates.filter((v) => v.id !== configured),
    ];
    for (const vault of ordered) {
      if (await this.readOptional(vault.id, PIPELINE_PATH) !== null) {
        return vault;
      }
    }
    return null;
  }

  private async locate(vaultPath: string): Promise<RepoLocation | null> {
    if (!this.gitLocations.has(vaultPath)) {
      this.gitLocations.set(vaultPath, await this.git.locate(vaultPath));
    }
    return this.gitLocations.get(vaultPath) ?? null;
  }

  /** Snapshot from files — every fetch rebuilds (no stored board state). */
  async snapshot(): Promise<BoardSnapshot> {
    const [vault, vaults] = await Promise.all([
      this.detect(),
      this.ctx.vault.listVaults(),
    ]);
    const active = vaults.find((v) => v.active) ?? null;
    if (vault === null) {
      return assembleBoard({
        vaultId: null,
        vaultName: null,
        activeVaultName: active?.name ?? null,
        isGitRepo: false,
        pipelineText: null,
        orderText: null,
        reposText: null,
        files: [],
      });
    }
    const [pipelineText, orderText, reposText, mdFiles, location] = await Promise.all([
      this.readOptional(vault.id, PIPELINE_PATH),
      this.readOptional(vault.id, ORDER_PATH),
      this.readOptional(vault.id, REPOS_PATH),
      this.ctx.vault.listMarkdownFiles({ vaultId: vault.id }),
      this.locate(vault.path),
    ]);
    const paths = mdFiles.filter((p) => p.startsWith('tickets/') && !p.startsWith('tickets/_meta/'));
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        text: await this.ctx.vault.read(path, { vaultId: vault.id }),
      })),
    );
    return assembleBoard({
      vaultId: vault.id,
      vaultName: vault.name,
      activeVaultName: active?.name ?? null,
      isGitRepo: location !== null,
      pipelineText,
      orderText,
      reposText,
      files,
    });
  }

  /** Find a card anywhere on the board. */
  private async findCard(id: string): Promise<{ vault: VaultLike; card: TicketCard; text: string } | null> {
    const vault = await this.detect();
    if (vault === null) {
      return null;
    }
    const snap = await this.snapshot();
    for (const column of snap.columns) {
      const card = column.tickets.find((t) => t.id === id);
      if (card !== undefined) {
        return { vault, card, text: await this.ctx.vault.read(card.path, { vaultId: vault.id }) };
      }
    }
    return null;
  }

  /** Serialize mutations; failures never block the next one. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queueTail.catch(() => undefined).then(op);
    this.queueTail = next;
    return next;
  }

  /** The git step of a mutation: one commit for exactly these paths. */
  private async commit(vault: VaultLike, vaultRelPaths: readonly string[], message: string): Promise<string | null> {
    const location = await this.locate(vault.path);
    if (location === null) {
      return 'the tickets vault is not a git repository — the change is not versioned';
    }
    const repoRel = vaultRelPaths.map((p) => `${location.prefix}${p}`);
    try {
      await this.git.commitPaths(location.root, repoRel, message);
      return null;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.ctx.log(`git commit failed: ${text}`, 'warn');
      return `git commit failed: ${text.split('\n')[0]}`;
    }
  }

  createTicket(input: {
    title: string;
    priority: TicketPriority;
    repo: string | null;
    description: string;
  }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      if (snap.pipeline.length === 0) {
        return { ok: false, error: snap.pipelineError ?? 'the pipeline is empty' };
      }
      const ids = snap.columns.flatMap((c) => c.tickets.map((t) => t.id));
      const id = nextTicketId(ids);
      const firstPhase = snap.pipeline[0]!.id;
      const path = `tickets/${firstPhase}/${id}.md`;
      const text = newTicketFileText({
        id,
        title: input.title,
        repo: input.repo,
        priority: input.priority,
        rank: 5000,
        firstPhase,
        now: new Date(),
        actor: OWNER,
        description: input.description,
      });
      try {
        await this.ctx.vault.writeAnnounced(path, text, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [path], `tickets: ${id} + ${firstPhase}`);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  transition(input: {
    id: string;
    from: string;
    to: string;
    index: number | null;
  }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      const fromCol = snap.columns.find((c) => c.phase.id === input.from);
      const card = fromCol?.tickets.find((t) => t.id === input.id) ?? null;
      if (card === null) {
        return {
          ok: false,
          error: `${input.id} is not in "${input.from}" — it may have moved; refresh the board`,
        };
      }
      const toPhase = snap.pipeline.find((p) => p.id === input.to) ?? null;
      if (toPhase === null) {
        return { ok: false, error: `"${input.to}" is not a phase in the pipeline` };
      }
      if (card.path !== `tickets/${input.from}/${input.id}.md`) {
        return { ok: false, error: `${input.id} sits in an unexpected path (${card.path})` };
      }

      const text = await this.ctx.vault.read(card.path, { vaultId: vault.id });
      const claims = toPhase.claim && card.meta.claimedBy === null ? { claimBy: OWNER } : {};
      let patched: string;
      try {
        patched = patchTicketFile(text, {
          to: input.to,
          from: input.from,
          now: new Date(),
          actor: OWNER,
          ...claims,
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }

      const newPath = `tickets/${input.to}/${input.id}.md`;
      try {
        const oldAbs = this.ctx.vault.resolveAssetPath(card.path, { vaultId: vault.id });
        const dirAbs = this.ctx.vault.resolveAssetPath(`tickets/${input.to}`, { vaultId: vault.id });
        const newAbs = this.ctx.vault.resolveAssetPath(newPath, { vaultId: vault.id });
        if (oldAbs === null || dirAbs === null || newAbs === null) {
          return { ok: false, error: 'ticket path escapes the vault' };
        }
        await fsp.mkdir(dirAbs, { recursive: true });
        await fsp.rename(oldAbs, newAbs);
        await this.ctx.vault.write(newPath, patched, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `move failed: ${messageOf(error)}` };
      }

      // Order pins: the id leaves every section it was pinned in; a
      // drop index pins it — and everything above it — in the target
      // column. order.md is only created when a pin demands it.
      const orderText = await this.readOptional(vault.id, ORDER_PATH);
      const base = orderText ?? DEFAULT_ORDER;
      let nextOrder = removeIdFromPins(base, input.id);
      if (input.index !== null) {
        const columnIds = (snap.columns.find((c) => c.phase.id === input.to)?.tickets ?? [])
          .map((t) => t.id)
          .filter((x) => x !== input.id);
        const resulting = orderAfterInsert(columnIds, input.id, input.index);
        nextOrder = rewriteOrderSection(
          nextOrder,
          input.to,
          pinsAfterDrop(resulting, resulting.indexOf(input.id)),
        );
      }
      const orderChanged = nextOrder !== orderText && (orderText !== null || input.index !== null);
      if (orderChanged) {
        await this.ctx.vault.write(ORDER_PATH, nextOrder, { vaultId: vault.id });
      }

      const commitPaths = [card.path, newPath, ...(orderChanged ? [ORDER_PATH] : [])];
      const warning = await this.commit(
        vault,
        commitPaths,
        `tickets: ${input.id} ${input.from} -> ${input.to}`,
      );
      this.ctx.vault.announceChanges({
        vaultId: vault.id,
        changedPaths: [newPath, ...(orderChanged ? [ORDER_PATH] : [])],
        deletedPaths: [card.path],
      });
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  reorder(input: { phase: string; id: string; index: number }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      const column = snap.columns.find((c) => c.phase.id === input.phase) ?? null;
      if (column === null) {
        return { ok: false, error: `unknown phase "${input.phase}"` };
      }
      const orderText = await this.readOptional(vault.id, ORDER_PATH);
      const { pins } = parseOrderFile(orderText);
      const current = column.tickets.map((t) => t.id);
      const resulting = orderAfterInsert(current, input.id, input.index);
      const nextPins = pinsAfterDrop(resulting, resulting.indexOf(input.id));
      const previousPins = pins[input.phase] ?? [];
      if (nextPins.join(',') === previousPins.join(',') && orderText !== null) {
        return { ok: true };
      }
      const base = removeIdFromPins(orderText ?? DEFAULT_ORDER, input.id);
      const nextText = rewriteOrderSection(base, input.phase, nextPins);
      try {
        await this.ctx.vault.write(ORDER_PATH, nextText, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [ORDER_PATH], `tickets: order ${input.phase}`);
      this.ctx.vault.announceChanges({ vaultId: vault.id, changedPaths: [ORDER_PATH] });
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  setClaim(input: { id: string; mode: 'takeover' | 'release' }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      const previous = card.meta.claimedBy;
      if (input.mode === 'takeover' && previous === OWNER) {
        return { ok: false, error: 'you already hold this claim' };
      }
      if (input.mode === 'release' && previous === null) {
        return { ok: false, error: 'this ticket is not claimed' };
      }
      let patched: string;
      try {
        patched = patchTicketFile(text, {
          to: card.phase,
          from: null,
          now: new Date(),
          actor: OWNER,
          action:
            input.mode === 'takeover'
              ? `claim takeover${previous !== null ? ` (was ${previous})` : ''}`
              : 'claim release',
          ...(input.mode === 'takeover' ? { claimBy: OWNER } : { releaseClaim: true }),
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        await this.ctx.vault.write(card.path, patched, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} claim ${input.mode}`);
      this.ctx.vault.announceChanges({ vaultId: vault.id, changedPaths: [card.path] });
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  initialize(vaultId: string | null): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vaults = await this.ctx.vault.listVaults();
      const target =
        vaults.find((v) => v.id === vaultId && v.exists) ??
        vaults.find((v) => v.active && v.exists) ??
        null;
      if (target === null) {
        return { ok: false, error: 'no vault to initialize the board in' };
      }
      if (await this.readOptional(target.id, PIPELINE_PATH) !== null) {
        return { ok: false, error: `vault "${target.name}" already has a tickets board` };
      }
      try {
        await this.ctx.vault.write(PIPELINE_PATH, DEFAULT_PIPELINE, { vaultId: target.id });
        await this.ctx.vault.write(ORDER_PATH, DEFAULT_ORDER, { vaultId: target.id });
        await this.ctx.vault.write(REPOS_PATH, DEFAULT_REPOS, { vaultId: target.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(
        target,
        [PIPELINE_PATH, ORDER_PATH, REPOS_PATH],
        'tickets: initialize board',
      );
      this.ctx.vault.announceChanges({
        vaultId: target.id,
        changedPaths: [PIPELINE_PATH, ORDER_PATH, REPOS_PATH],
      });
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  onVaultEvent(event: VaultChangeEvent): void {
    // A registry round may have moved the tickets vault itself.
    if (event.vaultId === undefined && event.kind === 'refresh') {
      this.gitLocations.clear();
    }
    this.announceChanged();
  }
}

/** Strips one id from every pin section, in text form. */
function removeIdFromPins(orderText: string, id: string): string {
  const { pins } = parseOrderFile(orderText);
  let touched = false;
  const cleaned: Record<string, string[]> = {};
  for (const [section, ids] of Object.entries(pins)) {
    const kept = ids.filter((x) => x !== id);
    if (kept.length !== ids.length) {
      touched = true;
    }
    cleaned[section] = kept;
  }
  if (!touched) {
    return orderText;
  }
  let text = orderText;
  for (const [section, ids] of Object.entries(cleaned)) {
    text = rewriteOrderSection(text, section, ids);
  }
  return text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const gitPath = ((await ctx.config.get<string>('gitPath')) ?? '').trim();
    const git = new TicketsGit(() => (gitPath === '' ? 'git' : gitPath));
    const board = new BoardService(ctx, git);

    ctx.ipc.handle('board', () => board.snapshot());

    ctx.ipc.handle('create', async (payload) => {
      const p = payload as { title?: unknown; priority?: unknown; repo?: unknown; description?: unknown };
      const title = typeof p.title === 'string' ? p.title.trim() : '';
      if (title === '') {
        return { ok: false, error: 'the title is empty' };
      }
      const priority = TICKET_PRIORITIES.includes(p.priority as TicketPriority)
        ? (p.priority as TicketPriority)
        : 'normal';
      const repo = typeof p.repo === 'string' && p.repo.trim() !== '' ? p.repo.trim() : null;
      const description = typeof p.description === 'string' ? p.description : '';
      return board.createTicket({ title, priority, repo, description });
    });

    ctx.ipc.handle('transition', async (payload) => {
      const p = payload as { id?: unknown; from?: unknown; to?: unknown; index?: unknown };
      if (typeof p.id !== 'string' || typeof p.from !== 'string' || typeof p.to !== 'string') {
        return { ok: false, error: 'bad transition payload' };
      }
      return board.transition({
        id: p.id,
        from: p.from,
        to: p.to,
        index: typeof p.index === 'number' && p.index >= 0 ? Math.floor(p.index) : null,
      });
    });

    ctx.ipc.handle('reorder', async (payload) => {
      const p = payload as { phase?: unknown; id?: unknown; index?: unknown };
      if (typeof p.phase !== 'string' || typeof p.id !== 'string' || typeof p.index !== 'number') {
        return { ok: false, error: 'bad reorder payload' };
      }
      return board.reorder({ phase: p.phase, id: p.id, index: Math.floor(p.index) });
    });

    ctx.ipc.handle('claim', async (payload) => {
      const p = payload as { id?: unknown; mode?: unknown };
      if (typeof p.id !== 'string' || (p.mode !== 'takeover' && p.mode !== 'release')) {
        return { ok: false, error: 'bad claim payload' };
      }
      return board.setClaim({ id: p.id, mode: p.mode });
    });

    ctx.ipc.handle('initialize', async (payload) => {
      const p = payload as { vaultId?: unknown };
      return board.initialize(typeof p.vaultId === 'string' ? p.vaultId : null);
    });

    // Everything that can change the board: external rounds, saves of
    // ticket files, our own announces (the debounced emit coalesces).
    ctx.vault.onChanged((event) => board.onVaultEvent(event));
    ctx.save.onNoteSaved((event) => {
      if (event.path.startsWith('tickets/')) {
        board.announceChanged();
      }
    });
  },
};

export default plugin;
