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
import * as path from 'node:path';
import type {
  MainPluginContext,
  MainPluginModule,
  VaultChangeEvent,
} from '../../../shared/plugin-api';
import {
  nextTicketId,
  type BoardSnapshot,
  type PipelinePhase,
  type TicketCard,
  type TicketPriority,
  TICKET_PRIORITIES,
} from '../shared/tickets';
import {
  assembleBoard,
  orderAfterInsert,
  parseOrderFile,
  patchPipelinePhase,
  pinsAfterDrop,
  rewriteOrderSection,
} from './ticket-board';
import {
  newTicketFileText,
  patchTicketFile,
} from './ticket-files';
import { openTerminalAt } from './open-terminal';
import { TicketsGit, type RepoLocation } from './tickets-git';
import { createFleetMcpTools } from './mcp-tools';
import { FleetClient } from './fleet-client';
import { agentIdentity, composeRunRequest } from './fleet/request';
import { checkpointPhaseIds, columnPromptRef, isAutoPhase, nextPhaseIdOf } from './fleet/chain';
import type { ChainConfig, PermissionMode } from './fleet/protocol';

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
  private lastChainConfig: string | null = null;

  constructor(
    private readonly ctx: MainPluginContext,
    private readonly git: TicketsGit,
    private readonly defaultWorker: string,
    private readonly autoPermissionMode: PermissionMode,
    private readonly gitPath: string,
    private readonly fleet: FleetClient,
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
      const composed = composeRunRequest({
        card,
        ticketText: text,
        vaultPath: vault.path,
        workingPhase,
        nextPhaseId,
        nextPhaseClaims,
        repo,
        promptText: prompt,
        defaultWorker: this.defaultWorker,
        permissionMode: input.permissionMode,
        gitPath: ((await this.ctx.config.get<string>('gitPath')) ?? '').trim(),
        workerChoice: input.workerChoice,
      });
      if (!composed.ok) {
        return { ok: false, error: composed.error };
      }
      const outcome = await this.fleet.start(composed.request);
      if (outcome.ok) {
        this.announceChanged();
        return { ok: true, runId: outcome.run.id };
      }
      return { ok: false, error: outcome.error };
    });
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
    workers?: number | null;
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
        input.workers === undefined &&
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
          ...(input.workers !== undefined ? { workers: input.workers } : {}),
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
      if (input.workers !== undefined) {
        what.push(`workers ${input.workers ?? '(default)'}`);
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
    const defaultWorker = ((await ctx.config.get<string>('defaultWorker')) ?? '').trim() || 'opencode';
    const autoPermissionMode: PermissionMode =
      (await ctx.config.get<string>('autoPermissionMode')) === 'bypass' ? 'bypass' : 'accept-edits';
    const fleet = new FleetClient({
      root: path.join(ctx.app.userRoot, 'fleet'),
      runnerScript: path.join(__dirname, 'fleet', 'runner.js'),
      log: ctx.log,
      onFleetChanged: (fleetSnapshot) => ctx.ipc.emit('fleet-changed', fleetSnapshot),
    });
    const board = new BoardService(ctx, git, defaultWorker, autoPermissionMode, gitPath, fleet);

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
        workers?: unknown;
        prompt?: unknown;
      };
      if (typeof p.phase !== 'string' || p.phase.trim() === '') {
        return { ok: false, error: 'bad columns payload' };
      }
      return board.setColumnConfig({
        phase: p.phase,
        ...(p.worker !== undefined ? { worker: typeof p.worker === 'string' ? p.worker : null } : {}),
        ...(p.model !== undefined ? { model: typeof p.model === 'string' ? p.model : null } : {}),
        ...(p.workers !== undefined
          ? { workers: typeof p.workers === 'number' ? Math.floor(p.workers) : null }
          : {}),
        ...(p.prompt !== undefined ? { prompt: typeof p.prompt === 'string' ? p.prompt : null } : {}),
      });
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

    ctx.ipc.handle('fleetStream', async (payload) => {
      const p = payload as { runId?: unknown };
      if (typeof p.runId !== 'string') {
        return { text: '' };
      }
      return { text: (await fleet.stream(p.runId)) ?? '' };
    });

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
        run: (input) => board.startRun(input),
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
