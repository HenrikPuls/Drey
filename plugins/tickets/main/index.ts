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
import { shell } from 'electron';
import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import type {
  MainPluginContext,
  MainPluginModule,
  VaultChangeEvent,
} from '../../../shared/plugin-api';
import {
  nextTicketId,
  TICKETS_ARCHIVE_DIR,
  type BoardSnapshot,
  type FolderStatus,
  type PipelinePhase,
  type PromptEntry,
  type PromptListing,
  type TicketCard,
  type TicketPriority,
  TICKET_PRIORITIES,
} from '../shared/tickets';
import {
  assembleBoard,
  orderAfterInsert,
  parseOrderFile,
  patchPipelinePhase,
  parsePipeline,
  pinsAfterDrop,
  removeIdFromPins,
  reorderPipelinePhases,
  rewriteOrderSection,
} from './ticket-board';
import {
  newTicketFileText,
  patchTicketFile,
  ticketPathParts,
  ticketSections,
} from './ticket-files';
import { applyFolderNumbering, listTicketDirs, planFolderNumbering, resolvePhaseDir } from './phase-dirs';
import { planWorktreeRemoval } from './worktree-removal';
import { detectDrift, type DriftDetection } from './normalize';
import { openTerminalAt } from './open-terminal';
import { TicketsGit, type RepoLocation } from './tickets-git';
import { createFleetMcpTools } from './mcp-tools';
import { loadShippedPrompts } from './default-prompts';
import { FleetClient } from './fleet-client';
import { listWorkerModels } from './worker-models';
import { agentIdentity, composeRunRequest } from './fleet/request';
import { checkpointPhaseIds, columnPromptRef, isAutoPhase, nextPhaseIdOf } from './fleet/chain';
import { readRepoInstructions, worktreeDiffStat } from './fleet/context-pack';
import {
  cleanWorktrees,
  listOrphans,
  removeWorktree,
  type CleanupReport,
} from './fleet/worktree-clean';
import { unlinkShared } from './fleet/worktrees';
import { legacyWorktreeBase, worktreeBaseFor, worktreePathFor, WORKTREES_DIR } from './fleet/worktree-home';
import type { ChainConfig, FleetCaps, PermissionMode, RunInfo } from './fleet/protocol';
import { normalizeFleetCaps, normalizeFleetPools, WORKER_PROVIDERS, type FleetPools } from './fleet/protocol';

const PIPELINE_PATH = 'tickets/_meta/pipeline.md';
const ORDER_PATH = 'tickets/_meta/order.md';
const REPOS_PATH = 'tickets/_meta/repos.md';

const OWNER = `owner@${hostname().toLowerCase()}`;

const DEFAULT_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: plan, title: Plan, wip: 1, handover: agent plan-default }
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

const PROMPTS_DIR = 'tickets/_meta/prompts';
const PROMPT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;


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
  | { readonly ok: true; readonly warning?: string; readonly moved?: number }
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
  private lastChainConfig: string | null = null;

  constructor(
    private readonly ctx: MainPluginContext,
    private readonly git: TicketsGit,
    private readonly defaultWorker: string,
    private readonly autoPermissionMode: PermissionMode,
    private readonly gitPath: string,
    private readonly fleet: FleetClient,
    /** The fleet root — the worktrees the context pack stats live there. */
    private readonly fleetRoot: string,
    /** The instruction output caps (T-0048), resolved once at activation. */
    private readonly caps: FleetCaps,
    /** The per-provider pools (req-61), resolved once at activation. */
    private readonly pools: FleetPools,
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
    const vault = await this.probeVaults();
    // The plugin-managed flag follows detection both ways (SDK 1.32,
    // ADR-0082): while a board lives in a vault, that vault's free-form
    // git history is refused — one transition is one structured commit.
    this.ctx.vault.markManaged(vault === null ? null : vault.id);
    return vault;
  }

  private async probeVaults(): Promise<VaultLike | null> {
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

  /** The directories under `tickets/` as they exist on disk (T-0041) —
   *  what every writer resolves its target directory against. */
  private async ticketDirs(vault: VaultLike): Promise<string[]> {
    const abs = this.ctx.vault.resolveAssetPath('tickets', { vaultId: vault.id });
    return abs === null ? [] : await listTicketDirs(abs);
  }

  /** Snapshot from files — every fetch rebuilds (no stored board state). */
  async snapshot(): Promise<BoardSnapshot> {
    const [vault, vaults] = await Promise.all([
      this.detect(),
      this.ctx.vault.listVaults(),
    ]);
    const active = vaults.find((v) => v.active) ?? null;
    if (vault === null) {
      this.syncChainConfig(null, []);
      return assembleBoard({
        vaultId: null,
        vaultName: null,
        activeVaultName: active?.name ?? null,
        isGitRepo: false,
        defaultWorker: this.defaultWorker,
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
    const snapshot = assembleBoard({
      vaultId: vault.id,
      vaultName: vault.name,
      activeVaultName: active?.name ?? null,
      isGitRepo: location !== null,
      defaultWorker: this.defaultWorker,
      pipelineText,
      orderText,
      reposText,
      files,
    });
    // The chain follows the pipeline: an automatic column anywhere
    // points the runner at this vault (M85). Cheap and idempotent —
    // the runner re-reads the vault on every dispatch pass anyway.
    this.syncChainConfig(vault, snapshot.pipeline);
    return snapshot;
  }

  /** Keeps the runner's chain config in step with the pipeline (never spawns). */
  private syncChainConfig(
    vault: { readonly path: string } | null,
    pipeline: readonly PipelinePhase[],
  ): ChainConfig | null {
    const chain: ChainConfig | null =
      vault !== null && pipeline.some((phase) => isAutoPhase(phase))
        ? {
            ticketsVaultPath: vault.path,
            git: this.gitPath.trim() === '' ? 'git' : this.gitPath.trim(),
            defaultWorker: this.defaultWorker,
            permissionMode: this.autoPermissionMode,
            caps: this.caps,
            pools: this.pools,
          }
        : null;
    const json = chain === null ? null : JSON.stringify(chain);
    if (json === this.lastChainConfig) {
      return chain;
    }
    this.lastChainConfig = json;
    if (chain !== null) {
      void this.fleet.configureChain(chain);
    }
    return chain;
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

  /**
   * The `board` IPC route (T-0041): normalize first — a file move is a
   * ticket move — then snapshot. Normalization runs enqueued (the same
   * single-writer queue as every mutation) and snapshots are taken
   * OUTSIDE it, so this never nests `enqueue` inside `enqueue`.
   */
  async refresh(): Promise<BoardSnapshot> {
    await this.normalizeDrift();
    return this.snapshot();
  }

  /**
   * Stateless drift treatment, derived from the files alone (T-0041,
   * ADR-0076 later change): every ticket that sits in a phase its
   * `entered-*` stamps disagree with receives the full board-move
   * treatment — stamp, Log line, pin cleanup, exactly one commit. A
   * file dropped into `tickets/archive/` gets the archive treatment.
   * Idempotent by construction: the treatment makes the file's state
   * consistent, so the next pass finds nothing (the announce → re-fetch
   * echo lands on the fixpoint). Per-item try/catch: one broken ticket
   * never blocks the rest or the board.
   */
  private normalizeDrift(): Promise<void> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return;
      }
      const pipelineText = await this.readOptional(vault.id, PIPELINE_PATH);
      if (pipelineText === null) {
        return;
      }
      const { phases, pushRemote } = parsePipeline(pipelineText);
      const mdFiles = await this.ctx.vault.listMarkdownFiles({ vaultId: vault.id });
      const paths = mdFiles.filter((p) => p.startsWith('tickets/') && !p.startsWith('tickets/_meta/'));
      const files: { path: string; text: string }[] = [];
      for (const p of paths) {
        const text = await this.ctx.vault.read(p, { vaultId: vault.id }).catch(() => null);
        if (text !== null) {
          files.push({ path: p, text });
        }
      }
      for (const drift of detectDrift(files, phases)) {
        const text = files.find((f) => f.path === drift.path)?.text;
        if (text === undefined) {
          continue;
        }
        try {
          await this.treatDrift(vault, drift, text, pushRemote);
        } catch (error) {
          this.ctx.log(`normalizing ${drift.id} (${drift.path}) failed: ${messageOf(error)}`, 'warn');
        }
      }
    });
  }

  /** One drift's full transition treatment. The path never changes —
   *  only stamps, Log and pins; exactly one commit closes it. */
  private async treatDrift(
    vault: VaultLike,
    drift: DriftDetection,
    text: string,
    pushRemote: string | null,
  ): Promise<void> {
    const now = new Date();
    const patched =
      drift.kind === 'archive'
        ? patchTicketFile(text, { to: 'archive', from: null, now, actor: OWNER, action: 'archived' })
        : patchTicketFile(text, {
            to: drift.phase,
            // null (no event at all) logs honestly as `unknown -> <phase>`
            from: drift.from ?? 'unknown',
            now,
            actor: OWNER,
          });
    await this.ctx.vault.write(drift.path, patched, { vaultId: vault.id });

    const orderText = await this.readOptional(vault.id, ORDER_PATH);
    const nextOrder = orderText === null ? null : removeIdFromPins(orderText, drift.id);
    const orderChanged = nextOrder !== null && nextOrder !== orderText;
    if (orderChanged) {
      await this.ctx.vault.write(ORDER_PATH, nextOrder as string, { vaultId: vault.id });
    }

    const message =
      drift.kind === 'archive'
        ? `tickets: ${drift.id} archived`
        : `tickets: ${drift.id} ${drift.from ?? 'unknown'} -> ${drift.phase}`;
    await this.commit(vault, [drift.path, ...(orderChanged ? [ORDER_PATH] : [])], message);
    // The optional auto-push (T-0041): warning-level, never a failed move.
    await this.pushTransition(vault, pushRemote);
    this.ctx.vault.announceChanges({
      vaultId: vault.id,
      changedPaths: [drift.path, ...(orderChanged ? [ORDER_PATH] : [])],
    });
    this.announceChanged();
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

  /**
   * The optional auto-push after a transition commit (T-0041,
   * pipeline.md `push:`): `git push <remote> HEAD` from the tickets repo
   * root. A failure is a warning the panel shows — never a failed
   * transition; the commit is already durable. Null remote = no push.
   */
  private async pushTransition(vault: VaultLike, remote: string | null): Promise<string | null> {
    if (remote === null) {
      return null;
    }
    const location = await this.locate(vault.path);
    if (location === null) {
      return null;
    }
    try {
      await this.git.push(location.root, remote);
      return null;
    } catch (error) {
      const text = messageOf(error).split('\n')[0] ?? 'push failed';
      this.ctx.log(`git push to "${remote}" failed: ${text}`, 'warn');
      return `git push to "${remote}" failed: ${text}`;
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
      const firstDir = resolvePhaseDir(await this.ticketDirs(vault), 1, firstPhase);
      const path = `tickets/${firstDir}/${id}.md`;
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
      return { ok: true, id, path, ...(warning === null ? {} : { warning }) };
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
      // Prefix-aware path guard (T-0041): the card may sit in `10-inbox`
      // or `inbox` — the stripped phase id is the identity.
      const parts = ticketPathParts(card.path);
      if (parts === null || parts.phase !== input.from || parts.stem !== input.id) {
        return { ok: false, error: `${input.id} sits in an unexpected path (${card.path})` };
      }

      const text = await this.ctx.vault.read(card.path, { vaultId: vault.id });
      // A hand-move never touches the claim (owner ruling, 2026-10-18): a
      // stamp here would block the target column's pool, since the
      // dispatcher never takes claimed cards. Claims belong to the
      // takeover/release menu and to the fleet's own moves.
      let patched: string;
      try {
        patched = patchTicketFile(text, {
          to: input.to,
          from: input.from,
          now: new Date(),
          actor: OWNER,
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }

      const toDir = resolvePhaseDir(
        await this.ticketDirs(vault),
        snap.pipeline.findIndex((p) => p.id === input.to) + 1,
        input.to,
      );
      const newPath = `tickets/${toDir}/${input.id}.md`;
      try {
        const oldAbs = this.ctx.vault.resolveAssetPath(card.path, { vaultId: vault.id });
        const dirAbs = this.ctx.vault.resolveAssetPath(`tickets/${toDir}`, { vaultId: vault.id });
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
      // The optional auto-push (T-0041): warning-level, never a failed move.
      const pushWarning = await this.pushTransition(vault, snap.pushRemote);
      const warnings = [warning, pushWarning].filter((w): w is string => w !== null);
      this.ctx.vault.announceChanges({
        vaultId: vault.id,
        changedPaths: [newPath, ...(orderChanged ? [ORDER_PATH] : [])],
        deletedPaths: [card.path],
      });
      this.announceChanged();
      return {
        ok: true,
        path: newPath,
        ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }),
      };
    });
  }

  /**
   * Archives a ticket (T-0041): the reserved `tickets/archive/` folder
   * beside `_meta` — not a column, invisible on the board. The treatment
   * is exact: Log line `archived`, one commit `tickets: <id> archived`,
   * pin cleanup; NO `entered-` stamp (the Log marker is what makes it
   * idempotent and a revive detectable); claim fields ride along.
   * Reviving is a move back into a phase folder — normalization stamps
   * it as `archive -> <phase>`. Final deletion is the owner's manual
   * act inside `archive/`.
   */
  archive(input: { id: string }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      let card: TicketCard | null = null;
      for (const column of snap.columns) {
        const found = column.tickets.find((t) => t.id === input.id);
        if (found !== undefined) {
          card = found;
          break;
        }
      }
      if (card === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const text = await this.ctx.vault.read(card.path, { vaultId: vault.id });
      let patched: string;
      try {
        patched = patchTicketFile(text, {
          to: 'archive',
          from: null,
          now: new Date(),
          actor: OWNER,
          action: 'archived',
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const newPath = `${TICKETS_ARCHIVE_DIR}/${card.id}.md`;
      try {
        const oldAbs = this.ctx.vault.resolveAssetPath(card.path, { vaultId: vault.id });
        const dirAbs = this.ctx.vault.resolveAssetPath(TICKETS_ARCHIVE_DIR, { vaultId: vault.id });
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
      const orderText = await this.readOptional(vault.id, ORDER_PATH);
      const nextOrder = orderText === null ? null : removeIdFromPins(orderText, card.id);
      const orderChanged = nextOrder !== null && nextOrder !== orderText;
      if (orderChanged) {
        await this.ctx.vault.write(ORDER_PATH, nextOrder as string, { vaultId: vault.id });
      }
      const warning = await this.commit(
        vault,
        [card.path, newPath, ...(orderChanged ? [ORDER_PATH] : [])],
        `tickets: ${card.id} archived`,
      );
      const pushWarning = await this.pushTransition(vault, snap.pushRemote);
      const warnings = [warning, pushWarning].filter((w): w is string => w !== null);
      this.ctx.vault.announceChanges({
        vaultId: vault.id,
        changedPaths: [newPath, ...(orderChanged ? [ORDER_PATH] : [])],
        deletedPaths: [card.path],
      });
      this.announceChanged();
      return {
        ok: true,
        path: newPath,
        ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }),
      };
    });
  }

  /**
   * Unarchives a ticket (T-0042): a move out of `tickets/archive/` back
   * into a phase folder IS the board treatment — `archive -> <phase>`
   * stamp, Log line, one commit — never a raw move plus drift
   * normalization. The drag in Files feels exactly like the board's own
   * move (decision 7). The board itself shows nothing in archive/; the
   * file is read directly.
   */
  unarchive(input: { id: string; to: string }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      const toPhase = snap.pipeline.find((p) => p.id === input.to) ?? null;
      if (toPhase === null) {
        return { ok: false, error: `"${input.to}" is not a phase in the pipeline` };
      }
      const oldPath = `${TICKETS_ARCHIVE_DIR}/${input.id}.md`;
      let text: string;
      try {
        text = await this.ctx.vault.read(oldPath, { vaultId: vault.id });
      } catch {
        return { ok: false, error: `${input.id} is not in the archive` };
      }
      let patched: string;
      try {
        patched = patchTicketFile(text, {
          to: input.to,
          from: 'archive',
          now: new Date(),
          actor: OWNER,
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const toDir = resolvePhaseDir(
        await this.ticketDirs(vault),
        snap.pipeline.findIndex((p) => p.id === input.to) + 1,
        input.to,
      );
      const newPath = `tickets/${toDir}/${input.id}.md`;
      try {
        const oldAbs = this.ctx.vault.resolveAssetPath(oldPath, { vaultId: vault.id });
        const dirAbs = this.ctx.vault.resolveAssetPath(`tickets/${toDir}`, { vaultId: vault.id });
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
      // Pin cleanup only: an archived ticket holds no board place to re-pin.
      const orderText = await this.readOptional(vault.id, ORDER_PATH);
      const nextOrder = orderText === null ? null : removeIdFromPins(orderText, input.id);
      const orderChanged = nextOrder !== null && nextOrder !== orderText;
      if (orderChanged) {
        await this.ctx.vault.write(ORDER_PATH, nextOrder as string, { vaultId: vault.id });
      }
      const warning = await this.commit(
        vault,
        [oldPath, newPath, ...(orderChanged ? [ORDER_PATH] : [])],
        `tickets: ${input.id} archive -> ${input.to}`,
      );
      const pushWarning = await this.pushTransition(vault, snap.pushRemote);
      const warnings = [warning, pushWarning].filter((w): w is string => w !== null);
      this.ctx.vault.announceChanges({
        vaultId: vault.id,
        changedPaths: [newPath, ...(orderChanged ? [ORDER_PATH] : [])],
        deletedPaths: [oldPath],
      });
      this.announceChanged();
      return {
        ok: true,
        path: newPath,
        ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }),
      };
    });
  }

  /**
   * "Remove worktree" (T-0042, Files context command on `_worktrees/<id>`):
   * the pure planner (`planWorktreeRemoval`) decides over the board — a
   * running ticket's worktree is never touched — and `git worktree remove`
   * executes from the repo's main checkout. The vault re-reads afterwards;
   * the worktree folder lives OUTSIDE `tickets/`, so no transition commit
   * belongs to it.
   */
  async removeWorktree(folder: string): Promise<MutationResult> {
    const vault = await this.detect();
    if (vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const snap = await this.snapshot();
    const plan = planWorktreeRemoval({
      folder,
      cards: snap.columns.flatMap((column) => column.tickets),
      repos: snap.repos,
    });
    if (!plan.ok) {
      return { ok: false, error: plan.error };
    }
    const worktreeAbs = this.ctx.vault.resolveAssetPath(folder, { vaultId: vault.id });
    if (worktreeAbs === null) {
      return { ok: false, error: 'the worktree path escapes the vault' };
    }
    try {
      // The repo's `link:` junctions go first (the top-level sweep catches
      // the rest): git's worktree removal leaves them behind, and a
      // leftover folder at the path poisons the next prepare.
      const links = snap.repos.find((r) => r.path === plan.repoPath)?.link ?? [];
      await unlinkShared(worktreeAbs, links);
      await this.git.worktreeRemove(plan.repoPath, worktreeAbs);
    } catch (error) {
      return { ok: false, error: `git worktree remove failed: ${messageOf(error).split('\n')[0]}` };
    }
    this.ctx.vault.announceChanges({ vaultId: vault.id, deletedPaths: [folder] });
    this.announceChanged();
    return { ok: true };
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

  /** Drops a ticket's pin: it falls back to the derived order. */
  unpin(input: { id: string }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const orderText = await this.readOptional(vault.id, ORDER_PATH);
      const nextText = orderText === null ? null : removeIdFromPins(orderText, input.id);
      if (orderText === null || nextText === orderText) {
        return { ok: false, error: `${input.id} is not pinned` };
      }
      try {
        await this.ctx.vault.write(ORDER_PATH, nextText as string, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [ORDER_PATH], `tickets: unpin ${input.id}`);
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

  /**
   * Starts a fleet run for one ticket (M84, ADR-0075): resolve the
   * worker through the shared request builder (ticket pin > column >
   * handover pin > repo default > configured default), read the
   * handover's prompt, and hand the runner the request. The runner owns
   * the worker process and the ticket stamps; this side refuses early
   * with the reason a human can act on.
   */
  startRun(input: {
    ticketId: string;
    workerChoice: string | null;
    permissionMode: PermissionMode;
  }): Promise<{ ok: boolean; error?: string; runId?: string }> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      let card: TicketCard | null = null;
      let phaseId: string | null = null;
      for (const column of snap.columns) {
        const found = column.tickets.find((t) => t.id === input.ticketId);
        if (found !== undefined) {
          card = found;
          phaseId = column.phase.id;
          break;
        }
      }
      if (card === null || phaseId === null) {
        return { ok: false, error: `${input.ticketId} is not on the board` };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: `${card.id} already has a live run — stop it first` };
      }
      const workingPhase = snap.pipeline.find((p) => p.id === phaseId) ?? null;
      const repo =
        card.meta.repo === null ? null : (snap.repos.find((r) => r.name === card!.meta.repo) ?? null);
      const text = await this.ctx.vault.read(card.path, { vaultId: vault.id });
      const promptRef =
        workingPhase === null ? null : columnPromptRef(workingPhase);
      let prompt: string | null = null;
      if (promptRef !== null) {
        prompt = await this.readOptional(vault.id, `tickets/_meta/prompts/${promptRef}.md`);
        if (prompt === null) {
          return {
            ok: false,
            error: `the handover names prompt "${promptRef}", but tickets/_meta/prompts/${promptRef}.md is missing`,
          };
        }
      }
      const nextPhaseId = nextPhaseIdOf(snap.columns, phaseId);
      const nextPhaseClaims =
        nextPhaseId !== null ? (snap.pipeline.find((p) => p.id === nextPhaseId)?.claim === true) : false;
      // The context pack (T-0048): repo instructions, the worktree's diff
      // stat, and the previous run's gate failure on a retry — the file
      // reads stay here, the composer stays pure.
      let repoInstructions: string | null = null;
      let diffStat: string | null = null;
      if (repo !== null && repo.path !== null) {
        repoInstructions = await readRepoInstructions(repo.path);
        diffStat = await worktreeDiffStat(
          this.git,
          worktreePathFor(vault.path, repo, card.id),
          repo.branch,
        );
      }
      const gateFailure = await this.lastGateFailure(card.id);
      const composed = composeRunRequest({
        card,
        ticketText: text,
        vaultPath: vault.path,
        workingPhase,
        nextPhaseId,
        nextPhaseDir:
          nextPhaseId === null
            ? null
            : resolvePhaseDir(
                await this.ticketDirs(vault),
                snap.pipeline.findIndex((p) => p.id === nextPhaseId) + 1,
                nextPhaseId,
              ),
        pushRemote: snap.pushRemote,
        nextPhaseClaims,
        repo,
        promptText: prompt,
        defaultWorker: this.defaultWorker,
        permissionMode: input.permissionMode,
        gitPath: ((await this.ctx.config.get<string>('gitPath')) ?? '').trim(),
        workerChoice: input.workerChoice,
        repoInstructions,
        diffStat,
        gateFailure,
        caps: this.caps,
      });
      if (!composed.ok) {
        return { ok: false, error: composed.error };
      }
      for (const truncation of composed.truncations) {
        this.ctx.log(
          `instruction: ${card.id} ${truncation.section} truncated: true, originalSize ${truncation.originalSize}`,
        );
      }
      const outcome = await this.fleet.start(composed.request);
      if (outcome.ok) {
        this.announceChanged();
        return { ok: true, runId: outcome.run.id };
      }
      return { ok: false, error: outcome.error };
    });
  }

  // --- worktree cleanup (T-0044, ADR-0080) ---------------------------

  /** Every fleet run record (live or historical) the client can see. */
  private async fleetRecords(): Promise<readonly RunInfo[]> {
    return this.fleet.runs();
  }

  /**
   * The newest record for a ticket that names a worktree, or null.
   * Historical records settle on disk, so this survives a down runner.
   */
  private newestRecordFor(runs: readonly RunInfo[], ticketId: string): RunInfo | null {
    const found = runs
      .filter((r) => r.ticketId === ticketId && r.worktreePath.trim() !== '')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return found[0] ?? null;
  }

  /**
   * Liveness is the ticket's `run:` stamp ∪ non-terminal fleet records
   * (ADR-0080): never fleet status alone — `readHistory` marks a
   * still-live run `stopped` when the runner is down, and the stamps
   * are the persisted truth. A `detached` worker may still be running:
   * it counts as live.
   */
  private async liveWorktreePaths(vault: VaultLike, snap: BoardSnapshot): Promise<string[]> {
    const runs = await this.fleetRecords();
    const live = new Set<string>();
    for (const run of runs) {
      if (!['done', 'stopped', 'failed'].includes(run.state) && run.worktreePath.trim() !== '') {
        live.add(run.worktreePath);
      }
    }
    for (const column of snap.columns) {
      for (const card of column.tickets) {
        if (card.meta.run === null) {
          continue;
        }
        const record = this.newestRecordFor(runs, card.id);
        const repo =
          card.meta.repo === null ? null : snap.repos.find((r) => r.name === card.meta.repo) ?? null;
        if (repo !== null && repo.path !== null) {
          // The record's path first (it may predate the home rule);
          // the computed path covers a stamp without a record.
          live.add(record !== null ? record.worktreePath : worktreePathFor(vault.path, repo, card.id));
        }
      }
    }
    return [...live];
  }

  /**
   * The card menu's "Remove worktree" (T-0044): `git worktree remove`
   * through `worktree-clean`, the branch stays (it carries the work).
   * A dirty tree refuses unless `force` (the renderer's armed second
   * click); a live run refuses outright. The Log line + one commit are
   * the board's own single-writer treatment.
   */
  removeWorktreeForTicket(input: { id: string; force: boolean }): Promise<
    | { readonly ok: true; readonly warning?: string }
    | { readonly ok: false; readonly error: string; readonly dirty?: boolean; readonly status?: string }
  > {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      let card: TicketCard | null = null;
      for (const column of snap.columns) {
        const found = column.tickets.find((t) => t.id === input.id);
        if (found !== undefined) {
          card = found;
          break;
        }
      }
      if (card === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      if (card.meta.repo === null) {
        return { ok: false, error: `${card.id} names no repository — there is no worktree` };
      }
      const repo = snap.repos.find((r) => r.name === card.meta.repo) ?? null;
      if (repo === null || repo.path === null) {
        return { ok: false, error: `"${card.meta.repo}" has no local path in _meta/repos.md` };
      }
      const runs = await this.fleetRecords();
      const liveRecord = runs.some(
        (r) => r.ticketId === card.id && !['done', 'stopped', 'failed'].includes(r.state),
      );
      if (card.meta.run !== null || liveRecord) {
        return { ok: false, error: `${card.id} has a live run — stop it before removing its worktree` };
      }
      const record = this.newestRecordFor(runs, card.id);
      const worktreePath = record !== null ? record.worktreePath : worktreePathFor(vault.path, repo, card.id);

      const outcome = await removeWorktree(this.git, repo.path, worktreePath, { force: input.force, links: repo.link });
      if (!outcome.ok) {
        if (outcome.dirty === true) {
          return {
            ok: false,
            error: `the worktree is dirty — confirm to remove it anyway`,
            dirty: true,
            status: outcome.status,
          };
        }
        return { ok: false, error: outcome.error };
      }

      // The owner's button: one action-only Log line, one commit.
      const text = await this.ctx.vault.read(card.path, { vaultId: vault.id });
      let warning: string | null = null;
      try {
        const patched = patchTicketFile(text, {
          to: card.phase,
          from: null,
          now: new Date(),
          actor: OWNER,
          action: `worktree removed (${worktreePath})`,
        });
        await this.ctx.vault.write(card.path, patched, { vaultId: vault.id });
        warning = await this.commit(vault, [card.path], `tickets: ${card.id} worktree removed`);
        this.ctx.vault.announceChanges({ vaultId: vault.id, changedPaths: [card.path] });
      } catch (error) {
        warning = `the worktree was removed, but the Log line failed: ${messageOf(error)}`;
      }
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The "Clean up worktrees" control (T-0044): every fleet worktree
   * whose ticket has no live run is removed (real git, dirty trees
   * kept and reported), then every mapped repo gets one
   * `git worktree prune`. Plugin-side by design (ADR-0080): the plugin
   * holds repos.md, the run history and the stamps, and cleanup usually
   * happens with the runner down.
   */
  async worktreeCleanup(): Promise<{ ok: boolean; report?: CleanupReport; error?: string }> {
    const vault = await this.detect();
    if (vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const snap = await this.snapshot();
    const protectedPaths = await this.liveWorktreePaths(vault, snap);
    const report = await cleanWorktrees(this.git, {
      repos: snap.repos,
      vaultPath: vault.path,
      fleetRoot: this.fleetRoot,
      protectedPaths,
    });
    this.ctx.log(
      `worktree cleanup: ${report.removed.length} removed, ${report.keptDirty.length} kept dirty` +
        (report.failed.length > 0 ? `, ${report.failed.length} failed` : '') +
        `, pruned ${report.prunedRepos.length} repo(s)`,
    );
    return { ok: true, report };
  }

  /**
   * The boot sweep (T-0044, ADR-0080): the legacy-base migration (every
   * boot until the legacy root is empty — live runs keep theirs until
   * they settle, clean trees go, dirty ones stay and are reported),
   * the .gitignore ensure, and the orphan listing for the status note.
   */
  worktreeBootSweep(): Promise<void> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return;
      }
      await this.ensureWorktreesIgnored(vault);
      const snap = await this.snapshot();
      const protectedPaths = await this.liveWorktreePaths(vault, snap);
      const report = await cleanWorktrees(this.git, {
        repos: snap.repos,
        vaultPath: vault.path,
        fleetRoot: this.fleetRoot,
        protectedPaths,
        legacyOnly: true,
      });
      const runs = await this.fleetRecords();
      const bases = snap.repos.filter((r) => r.path !== null).map((r) => worktreeBaseFor(vault.path, r));
      const known = [
        ...runs.map((r) => r.worktreePath).filter((p) => p.trim() !== ''),
        ...protectedPaths,
      ];
      const orphans = await listOrphans(bases, known);
      const leftovers = await fsp
        .readdir(legacyWorktreeBase(this.fleetRoot), { withFileTypes: true })
        .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
        .catch(() => [] as string[]);
      if (
        report.removed.length > 0 ||
        report.keptDirty.length > 0 ||
        report.failed.length > 0 ||
        orphans.length > 0 ||
        leftovers.length > 0
      ) {
        this.ctx.log(
          `worktree boot sweep: migrated ${report.removed.length}, kept dirty ${report.keptDirty.length}` +
            `, orphans ${orphans.length}, legacy leftovers ${leftovers.length}` +
            (report.failed.length > 0 ? `, failed ${report.failed.length}` : ''),
        );
      }
    });
  }

  /** The status note under the board (T-0044): where worktrees live,
   *  which folders are orphans, what still sits in the legacy root. */
  async worktreesStatus(): Promise<{
    base: string | null;
    orphans: readonly string[];
    legacyLeftovers: readonly string[];
  }> {
    const vault = await this.detect();
    if (vault === null) {
      return { base: null, orphans: [], legacyLeftovers: [] };
    }
    const snap = await this.snapshot();
    const runs = await this.fleetRecords();
    const bases = snap.repos.filter((r) => r.path !== null).map((r) => worktreeBaseFor(vault.path, r));
    const known = runs.map((r) => r.worktreePath).filter((p) => p.trim() !== '');
    const orphans = await listOrphans(bases, known);
    const legacyLeftovers = await fsp
      .readdir(legacyWorktreeBase(this.fleetRoot), { withFileTypes: true })
      .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
      .catch(() => [] as string[]);
    return {
      // The default base — a repo with a `worktrees:` override has its own.
      base: path.join(vault.path, WORKTREES_DIR),
      orphans,
      legacyLeftovers,
    };
  }

  /**
   * The repo's .gitignore covers the worktrees base (ADR-0080: ensured,
   * not documented — drifts on new boards otherwise). One commit when
   * it changes; never fails the caller.
   */
  private async ensureWorktreesIgnored(vault: VaultLike): Promise<void> {
    const location = await this.locate(vault.path);
    if (location === null) {
      return; // not a git repo — nothing to ignore in
    }
    const entry = `/${location.prefix}_worktrees/`;
    const gitignore = path.join(location.root, '.gitignore');
    const current = await fsp.readFile(gitignore, 'utf8').catch(() => null);
    if (current !== null && current.split('\n').some((line) => line.trim() === entry)) {
      return;
    }
    const lead = current === null || current === '' ? '' : current.endsWith('\n') ? '' : '\n';
    try {
      await fsp.writeFile(gitignore, `${current ?? ''}${lead}${entry}\n`, 'utf8');
      await this.git.commitPaths(location.root, ['.gitignore'], 'tickets: ignore the worktrees base');
    } catch (error) {
      this.ctx.log(`ignoring the worktrees base failed: ${messageOf(error)}`, 'warn');
    }
  }

  /**
   * The ticket's most recent failed run's gate failure, or null (T-0048):
   * what a retry's instruction carries. The runs snapshot is the truth —
   * live from the runner, history from disk when it is down.
   */
  private async lastGateFailure(ticketId: string): Promise<string | null> {
    const runs = await this.fleet.runs().catch(() => [] as readonly RunInfo[]);
    const failed = runs
      .filter((r) => r.ticketId === ticketId && r.state === 'failed' && r.gateFailure !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return failed?.gateFailure ?? null;
  }

  /**
   * Writes one phase's pool keys in `_meta/pipeline.md` (M85, the
   * settings dialog's writer): setting a worker writes the matching
   * `agent <prompt-ref>` handover, clearing it writes `manual`. One
   * commit per change (`tickets: columns <phase> <what>`).
   */
  setColumnConfig(input: {
    phase: string;
    worker?: string | null;
    model?: string | null;
    prompt?: string | null;
  }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const text = await this.readOptional(vault.id, PIPELINE_PATH);
      if (text === null) {
        return { ok: false, error: 'tickets/_meta/pipeline.md is missing' };
      }
      if (
        input.worker === undefined &&
        input.model === undefined &&
        input.prompt === undefined
      ) {
        return { ok: true }; // nothing to change (e.g. the handover-pin display state)
      }
      if (input.worker !== undefined) {
        const worker = input.worker?.trim() ?? '';
        if (worker !== '' && worker !== 'opencode' && worker !== 'claude-code') {
          return { ok: false, error: 'the worker is "opencode" or "claude-code"' };
        }
      }
      let patched: string;
      try {
        patched = patchPipelinePhase(text, input.phase, {
          ...(input.worker !== undefined ? { worker: input.worker } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        await this.ctx.vault.write(PIPELINE_PATH, patched, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const what: string[] = [];
      if (input.worker !== undefined) {
        what.push(input.worker === null || input.worker.trim() === '' ? 'manual' : `worker ${input.worker.trim()}`);
      }
      if (input.model !== undefined) {
        what.push(`model ${input.model === null || input.model.trim() === '' ? '(none)' : input.model.trim()}`);
      }
      if (input.prompt !== undefined) {
        what.push(`prompt ${input.prompt === null || input.prompt.trim() === '' ? '(default)' : input.prompt.trim()}`);
      }
      const warning = await this.commit(vault, [PIPELINE_PATH], `tickets: columns ${input.phase} ${what.join(', ')}`);
      this.ctx.vault.announceChanges({ vaultId: vault.id, changedPaths: [PIPELINE_PATH] });
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The prompt files under `_meta/prompts/`, exactly as they are on disk
   * (req-50: the settings page shows nothing else — no rows for shipped
   * prompts the vault lacks, no comparison with code). `shipped` marks a
   * name Drey ships a file for, where "Reset to the shipped version" means
   * something. `folder` is the absolute folder for display and "Open".
   */
  async listPrompts(): Promise<PromptListing> {
    const vault = await this.detect();
    if (vault === null) {
      return { folder: null, entries: [], shipped: [] };
    }
    const shipped = await loadShippedPrompts();
    const dir = this.ctx.vault.resolveAssetPath(PROMPTS_DIR, { vaultId: vault.id });
    if (dir === null) {
      return { folder: null, entries: [], shipped: [...shipped.keys()] };
    }
    const names = (await fsp.readdir(dir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.md') && PROMPT_REF.test(n.slice(0, -3)))
      .sort();
    const entries: PromptEntry[] = [];
    for (const name of names) {
      const ref = name.slice(0, -3);
      const text = await this.readOptional(vault.id, `${PROMPTS_DIR}/${name}`);
      if (text !== null) {
        entries.push({ ref, text, shipped: shipped.has(ref) });
      }
    }
    return { folder: dir, entries, shipped: [...shipped.keys()] };
  }

  /** Writes one prompt file (create, replace or reset to the shipped file); one commit per save. */
  savePrompt(input: { ref: string; text?: string; reset?: boolean }): Promise<MutationResult> {
    return this.enqueue(async () => {
      if (!PROMPT_REF.test(input.ref)) {
        return { ok: false, error: 'a prompt name is letters, digits, dot, dash and underscore' };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const file = `${PROMPTS_DIR}/${input.ref}.md`;
      let text = input.text ?? '';
      if (input.reset === true) {
        const shipped = (await loadShippedPrompts()).get(input.ref);
        if (shipped === undefined) {
          return { ok: false, error: `Drey ships no prompt "${input.ref}"` };
        }
        text = shipped;
      }
      const before = await this.readOptional(vault.id, file);
      if (before === text) {
        return { ok: true };
      }
      try {
        await this.ctx.vault.write(file, text, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const verb = input.reset === true ? 'reset' : before === null ? 'add' : 'edit';
      const warning = await this.commit(vault, [file], `tickets: prompt ${input.ref} ${verb}`);
      this.ctx.vault.announceChanges({ vaultId: vault.id, changedPaths: [file] });
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /** Adds the shipped prompts the vault lacks (never overwrites one); one commit. */
  restoreShippedPrompts(): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const added: string[] = [];
      try {
        for (const [ref, text] of await loadShippedPrompts()) {
          const file = `${PROMPTS_DIR}/${ref}.md`;
          if ((await this.readOptional(vault.id, file)) === null) {
            await this.ctx.vault.write(file, text, { vaultId: vault.id });
            added.push(file);
          }
        }
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      if (added.length === 0) {
        return { ok: true };
      }
      const warning = await this.commit(vault, added, 'tickets: prompts add the shipped defaults');
      this.ctx.vault.announceChanges({ vaultId: vault.id, changedPaths: added });
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /** Opens `_meta/prompts/` (or the tickets folder) in the OS file manager. */
  async openTicketsFolder(which: 'tickets' | 'prompts'): Promise<MutationResult> {
    const vault = await this.detect();
    if (vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const dir = this.ctx.vault.resolveAssetPath(which === 'prompts' ? PROMPTS_DIR : 'tickets', { vaultId: vault.id });
    if (dir === null) {
      return { ok: false, error: 'the folder is outside the vault' };
    }
    await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
    const failure = await shell.openPath(dir);
    return failure === '' ? { ok: true } : { ok: false, error: failure };
  }

  /**
   * Whether the phase folders carry their derived numbers (T-0041), and
   * the renames "Number folders" would make. Also names the tickets
   * folder for the settings page's header.
   */
  async folderStatus(): Promise<FolderStatus> {
    const vault = await this.detect();
    if (vault === null) {
      return { root: null, moves: [] };
    }
    const snap = await this.snapshot();
    const root = this.ctx.vault.resolveAssetPath('tickets', { vaultId: vault.id });
    return {
      root,
      moves: planFolderNumbering(await this.ticketDirs(vault), snap.pipeline.map((p) => p.id)),
    };
  }

  /** "Number folders": the renumbering alone, one commit (req-50). */
  numberFolders(): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      return this.renumber(vault, snap, snap.pipeline.map((p) => p.id), null, 'tickets: number phase folders');
    });
  }

  /**
   * The settings page's sortable columns (req-50): pipeline.md takes the
   * new order and the phase folders their new numbers — one commit.
   * Refused while a ticket in a renamed folder has a live run (the
   * runner holds its path).
   */
  reorderPhases(order: readonly string[]): Promise<MutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const text = await this.readOptional(vault.id, PIPELINE_PATH);
      if (text === null) {
        return { ok: false, error: 'tickets/_meta/pipeline.md is missing' };
      }
      let reordered: string;
      try {
        reordered = reorderPipelinePhases(text, order);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      if (reordered === text) {
        return { ok: true };
      }
      const snap = await this.snapshot();
      return this.renumber(vault, snap, order, reordered, `tickets: reorder phases ${order.join(' ')}`);
    });
  }

  /** The shared body of reorder and "Number folders"; runs inside the queue. */
  private async renumber(
    vault: VaultLike,
    snap: BoardSnapshot,
    order: readonly string[],
    pipelineText: string | null,
    message: string,
  ): Promise<MutationResult> {
    const root = this.ctx.vault.resolveAssetPath('tickets', { vaultId: vault.id });
    if (root === null) {
      return { ok: false, error: 'the tickets folder is outside the vault' };
    }
    const moves = planFolderNumbering(await this.ticketDirs(vault), order);
    const moved = new Set(moves.map((m) => m.from));
    const busy = snap.columns
      .flatMap((c) => c.tickets)
      .filter((t) => t.meta.run !== null && moved.has(t.path.split('/')[1] ?? ''));
    if (busy.length > 0) {
      return {
        ok: false,
        error: `${busy.map((t) => t.id).join(', ')} ${busy.length === 1 ? 'has a live run' : 'have live runs'} — stop ${busy.length === 1 ? 'it' : 'them'} or wait, then try again`,
      };
    }
    if (moves.length === 0 && pipelineText === null) {
      return { ok: true };
    }
    let touched: string[];
    try {
      touched = await applyFolderNumbering(root, moves);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    if (pipelineText !== null) {
      try {
        await this.ctx.vault.write(PIPELINE_PATH, pipelineText, { vaultId: vault.id });
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
    }
    const paths = [...touched.map((dir) => `tickets/${dir}`), ...(pipelineText !== null ? [PIPELINE_PATH] : [])];
    const location = await this.locate(vault.path);
    let warning: string | null = null;
    if (location === null) {
      warning = 'the tickets vault is not a git repository — the change is not versioned';
    } else {
      try {
        await this.git.commitTree(location.root, paths.map((p) => `${location.prefix}${p}`), message);
      } catch (error) {
        warning = `git commit failed: ${messageOf(error).split('\n')[0]}`;
        this.ctx.log(warning, 'warn');
      }
    }
    this.ctx.vault.announceChanges({ vaultId: vault.id, changedPaths: paths });
    this.announceChanged();
    return {
      ok: true,
      moved: moves.length,
      ...(warning === null ? {} : { warning }),
    };
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
      const shipped = await loadShippedPrompts();
      const promptPaths = [...shipped.keys()].map((ref) => `${PROMPTS_DIR}/${ref}.md`);
      try {
        await this.ctx.vault.write(PIPELINE_PATH, DEFAULT_PIPELINE, { vaultId: target.id });
        await this.ctx.vault.write(ORDER_PATH, DEFAULT_ORDER, { vaultId: target.id });
        await this.ctx.vault.write(REPOS_PATH, DEFAULT_REPOS, { vaultId: target.id });
        for (const [ref, text] of shipped) {
          await this.ctx.vault.write(`${PROMPTS_DIR}/${ref}.md`, text, { vaultId: target.id });
        }
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      // The worktrees base is ignored from day one (ADR-0080: ensured,
      // not documented — one own commit when it changes something).
      await this.ensureWorktreesIgnored(target);
      const warning = await this.commit(
        target,
        [PIPELINE_PATH, ORDER_PATH, REPOS_PATH, ...promptPaths],
        'tickets: initialize board',
      );
      this.ctx.vault.announceChanges({
        vaultId: target.id,
        changedPaths: [PIPELINE_PATH, ORDER_PATH, REPOS_PATH, ...promptPaths],
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    const gitPath = ((await ctx.config.get<string>('gitPath')) ?? '').trim();
    const git = new TicketsGit(() => (gitPath === '' ? 'git' : gitPath));
    const defaultWorker = ((await ctx.config.get<string>('defaultWorker')) ?? '').trim() || 'opencode';
    const autoPermissionMode: PermissionMode =
      (await ctx.config.get<string>('autoPermissionMode')) === 'bypass' ? 'bypass' : 'accept-edits';
    const fleet = new FleetClient({
      root: path.join(ctx.app.userRoot, 'fleet'),
      runnerScript: path.join(__dirname, 'fleet', 'runner.js'),
      log: ctx.log,
      onFleetChanged: (fleetSnapshot) => ctx.ipc.emit('fleet-changed', fleetSnapshot),
    });
    fleet.startPolling();
    const fleetRoot = path.join(ctx.app.userRoot, 'fleet');
    // The instruction output caps (T-0048): flat dotted keys in the
    // plugin config, opaque strings to the store — read once, applied on
    // restart like every fleet setting here.
    const capConfig: Record<string, unknown> = {};
    for (const key of ['gateFailureLines', 'gateFailureBytes', 'diffStatLines', 'diffStatBytes']) {
      const value = await ctx.config.get<number>(`fleet.cap.${key}`);
      if (value !== undefined) {
        capConfig[key] = value;
      }
    }
    const caps = normalizeFleetCaps(capConfig);
    // The provider pools (req-61): `fleet.pool.<provider>.size` / `.probe`.
    const poolConfig: Record<string, { size?: number; probeUrl?: string }> = {};
    for (const provider of WORKER_PROVIDERS) {
      const size = await ctx.config.get<number>(`fleet.pool.${provider}.size`);
      const probeUrl = await ctx.config.get<string>(`fleet.pool.${provider}.probe`);
      poolConfig[provider] = {
        ...(size !== undefined ? { size } : {}),
        ...(probeUrl !== undefined ? { probeUrl } : {}),
      };
    }
    const pools = normalizeFleetPools(poolConfig);
    const board = new BoardService(ctx, git, defaultWorker, autoPermissionMode, gitPath, fleet, fleetRoot, caps, pools);

    ctx.ipc.handle('board', () => board.refresh());

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

    ctx.ipc.handle('unpin', async (payload) => {
      const p = payload as { id?: unknown };
      if (typeof p.id !== 'string') {
        return { ok: false, error: 'bad unpin payload' };
      }
      return board.unpin({ id: p.id });
    });

    ctx.ipc.handle('claim', async (payload) => {
      const p = payload as { id?: unknown; mode?: unknown };
      if (typeof p.id !== 'string' || (p.mode !== 'takeover' && p.mode !== 'release')) {
        return { ok: false, error: 'bad claim payload' };
      }
      return board.setClaim({ id: p.id, mode: p.mode });
    });

    // The settings dialog's writer: one phase's pool keys, one commit (M85).
    ctx.ipc.handle('columns', async (payload) => {
      const p = payload as {
        phase?: unknown;
        worker?: unknown;
        model?: unknown;
        prompt?: unknown;
      };
      if (typeof p.phase !== 'string' || p.phase.trim() === '') {
        return { ok: false, error: 'bad columns payload' };
      }
      return board.setColumnConfig({
        phase: p.phase,
        ...(p.worker !== undefined ? { worker: typeof p.worker === 'string' ? p.worker : null } : {}),
        ...(p.model !== undefined ? { model: typeof p.model === 'string' ? p.model : null } : {}),
        ...(p.prompt !== undefined ? { prompt: typeof p.prompt === 'string' ? p.prompt : null } : {}),
      });
    });

    // The prompts the columns name, editable from the settings page (req-46).
    ctx.ipc.handle('prompts', () => board.listPrompts());
    ctx.ipc.handle('promptSave', async (payload) => {
      const p = payload as { ref?: unknown; text?: unknown; reset?: unknown };
      if (typeof p.ref !== 'string') {
        return { ok: false, error: 'bad prompt payload' };
      }
      if (p.reset !== true && typeof p.text !== 'string') {
        return { ok: false, error: 'bad prompt payload' };
      }
      return board.savePrompt({
        ref: p.ref,
        ...(typeof p.text === 'string' ? { text: p.text } : {}),
        ...(p.reset === true ? { reset: true } : {}),
      });
    });
    ctx.ipc.handle('promptRestore', () => board.restoreShippedPrompts());
    ctx.ipc.handle('openFolder', async (payload) => {
      const p = payload as { which?: unknown };
      return board.openTicketsFolder(p.which === 'prompts' ? 'prompts' : 'tickets');
    });

    // Sortable columns and the folder numbering (req-50).
    ctx.ipc.handle('folders', () => board.folderStatus());
    ctx.ipc.handle('numberFolders', () => board.numberFolders());
    ctx.ipc.handle('reorderPhases', async (payload) => {
      const p = payload as { order?: unknown };
      if (!Array.isArray(p.order) || !p.order.every((id): id is string => typeof id === 'string')) {
        return { ok: false, error: 'bad reorder payload' };
      }
      return board.reorderPhases(p.order);
    });

    // The model picker's list: what the worker CLI offers (req-46).
    ctx.ipc.handle('models', async (payload) => {
      const p = payload as { worker?: unknown };
      return listWorkerModels(typeof p.worker === 'string' ? p.worker : defaultWorker);
    });

    ctx.ipc.handle('archive', async (payload) => {
      const p = payload as { id?: unknown };
      if (typeof p.id !== 'string') {
        return { ok: false, error: 'bad archive payload' };
      }
      return board.archive({ id: p.id });
    });

    // T-0042: a move out of tickets/archive/ performed as the board
    // treatment (archive -> <phase> stamp, Log, one commit).
    ctx.ipc.handle('unarchive', async (payload) => {
      const p = payload as { id?: unknown; to?: unknown };
      if (typeof p.id !== 'string' || typeof p.to !== 'string') {
        return { ok: false, error: 'bad unarchive payload' };
      }
      return board.unarchive({ id: p.id, to: p.to });
    });

    // T-0042: "Remove worktree" on _worktrees/<id> (dormant until T-0044
    // creates the folder): the pure planner decides, git executes.
    ctx.ipc.handle('removeWorktree', async (payload) => {
      const p = payload as { folder?: unknown };
      const folder = typeof p.folder === 'string' ? p.folder.trim() : '';
      if (folder === '') {
        return { ok: false, error: 'bad removeWorktree payload' };
      }
      return board.removeWorktree(folder);
    });

    // --- the fleet (M84, ADR-0075) -------------------------------------
    ctx.ipc.handle('fleetStatus', async () => ({
      runs: await fleet.runs(),
      chain: await fleet.chainStatus(),
    }));

    ctx.ipc.handle('fleetStart', async (payload) => {
      const p = payload as { id?: unknown; worker?: unknown; permissionMode?: unknown };
      if (typeof p.id !== 'string') {
        return { ok: false, error: 'bad fleet start payload' };
      }
      return board.startRun({
        ticketId: p.id,
        workerChoice: typeof p.worker === 'string' && p.worker.trim() !== '' ? p.worker.trim() : null,
        permissionMode: p.permissionMode === 'bypass' ? 'bypass' : 'accept-edits',
      });
    });

    ctx.ipc.handle('fleetStop', async (payload) => {
      const p = payload as { runId?: unknown; reason?: unknown };
      if (typeof p.runId !== 'string') {
        return { ok: false, error: 'bad fleet stop payload' };
      }
      return fleet.stop(
        p.runId,
        typeof p.reason === 'string' && p.reason.trim() !== '' ? p.reason.trim() : null,
      );
    });

    ctx.ipc.handle('fleetSend', async (payload) => {
      const p = payload as { runId?: unknown; text?: unknown };
      if (typeof p.runId !== 'string' || typeof p.text !== 'string' || p.text.trim() === '') {
        return { ok: false, error: 'bad fleet send payload' };
      }
      return fleet.send(p.runId, p.text.trim());
    });

    ctx.ipc.handle('fleetAttach', async (payload) => {
      const p = payload as { runId?: unknown; name?: unknown; data?: unknown };
      if (typeof p.runId !== 'string' || typeof p.name !== 'string' || typeof p.data !== 'string') {
        return { ok: false, error: 'bad fleet attach payload' };
      }
      return fleet.attach(p.runId, p.name, p.data);
    });

    ctx.ipc.handle('fleetControl', async (payload) => {
      const p = payload as { action?: unknown; runId?: unknown };
      if (
        typeof p.runId !== 'string' ||
        (p.action !== 'takeover' && p.action !== 'interrupt' && p.action !== 'release' && p.action !== 'resume')
      ) {
        return { ok: false, error: 'bad fleet control payload' };
      }
      return fleet.control(p.action, p.runId);
    });

    ctx.ipc.handle('fleetStream', async (payload) => {
      const p = payload as { runId?: unknown };
      if (typeof p.runId !== 'string') {
        return { text: '' };
      }
      return { text: (await fleet.stream(p.runId)) ?? '' };
    });

    ctx.ipc.handle('fleetLog', async () => ({ text: (await fleet.log()) ?? '' }));

    // --- worktree cleanup (T-0044, ADR-0080) --------------------------
    // Everything through real git (worktree remove/prune); the branch
    // stays. The boot sweep migrates the legacy base, ensures the
    // .gitignore entry and lists orphans (never auto-deletes them).
    ctx.ipc.handle('worktreeRemove', async (payload) => {
      const p = payload as { id?: unknown; force?: unknown };
      if (typeof p.id !== 'string') {
        return { ok: false, error: 'bad worktree remove payload' };
      }
      return board.removeWorktreeForTicket({ id: p.id, force: p.force === true });
    });

    ctx.ipc.handle('worktreesCleanup', async () => board.worktreeCleanup());

    ctx.ipc.handle('worktreesStatus', async () => board.worktreesStatus());

    void board.worktreeBootSweep();

    // --- the chain (M85, ADR-0077) -------------------------------------
    ctx.ipc.handle('chainStatus', async () => fleet.chainStatus());

    ctx.ipc.handle('chainMaster', async (payload) => {
      const p = payload as { mode?: unknown };
      if (p.mode !== 'run' && p.mode !== 'halted') {
        return { ok: false, error: 'the master mode is "run" or "halted"' };
      }
      const status = await fleet.setMaster(p.mode);
      return status === null ? { ok: false, error: 'the fleet runner is not running' } : { ok: true, status };
    });

    ctx.ipc.handle('chainColumn', async (payload) => {
      const p = payload as { phase?: unknown; mode?: unknown };
      if (typeof p.phase !== 'string' || (p.mode !== 'playing' && p.mode !== 'held')) {
        return { ok: false, error: 'bad chain column payload' };
      }
      const status = await fleet.setColumn(p.phase, p.mode);
      return status === null ? { ok: false, error: 'the fleet runner is not running' } : { ok: true, status };
    });

    ctx.ipc.handle('chainColumnStop', async (payload) => {
      const p = payload as { phase?: unknown };
      if (typeof p.phase !== 'string') {
        return { ok: false, error: 'bad chain column payload' };
      }
      const status = await fleet.stopColumn(p.phase);
      return status === null ? { ok: false, error: 'the fleet runner is not running' } : { ok: true, status };
    });

    ctx.ipc.handle('chainAbort', async () => {
      const status = await fleet.abortAll();
      return status === null ? { ok: false, error: 'the fleet runner is not running' } : { ok: true, status };
    });

    // T-0004: open the ticket's work checkout in the OS terminal — the
    // directory where `.\dev.ps1` (or the repo's own build) runs.
    ctx.ipc.handle('openRepoFolder', async (payload) => {
      const p = payload as { repo?: unknown };
      if (typeof p.repo !== 'string' || p.repo.trim() === '') {
        return { ok: false, error: 'this ticket names no repository' };
      }
      const snap = await board.snapshot();
      const repo = snap.repos.find((r) => r.name === p.repo) ?? null;
      if (repo === null) {
        return { ok: false, error: `"${p.repo}" is not in _meta/repos.md` };
      }
      if (repo.path === null) {
        return {
          ok: false,
          error: `"${repo.name}" has no local path in _meta/repos.md — add a "path:" entry`,
        };
      }
      try {
        await openTerminalAt(repo.path);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    });

    ctx.ipc.handle('initialize', async (payload) => {
      const p = payload as { vaultId?: unknown };
      return board.initialize(typeof p.vaultId === 'string' ? p.vaultId : null);
    });

    // The fleet's MCP tools (M85, SDK 1.29): the assistant and any
    // program on Drey's MCP server can drive runs conversationally.
    ctx.mcp.registerTools(
      createFleetMcpTools({
        status: async () => ({
          runs: await fleet.runs(),
          chain: await fleet.chainStatus(),
        }),
        run: (input) =>
          board.startRun({
            ticketId: input.ticketId,
            workerChoice: input.worker,
            permissionMode: input.permissionMode,
          }),
        stop: (runId) => fleet.stop(runId, null),
        steer: (runId, text) => fleet.send(runId, text),
        watch: (runId) => fleet.stream(runId),
      }),
    );

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
