/**
 * The tickets board service (ADR-0076 milestone 83; host-agnostic since
 * ADR-0088 E2a). Detects the tickets vault, assembles snapshots from
 * files and performs every mutation through the one single-writer queue.
 * All IO arrives injected: vault/config/log/announce through
 * {@link EngineHost}, the fleet runner through {@link FleetPort} — the
 * Drey plugin supplies both over its plugin context (main/engine-host.ts),
 * the standalone engine process (E2b) over plain fs.
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp, existsSync } from 'node:fs';
import * as path from 'node:path';
import { archivedTicketIds, nextTicketId, TICKETS_ARCHIVE_DIR, TICKET_ID_PATTERN, type BoardSnapshot, FolderStatus, PipelinePhase, ProjectRef, PromptEntry, PromptListing, RepoCandidate, RepoRef, ReposListing, TicketCard, TicketForm, TicketPriority, TicketTrack } from '../contracts/tickets';
import { parseChanges, parseResult, planApprovedOf, storyOf, type ChangesReply } from '../contracts/changes';
import { type RefineReply, TicketReply, AttachmentReply } from '../contracts/replies';
import { assembleBoard, parseRepos, addPipelinePhase, patchPipelinePhase, removePipelinePhase, renamePipelinePhase, parsePipeline, reorderPipelinePhases, reposFileText, reposProse } from '../core/ticket-board';
import { newTicketFileText, parseTicketFile, patchTicketFile, patchBlockedBy, patchChain, patchForm, patchTrack, ticketPathParts } from '../core/ticket-files';
import { parseChainEntry, renderChainEntries, validateChain } from '../core/chain-delta';
import type { ChainEntry } from '../contracts/chain';
import { refineTicket, revisionOf } from '../core/ticket-refine';
import { applyFolderNumbering, listTicketDirs, planFolderNumbering, resolvePhaseDir } from '../core/phase-dirs';
import { detectDrift, recentDoneOf, type DriftDetection } from '../core/normalize';
import { blockedRefusal } from '../core/blocked';
import { runTransition, type TransitionIo } from '../core/transition';
import { parseStatusLog, type StatusLine } from '../core/status-log';
import { LEDGER_FILE, parseLedger, settledUsageByTicket, type LedgerWrite } from '../core/ledger';
import { mergeWorktreeChanges, diffOfOutput, type TicketDiff, type WorktreeFile } from '../core/worktree-changes';
import { planWorktreeRemoval } from '../core/worktree-removal';
import { TicketsGit, type RepoLocation } from '../core/tickets-git';
import { loadShippedPrompts } from '../core/default-prompts';
import { type AttachmentCommand, RefineCommand } from '../core/commands';
import { nextImprovementId, parseFriction, parseImprovements, renderImprovements, type FrictionLine, type ImprovementDraft, type ImprovementProposal } from '../core/improvements';
import type { ImprovementDecision, PersonaImprovementsReply, PersonaMemoryReply, PersonaThreadReply } from '../contracts/remote-protocol';
import { isMap, isScalar, parseDocument } from 'yaml';
import { splitFrontmatter } from '../../../../shared/frontmatter';
import { composeRunRequest, type PersonaDispatch } from '../fleet/request';
import { deriveWorkerModel, personaLoader, resolvePersonaForTicket } from './persona-loader';
import { columnPromptRef, isAutoPhase, nextPhaseIdOf } from '../fleet/chain';
import { readRepoInstructions, worktreeDiffStat } from '../fleet/context-pack';
import { cleanWorktrees, listOrphans, removeWorktree, type CleanupReport } from '../fleet/worktree-clean';
import { unlinkShared } from '../fleet/worktrees';
import { statusLogPathOf } from '../fleet/event-writer';
import { legacyWorktreeBase, worktreeBaseFor, worktreePathFor, WORKTREES_DIR } from '../fleet/worktree-home';
import { type ChainConfig, FleetCaps, FleetHandoverConfig, HandoverMode, InteractiveMode, PermissionMode, RunInfo, FleetPools } from '../fleet/protocol';
import { type EngineHost, type EngineVaultChangeEvent, EngineVault, FleetPort } from './host';
import { handoverFromConfig, handoverOverrideKeys } from './handover-config';
import { appendMemory, memoryPathFor, parseMemoryEntries, toggleMemoryPin } from './persona-store';
import { personaFileText, personaMigrationFor, parsePersonaFile, personaRef, PERSONAS_DIR, PERSONA_ROLES, type Persona, type PersonaMigration, type PersonaRouter } from '../core/persona';
import { appendThreadOwner, newThreadText, parseThread, threadPathFor } from '../core/persona-thread';
import { scanRepoFolder } from './repos-scan';

const PIPELINE_PATH = 'tickets/_meta/pipeline.md';
const REPOS_PATH = 'tickets/_meta/repos.md';
const ATTACHMENTS_DIR = 'tickets/attachments';
const PROMPTS_DIR = 'tickets/_meta/prompts';
const PROMPT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLAN_INTERACTIVE_PROMPT = 'plan-interactive-default';
const REFINE_INTERACTIVE_PROMPT = 'refine-interactive-default';
const DEFAULT_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }
  - { id: commit, title: Commit, handover: agent commit-default }
  - { id: done, title: Done, handover: none }
---
The pipeline: ordered phases (first = capture target, last = terminal),
configurable per handover (manual | agent <prompt-ref> | ci | none).
Prioritized is the owner's checkpoint: clarify the task and its
acceptance criteria there; the build step derives file-level detail
itself, against the code it finds. See specs/ticket-schema.md.
Edit freely; the board follows on refresh.
`;
const DEFAULT_REPOS = `---
repos: {}
---
Work repositories a ticket's \`repo:\`/\`repos:\` fields may name. Example:

  lariscus:
    url: https://dev.azure.com/org/project/_git/lariscus
    branch: main
    policy: Azure DevOps branch policies protect main
`;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type BoardMutationResult =
  | { readonly ok: true; readonly warning?: string; readonly moved?: number; readonly path?: string }
  | { readonly ok: false; readonly error: string };

/** The card of one ticket id, wherever it sits on the board; null when absent. */
function findOnBoard(snap: BoardSnapshot, id: string): TicketCard | null {
  for (const column of snap.columns) {
    const found = column.tickets.find((t) => t.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

// --- the self-improvement loop's file seams (E6, concept §4.8) ---------

function improvementsPathFor(id: string): string {
  return `${PERSONAS_DIR}/${id}/improvements.md`;
}

function frictionPathFor(id: string): string {
  return `${PERSONAS_DIR}/${id}/friction.md`;
}

/** One memory entry is always one line, bounded (the personaLearn shape). */
function oneMemoryLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ').slice(0, 500);
}

/** The readable refusal every persona-scoped method shares. */
function personaMissing(id: string): string {
  return `persona "${id}" does not exist — create tickets/_meta/personas/${id}/persona.md first`;
}

/** The PATCH body's validation (U4): only the listed rules reject; null = the patch is writable. */
function personaPatchError(input: {
  title?: string;
  role?: string;
  worker?: string;
  model?: string;
  pool?: readonly string[];
  router?: string;
  color?: string;
  skills?: readonly string[];
  prompt?: string;
}): string | null {
  if (input.title !== undefined && input.title.trim() === '') {
    return 'the title is not empty';
  }
  if (input.role !== undefined && !(PERSONA_ROLES as readonly string[]).includes(input.role)) {
    return `the role is one of ${PERSONA_ROLES.join(', ')}`;
  }
  if (input.worker !== undefined && input.worker.trim() === '') {
    return 'the worker is not empty ("opencode", "claude-code" or "api")';
  }
  if (input.model !== undefined && input.model.trim() === '') {
    return 'the default model is not empty';
  }
  if (input.pool !== undefined && (input.pool.length === 0 || input.pool.some((m) => typeof m !== 'string' || m.trim() === ''))) {
    return 'the model pool is a non-empty list of model names';
  }
  if (input.router !== undefined && !(['off', 'budget', 'escalate-on-fail'] as const).includes(input.router as PersonaRouter)) {
    return 'the router is "off", "budget" or "escalate-on-fail"';
  }
  if (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.color.trim())) {
    return 'the color is a #rrggbb hex value';
  }
  if (input.skills !== undefined && input.skills.some((s) => typeof s !== 'string')) {
    return 'the skills are a list of skill names';
  }
  if (input.prompt !== undefined && typeof input.prompt !== 'string') {
    return 'the prompt is markdown text';
  }
  return null;
}

/**
 * The aggregation's truncation of friction.md: the findings moved into
 * the proposals' evidence, so only the heading stays. A file without a
 * `#` heading truncates to empty (the worker's file is heading-led).
 */
function frictionHeadingOnly(text: string): string {
  const head: string[] = [];
  for (const line of text.split('\n')) {
    head.push(line);
    if (line.startsWith('#')) {
      break;
    }
  }
  return `${head.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * The models.default decision's rewrite of persona.md: the yaml
 * doc-mutation discipline of `patchHeaderFields` — only
 * `models.default` changes, every other key, the pool/router and any
 * comment survive the round-trip untouched.
 */
function patchPersonaDefaultModel(text: string, model: string): string {
  const { yamlText, body, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    throw new Error('persona.md has no frontmatter fence');
  }
  const modelId = model.trim();
  if (modelId === '') {
    throw new Error('the default model is empty');
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error('persona.md frontmatter does not parse');
  }
  const models = doc.get('models', true);
  if (isMap(models)) {
    const existing = models.get('default', true);
    if (isScalar(existing)) {
      existing.value = modelId; // in place — the line's comment and style survive
    } else {
      models.set('default', modelId);
    }
  } else if (models === undefined) {
    doc.set('models', { default: modelId });
  } else {
    throw new Error('persona.md models is not a map');
  }
  let out = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  if (!out.endsWith('\n')) {
    out += '\n';
  }
  return `---\n${out}---\n${body}`;
}

/** The aggregator's input slice (E6): what the desk hands the LLM route. */
export interface ImprovementInput {
  readonly friction: readonly FrictionLine[];
  readonly lastAggregation: string | null;
  readonly settledRuns: number;
}

/**
 * The E7 ledger sink (concept §3.3): the runner's event writer or a test
 * fake. Fire-and-forget — a failure never reaches the board mutation.
 */
export interface LedgerEvents {
  readonly ledger: (write: LedgerWrite) => void;
}

/** The optional construction extras (E7); the default keeps every existing call site. */
export interface BoardServiceOptions {
  /** The fleet ledger writes behind the board's lifecycle events; absent = silent no-op. */
  readonly events?: LedgerEvents;
}

export class EngineBoardService {
  private queueTail: Promise<unknown> = Promise.resolve();
  private readonly gitLocations = new Map<string, RepoLocation | null>();
  private emitDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Who hears the debounced board change besides the renderer (the remote, req-66). */
  private readonly changeListeners = new Set<() => void>();
  private lastChainConfig: string | null = null;

  constructor(
    /** The host ports: every Drey/Electron affordance the service needs (ADR-0088, E2a). */
    private readonly host: EngineHost,
    private readonly git: TicketsGit,
    private readonly defaultWorker: string,
    private readonly autoPermissionMode: PermissionMode,
    private readonly gitPath: string,
    private readonly fleet: FleetPort,
    /** The fleet root — the worktrees the context pack stats live there. */
    private readonly fleetRoot: string,
    /** The instruction output caps (T-0048), resolved once at activation. */
    private readonly caps: FleetCaps,
    /** The per-provider pools (req-63), resolved once at activation. */
    private readonly pools: FleetPools,
    /** The handover thresholds (T-0049) — refreshed from the config with
     *  every snapshot (the override keys follow the board's pins). */
    private handover: FleetHandoverConfig,
    /** The acting owner (`owner@host`) — injected by the host. */
    private readonly owner: string,
    /** The optional extras (E7 ledger writes); `{}` keeps the service event-free. */
    private readonly options: BoardServiceOptions = {},
  ) {}

  /** The board's emit, debounced — one push per burst of changes. */
  announceChanged(): void {
    if (this.emitDebounce !== null) {
      return;
    }
    this.emitDebounce = setTimeout(() => {
      this.emitDebounce = null;
      this.host.emitBoardChanged();
      for (const listener of this.changeListeners) {
        listener();
      }
    }, 200);
  }

  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private async readOptional(vaultId: string, path: string): Promise<string | null> {
    try {
      return await this.host.read(vaultId, path);
    } catch {
      return null;
    }
  }

  /** A registered, existing vault containing the pipeline marker file. */
  async detect(): Promise<EngineVault | null> {
    const vault = await this.probeVaults();
    // The plugin-managed flag follows detection both ways (SDK 1.32,
    // ADR-0082): while a board lives in a vault, that vault's free-form
    // git history is refused — one transition is one structured commit.
    this.host.markManaged(vault === null ? null : vault.id);
    return vault;
  }

  private async probeVaults(): Promise<EngineVault | null> {
    const vaults = await this.host.listVaults();
    const candidates = vaults.filter((v) => v.exists);
    const configured = await this.host.configGet<string>('vaultId');
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
  private async ticketDirs(vault: EngineVault): Promise<string[]> {
    const abs = this.host.resolveAssetPath(vault.id, 'tickets');
    return abs === null ? [] : await listTicketDirs(abs);
  }

  /** Snapshot from files — every fetch rebuilds (no stored board state). */
  async snapshot(): Promise<BoardSnapshot> {
    const [vault, vaults] = await Promise.all([
      this.detect(),
      this.host.listVaults(),
    ]);
    const active = vaults.find((v) => v.active) ?? null;
    if (vault === null) {
      await this.syncChainConfig(null, []);
      return assembleBoard({
        vaultId: null,
        vaultName: null,
        activeVaultName: active?.name ?? null,
        isGitRepo: false,
        defaultWorker: this.defaultWorker,
        pipelineText: null,
        reposText: null,
        files: [],
      });
    }
    const [pipelineText, reposText, mdFiles, location, ledgerText] = await Promise.all([
      this.readOptional(vault.id, PIPELINE_PATH),
      this.readOptional(vault.id, REPOS_PATH),
      this.host.listMarkdownFiles(vault.id),
      this.locate(vault.path),
      this.readOptional(vault.id, LEDGER_FILE),
    ]);
    const paths = mdFiles.filter((p) => p.startsWith('tickets/') && !p.startsWith('tickets/_meta/'));
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        text: await this.host.read(vault.id, path),
      })),
    );
    const snapshot = assembleBoard({
      vaultId: vault.id,
      vaultName: vault.name,
      activeVaultName: active?.name ?? null,
      isGitRepo: location !== null,
      defaultWorker: this.defaultWorker,
      pipelineText,
      reposText,
      files,
      // The same file list already carries the archive — no extra reads.
      recentDone: recentDoneOf(files, Date.now()),
      // The settled runs' usage (concept §4.3): one vault-file read, the
      // pure assembly only attaches the sums to the matching cards.
      ticketUsage: settledUsageByTicket(parseLedger(ledgerText ?? '')),
    });
    // The chain follows the pipeline: an automatic column anywhere
    // points the runner at this vault (M85). Cheap and idempotent —
    // the runner re-reads the vault on every dispatch pass anyway.
    await this.refreshHandover(snapshot);
    await this.syncChainConfig(vault, snapshot.pipeline);
    return snapshot;
  }

  /** Re-reads the handover thresholds with the board's override keys (T-0049). */
  private async refreshHandover(snap: BoardSnapshot): Promise<void> {
    this.handover = await handoverFromConfig(
      this.host.configGet.bind(this.host),
      handoverOverrideKeys(snap, this.defaultWorker),
    );
  }

  /** Keeps the runner's chain config in step with the pipeline (never spawns). */
  private async syncChainConfig(
    vault: { readonly path: string } | null,
    pipeline: readonly PipelinePhase[],
  ): Promise<ChainConfig | null> {
    const defaultPersona = ((await this.host.configGet<string>('personas.default')) ?? '').trim() || null;
    const chain: ChainConfig | null =
      vault !== null && pipeline.some((phase) => isAutoPhase(phase))
        ? {
            ticketsVaultPath: vault.path,
            git: this.gitPath.trim() === '' ? 'git' : this.gitPath.trim(),
            defaultWorker: this.defaultWorker,
            defaultPersona,
            permissionMode: this.autoPermissionMode,
            caps: this.caps,
            pools: this.pools,
            handover: this.handover,
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
  private async findCard(id: string): Promise<{ vault: EngineVault; card: TicketCard; text: string } | null> {
    const vault = await this.detect();
    if (vault === null) {
      return null;
    }
    const snap = await this.snapshot();
    for (const column of snap.columns) {
      const card = column.tickets.find((t) => t.id === id);
      if (card !== undefined) {
        return { vault, card, text: await this.host.read(vault.id, card.path) };
      }
    }
    return null;
  }

  /** One ticket's card and file text, for the remote's ticket view (req-66). */
  async readTicket(id: string): Promise<TicketReply> {
    const found = await this.findCard(id);
    return found === null
      ? { ok: false, error: `${id} is not on the board` }
      : { ok: true, card: found.card, text: found.text, revision: revisionOf(found.text) };
  }

  /**
   * The E7 status read (concept §3.3): the ticket's `<card>.status.log`
   * parsed tolerant — the persona's verbs, newest last. An absent ticket
   * or log reads as no lines; broken lines are skipped, never guessed.
   */
  async statusOf(id: string): Promise<readonly StatusLine[]> {
    const found = await this.findCard(id);
    if (found === null) {
      return [];
    }
    const text = await this.readOptional(found.vault.id, statusLogPathOf(found.card.path));
    return text === null ? [] : parseStatusLog(text);
  }

  /**
   * The remote's refine (req-66 R5): sections and header fields of one
   * ticket, refused when the file changed since the device read it or a
   * run owns it. One commit; a Drey tab showing the file reloads when
   * clean and meets the save-conflict merge when dirty (ADR-0060).
   */
  refineTicket(input: RefineCommand & { actor?: string }): Promise<RefineReply> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      if (revisionOf(text) !== input.baseRevision) {
        return { ok: false, conflict: true, error: 'The ticket changed since you opened it. Reload it and edit again.' };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Refine it when the run has ended.' };
      }
      // The header's priority field validates against the vault's vocabulary.
      const snap = await this.snapshot();
      let refined: string;
      try {
        refined = refineTicket(text, { sections: input.sections, header: input.header }, input.actor ?? this.owner, new Date(), snap.priorities);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        await this.host.write(vault.id, card.path, refined);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} refined`);
      this.host.announceChanges(vault.id, [card.path]);
      this.announceChanged();
      return { ok: true, revision: revisionOf(refined), ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The raw-text save behind the phone edit mode (concept §5.5): the
   * exception path, not the everyday one — same conflict discipline as
   * refine (baseRevision stale → conflict, never a silent overwrite),
   * same one-commit rule. The text must still parse as a ticket file,
   * so a stray keystroke can never break the parsers downstream.
   */
  saveTicket(input: { id: string; text: string; baseRevision?: string; actor?: string }): Promise<RefineReply> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      if (input.baseRevision !== undefined && revisionOf(text) !== input.baseRevision) {
        return { ok: false, conflict: true, error: 'The ticket changed since you opened it. Reload it and edit again.' };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Edit it when the run has ended.' };
      }
      // The text is read with the vault's priority vocabulary, so an
      // unknown id is judged against what the board actually accepts.
      const snap = await this.snapshot();
      try {
        const parsed = parseTicketFile(input.text, card.path, snap.priorities);
        if (parsed.issues.some((issue) => issue.level === 'error')) {
          return { ok: false, error: `the text is not a valid ticket file: ${parsed.issues.find((i) => i.level === 'error')!.message}` };
        }
      } catch (error) {
        return { ok: false, error: `the text does not parse: ${messageOf(error)}` };
      }
      try {
        await this.host.write(vault.id, card.path, input.text);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} edited`);
      this.host.announceChanges(vault.id, [card.path]);
      this.announceChanged();
      return { ok: true, revision: revisionOf(input.text), ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The proof card's diff (concept §5.3): the worktree branch against
   * its base, one capped unified diff. No worktree/no repo → an empty
   * diff (the card shows the Changes section alone, honestly).
   */
  async ticketDiff(id: string): Promise<TicketDiff> {
    const vault = await this.detect();
    if (vault === null) {
      return { files: [], truncated: false };
    }
    const snap = await this.snapshot();
    let card: TicketCard | null = null;
    for (const column of snap.columns) {
      const found = column.tickets.find((t) => t.id === id);
      if (found !== undefined) {
        card = found;
        break;
      }
    }
    const repoName = card !== null && card.meta.repo !== null ? card.meta.repo : null;
    const repo = repoName === null ? null : snap.repos.find((r) => r.name === repoName) ?? null;
    if (card === null || repo === null || repo.path === null) {
      return { files: [], truncated: false };
    }
    const record = this.newestRecordFor(await this.fleetRecords(), card.id);
    const worktreePath = record !== null ? record.worktreePath : worktreePathFor(vault.path, repo, card.id);
    if (!existsSync(worktreePath)) {
      return { files: [], truncated: false };
    }
    const base = repo.branch ?? 'main';
    try {
      const output = await this.git.run(worktreePath, ['diff', '--unified=3', `${base}...HEAD`]);
      return diffOfOutput(output);
    } catch {
      return { files: [], truncated: false };
    }
  }

  /**
   * The Work panel's priority chip (req-75 W1): the refine rewrite of the
   * one header key, so the commit and the Log line are a refine's
   * (`tickets: <id> refined`, `refined (priority)`). No revision check —
   * the owner clicked on what the board shows; a live run refuses like
   * every refine.
   */
  setPriority(input: { id: string; priority: TicketPriority; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      // The vocabulary is the vault's (`priorities:` in pipeline.md) — an
      // id outside it refuses through the patcher's guard.
      const snap = await this.snapshot();
      if (card.meta.priority === input.priority) {
        return { ok: true };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Change the priority when the run has ended.' };
      }
      let refined: string;
      try {
        refined = refineTicket(text, { sections: {}, header: { priority: input.priority } }, input.actor ?? this.owner, new Date(), snap.priorities);
        await this.host.write(vault.id, card.path, refined);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} refined`);
      this.host.announceChanges(vault.id, [card.path]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The triage track (req-75 W1b, ADR-0087 decision 2): the row menu's
   * Track › pick — one header rewrite, one Log line, one commit
   * `tickets: <id> track <value>`. A live run refuses like every
   * header edit.
   */
  setTrack(input: { id: string; track: TicketTrack | null; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      if (card.meta.track === input.track) {
        return { ok: true };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Change the track when the run has ended.' };
      }
      let patched: string;
      try {
        patched = patchTrack(text, input.track, new Date(), input.actor ?? this.owner);
        await this.host.write(vault.id, card.path, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} track ${input.track ?? 'none'}`);
      this.host.announceChanges(vault.id, [card.path]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The ticket form (concept §5.6): the scout → ship promotion's board
   * half — one header rewrite (`patchForm`), one Log line, one commit
   * `tickets: <id> form <value>`. Setting what the file already carries
   * is a no-op success; a live run refuses like every header edit.
   */
  setForm(input: { id: string; form: TicketForm; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      if ((card.meta.form ?? 'ship') === input.form) {
        return { ok: true };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Change the form when the run has ended.' };
      }
      let patched: string;
      try {
        patched = patchForm(text, input.form, new Date(), input.actor ?? this.owner);
        await this.host.write(vault.id, card.path, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} form ${input.form}`);
      this.host.announceChanges(vault.id, [card.path]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The chain delta (concept §5.7): the chat's setChain execution — the
   * entries must each parse and hold against the pipeline and the
   * ticket's current position (`validateChain`), then one header
   * rewrite (`patchChain`), one Log line, one commit
   * `tickets: <id> chain <n entries|standard>`. An unchanged delta is a
   * no-op success; a live run refuses like every header edit.
   */
  setChain(input: { id: string; chain: readonly string[]; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      const snap = await this.snapshot();
      const entries: ChainEntry[] = [];
      for (const raw of input.chain) {
        const entry = parseChainEntry(raw);
        if (entry === null) {
          return { ok: false, error: `chain entry "${raw}" is not readable — expected e.g. "insert design after review"` };
        }
        entries.push(entry);
      }
      const refusal = validateChain(
        snap.pipeline.map((phase) => ({ id: phase.id, title: phase.title })),
        card.phase,
        entries,
      );
      if (refusal !== null) {
        return { ok: false, error: refusal };
      }
      const canonical = entries.length === 0 ? null : renderChainEntries(entries);
      const current = card.meta.chain ?? [];
      if (canonical !== null && current.length === entries.length && renderChainEntries(current).join('\n') === canonical.join('\n')) {
        return { ok: true };
      }
      if (canonical === null && current.length === 0) {
        return { ok: true };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Change the chain when the run has ended.' };
      }
      let patched: string;
      try {
        patched = patchChain(text, canonical, new Date(), input.actor ?? this.owner);
        await this.host.write(vault.id, card.path, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const value = canonical === null ? 'standard' : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} chain ${value}`);
      this.host.announceChanges(vault.id, [card.path]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The dependency list (T-0050): the chat's setBlockedBy execution — the
   * whole `blocked-by:` list is replaced (an empty list clears it, the
   * key leaves the file), one header rewrite (`patchBlockedBy`), one Log
   * line, one commit `tickets: <id> blocked-by <n ids|none>`. An
   * unchanged list is a no-op success; a live run refuses like every
   * header edit. The ids carry the ticket grammar (checked here and in
   * the patcher); whether an id resolves on the board stays the
   * dependency pass's business — an unknown id is written and simply
   * never blocks (the pass's tolerance, never a guess).
   */
  setBlockedBy(input: { id: string; blockedBy: readonly string[]; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      for (const id of input.blockedBy) {
        if (!TICKET_ID_PATTERN.test(id)) {
          return { ok: false, error: `blocked-by: "${id}" is not a ticket id` };
        }
      }
      const current = card.meta.blockedBy;
      if (current.length === input.blockedBy.length && input.blockedBy.every((id, i) => id === current[i])) {
        return { ok: true };
      }
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Change the blockers when the run has ended.' };
      }
      let patched: string;
      try {
        patched = patchBlockedBy(text, input.blockedBy, new Date(), input.actor ?? this.owner);
        await this.host.write(vault.id, card.path, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const value = input.blockedBy.length === 0 ? 'none' : `${input.blockedBy.length} ${input.blockedBy.length === 1 ? 'id' : 'ids'}`;
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} blocked-by ${value}`);
      this.host.announceChanges(vault.id, [card.path]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * An image a paired device pasted or picked (req-66 R8): written under
   * the reserved `tickets/attachments/` folder, exactly one commit. No
   * Log line — the Log lives in ticket files and no ticket file is
   * touched (Capture uploads before a ticket exists); the audit is the
   * router's `remote <device>: attachment` line and the commit itself.
   */
  saveAttachment(input: AttachmentCommand & { actor?: string }): Promise<AttachmentReply> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const dir = this.host.resolveAssetPath(vault.id, ATTACHMENTS_DIR);
      if (dir === null) {
        return { ok: false, error: 'the attachments folder is not reachable' };
      }
      await fsp.mkdir(dir, { recursive: true });
      const now = new Date();
      const p = (n: number): string => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
      let name = `img-${stamp}-${randomBytes(2).toString('hex')}.${input.ext}`;
      for (;;) {
        try {
          await fsp.writeFile(path.join(dir, name), input.bytes, { flag: 'wx' });
          break;
        } catch (error) {
          if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
            name = `img-${stamp}-${randomBytes(2).toString('hex')}.${input.ext}`;
            continue;
          }
          return { ok: false, error: `write failed: ${messageOf(error)}` };
        }
      }
      const file = `${ATTACHMENTS_DIR}/${name}`;
      const warning = await this.commit(vault, [file], `tickets: attachment ${name}`);
      this.host.announceChanges(vault.id, [file]);
      return { ok: true, file, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The `board` IPC route (T-0041): normalize first — a file move is a
   * ticket move — then migrate legacy column keys onto personas (E3,
   * same single-writer queue), then snapshot. Normalization and the
   * migration run enqueued (the same single-writer queue as every
   * mutation) and snapshots are taken OUTSIDE it, so this never nests
   * `enqueue` inside `enqueue`.
   */
  async refresh(): Promise<BoardSnapshot> {
    await this.normalizeDrift();
    await this.migrateLegacyPersonas();
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
      const mdFiles = await this.host.listMarkdownFiles(vault.id);
      const paths = mdFiles.filter((p) => p.startsWith('tickets/') && !p.startsWith('tickets/_meta/'));
      const files: { path: string; text: string }[] = [];
      for (const p of paths) {
        const text = await this.host.read(vault.id, p).catch(() => null);
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
          this.host.log(`normalizing ${drift.id} (${drift.path}) failed: ${messageOf(error)}`, 'warn');
        }
      }
    });
  }

  /** One drift's full transition treatment. The path never changes —
   *  only stamps and Log; exactly one commit closes it. In-place run of
   *  the one transition machine with the pre-read text (the normalization
   *  pass bulk-read the files; a failure throws so the caller logs
   *  `normalizing <id> (<path>) failed: …`). */
  private async treatDrift(
    vault: EngineVault,
    drift: DriftDetection,
    text: string,
    pushRemote: string | null,
  ): Promise<void> {
    const result = await runTransition(this.transitionIo(vault), {
      id: drift.id,
      fromPath: drift.path,
      text,
      patch:
        drift.kind === 'archive'
          ? { to: 'archive', from: null, now: new Date(), actor: this.owner, action: 'archived' }
          : // null (no event at all) logs honestly as `unknown -> <phase>`
            { to: drift.phase, from: drift.from ?? 'unknown', now: new Date(), actor: this.owner },
      commitMessage:
        drift.kind === 'archive'
          ? `tickets: ${drift.id} archived`
          : `tickets: ${drift.id} ${drift.from ?? 'unknown'} -> ${drift.phase}`,
      pushRemote,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  /** Serialize mutations; failures never block the next one. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queueTail.catch(() => undefined).then(op);
    this.queueTail = next;
    return next;
  }

  /** The git step of a mutation: one commit for exactly these paths. */
  private async commit(vault: EngineVault, vaultRelPaths: readonly string[], message: string): Promise<string | null> {
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
      this.host.log(`git commit failed: ${text}`, 'warn');
      return `git commit failed: ${text.split('\n')[0]}`;
    }
  }

  /**
   * The optional auto-push after a transition commit (T-0041,
   * pipeline.md `push:`): `git push <remote> HEAD` from the tickets repo
   * root. A failure is a warning the panel shows — never a failed
   * transition; the commit is already durable. Null remote = no push.
   */
  private async pushTransition(vault: EngineVault, remote: string | null): Promise<string | null> {
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
      this.host.log(`git push to "${remote}" failed: ${text}`, 'warn');
      return `git push to "${remote}" failed: ${text}`;
    }
  }

  /**
   * The host adapter for the one transition machine (ADR-0088, E1): vault
   * reads/writes, the mkdir+rename with the verbatim path-escape wording,
   * the warning-level commit/push plumbing and the closing announcement
   * (vault round + board-changed). Every move kind — transition, archive,
   * unarchive, drift — runs through `runTransition` with this IO.
   */
  private transitionIo(vault: EngineVault): TransitionIo {
    return {
      read: (path) => this.host.read(vault.id, path),
      write: async (path, text) => {
        await this.host.write(vault.id, path, text);
      },
      renameInto: async (fromPath, toPath) => {
        const oldAbs = this.host.resolveAssetPath(vault.id, fromPath);
        const dirAbs = this.host.resolveAssetPath(vault.id, path.posix.dirname(toPath));
        const newAbs = this.host.resolveAssetPath(vault.id, toPath);
        if (oldAbs === null || dirAbs === null || newAbs === null) {
          return { ok: false, error: 'ticket path escapes the vault' };
        }
        try {
          await fsp.mkdir(dirAbs, { recursive: true });
          await fsp.rename(oldAbs, newAbs);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: `move failed: ${messageOf(error)}` };
        }
      },
      commit: (paths, message) => this.commit(vault, paths, message),
      push: (remote) => this.pushTransition(vault, remote),
      announce: (changedPaths, deletedPaths) => {
        this.host.announceChanges(vault.id, [...changedPaths], deletedPaths.length > 0 ? [...deletedPaths] : undefined);
        this.announceChanged();
      },
    };
  }

  createTicket(input: {
    title: string;
    /** Who acts (req-66): `owner@<device>` from the remote; default the desk owner. */
    actor?: string;
    priority: TicketPriority;
    /** The primary work repo. */
    repo: string | null;
    /** Every work repo, primary first (req-72); absent = just the primary. */
    repos?: readonly string[];
    description: string;
    /** The owner's raw words behind a tidied create (req-75 W5c); absent
     *  for a hand-typed ticket — one more Log line when set. */
    raw?: string;
  }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      if (snap.pipeline.length === 0) {
        return { ok: false, error: snap.pipelineError ?? 'the pipeline is empty' };
      }
      // The created file's priority must carry a word of the vault's own
      // vocabulary — an unknown id would read as the default with a
      // warning forever, so it refuses here instead.
      if (!snap.priorities.order.includes(input.priority)) {
        return {
          ok: false,
          error: `unknown priority "${input.priority}" — this board's vocabulary is ${snap.priorities.order.join(', ')}`,
        };
      }
      // Archived ids count too: an id is never reused, even after the
      // ticket with the highest one was archived.
      const id = nextTicketId([
        ...snap.columns.flatMap((c) => c.tickets.map((t) => t.id)),
        ...archivedTicketIds(await this.host.listMarkdownFiles(vault.id)),
      ]);
      const firstPhase = snap.pipeline[0]!.id;
      const firstDir = resolvePhaseDir(await this.ticketDirs(vault), 1, firstPhase);
      const path = `tickets/${firstDir}/${id}.md`;
      const text = newTicketFileText({
        id,
        title: input.title,
        repo: input.repo,
        ...(input.repos !== undefined ? { repos: input.repos } : {}),
        priority: input.priority,
        rank: 5000,
        firstPhase,
        now: new Date(),
        actor: input.actor ?? this.owner,
        description: input.description,
        ...(input.raw !== undefined ? { rawCapture: input.raw } : {}),
      });
      try {
        await this.host.writeAnnounced(vault.id, path, text);
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
    actor?: string;
    from: string;
    to: string;
  }): Promise<BoardMutationResult> {
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
      return this.moveCard(vault, snap, card, input.to, input.actor ?? this.owner);
    });
  }

  /**
   * The board's move, already inside the queue (shared by `transition`,
   * the Ready card's Accept and its Send back, req-75 W3): validate the
   * target and the path guard here, then run the one transition machine —
   * patch (plus the optional second Log line), rename into the resolved
   * numbered directory, one commit, the optional push, one announcement.
   */
  private async moveCard(
    vault: EngineVault,
    snap: BoardSnapshot,
    card: TicketCard,
    to: string,
    actor: string,
    extraLog?: string,
  ): Promise<BoardMutationResult> {
    const from = card.phase;
    const toPhase = snap.pipeline.find((p) => p.id === to) ?? null;
    if (toPhase === null) {
      return { ok: false, error: `"${to}" is not a phase in the pipeline` };
    }
    // Prefix-aware path guard (T-0041): the card may sit in `10-inbox`
    // or `inbox` — the stripped phase id is the identity.
    const parts = ticketPathParts(card.path);
    if (parts === null || parts.phase !== from || parts.stem !== card.id) {
      return { ok: false, error: `${card.id} sits in an unexpected path (${card.path})` };
    }

    const toDir = resolvePhaseDir(
      await this.ticketDirs(vault),
      snap.pipeline.findIndex((p) => p.id === to) + 1,
      to,
    );
    // A hand-move never touches the claim (owner ruling, 2026-10-18): a
    // stamp here would block the target column's pool, since the
    // dispatcher never takes claimed cards. Claims belong to the
    // takeover/release menu and to the fleet's own moves.
    const result = await runTransition(this.transitionIo(vault), {
      id: card.id,
      fromPath: card.path,
      patch: { to, from, now: new Date(), actor },
      ...(extraLog !== undefined ? { extraLog } : {}),
      toPath: `tickets/${toDir}/${card.id}.md`,
      commitMessage: `tickets: ${card.id} ${from} -> ${to}`,
      pushRemote: snap.pushRemote,
    });
    // E7: the ledger's phase line rides the successful move.
    if (result.ok) {
      this.options.events?.ledger({ kind: 'phase', ticket: card.id, from, to });
    }
    return result;
  }

  /**
   * Archives a ticket (T-0041): the reserved `tickets/archive/` folder
   * beside `_meta` — not a column, invisible on the board. The treatment
   * is exact: Log line `archived`, one commit `tickets: <id> archived`;
   * NO `entered-` stamp (the Log marker is what makes it
   * idempotent and a revive detectable); claim fields ride along.
   * Reviving is a move back into a phase folder — normalization stamps
   * it as `archive -> <phase>`. Final deletion is the owner's manual
   * act inside `archive/`.
   */
  archive(input: { id: string; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      const card = findOnBoard(snap, input.id);
      if (card === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      return this.archiveCard(vault, snap, card, input.actor ?? this.owner);
    });
  }

  /**
   * The archive treatment itself, already inside the queue (the Ready
   * card's terminal Accept reuses it, req-75 W3) — one transition-machine
   * run: the `archived` Log line, NO `entered-` stamp (the Log marker is
   * what makes it idempotent and a revive detectable), the move into
   * `tickets/archive/`, one commit, the optional push. Claim fields ride
   * along. Reviving is a move back into a phase folder — normalization
   * stamps it as `archive -> <phase>`. Final deletion is the owner's
   * manual act inside `archive/`.
   */
  private async archiveCard(vault: EngineVault, snap: BoardSnapshot, card: TicketCard, actor: string): Promise<BoardMutationResult> {
    const result = await runTransition(this.transitionIo(vault), {
      id: card.id,
      fromPath: card.path,
      patch: { to: 'archive', from: null, now: new Date(), actor, action: 'archived' },
      toPath: `${TICKETS_ARCHIVE_DIR}/${card.id}.md`,
      commitMessage: `tickets: ${card.id} archived`,
      pushRemote: snap.pushRemote,
    });
    // E7: the ledger's archived line rides the successful archive.
    if (result.ok) {
      this.options.events?.ledger({ kind: 'archived', ticket: card.id });
    }
    return result;
  }

  /**
   * "Launch this version" (req-75 W3, T-0057): start the repository's
   * program in the ticket's worktree, in a new console that outlives
   * Drey. The command is the repo's `launch:` from repos.md (owner
   * data) or the fixed dev.ps1 default — never anything from ticket
   * content.
   */
  launchVersion(input: { id: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      const card = findOnBoard(snap, input.id);
      if (card === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const notThere = `${input.id} has no worktree yet — nothing to launch`;
      const repo = card.meta.repo === null ? null : snap.repos.find((r) => r.name === card.meta.repo) ?? null;
      if (repo === null) {
        return { ok: false, error: notThere };
      }
      const worktreePath = worktreePathFor(vault.path, repo, card.id);
      if (!(await fsp.stat(worktreePath).then((s) => s.isDirectory()).catch(() => false))) {
        return { ok: false, error: notThere };
      }
      let command: string | null = repo.launch;
      if (command === null) {
        // The default a Drey checkout carries (req-75 W3): the packaged
        // app from a second, lock-free instance beside the one running.
        if (await fsp.stat(`${worktreePath}${path.sep}dev.ps1`).then((s) => s.isFile()).catch(() => false)) {
          command = 'powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi';
        }
      }
      if (command === null) {
        return {
          ok: false,
          error: `No launch command for "${repo.name}" — add launch: to repos.md (Settings → Tickets → Repositories)`,
        };
      }
      try {
        this.host.launchInConsole(worktreePath, command);
      } catch (error) {
        return { ok: false, error: `launch failed: ${messageOf(error)}` };
      }
      return { ok: true };
    });
  }

  /**
   * The Ready card's "Accept and merge" (req-75 W3): accept follows the
   * pipeline — in the terminal phase the archive treatment, then the
   * worktree goes when it is clean (a dirty one stays, visibly); in any
   * other phase the ordinary transition to the next configured phase
   * (with an agent `commit` phase next, that step merges). No second
   * merge implementation here.
   */
  acceptTicket(input: { id: string; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      const card = findOnBoard(snap, input.id);
      if (card === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const actor = input.actor ?? this.owner;
      const next = nextPhaseIdOf(snap.columns, card.phase);
      if (next !== null) {
        return this.moveCard(vault, snap, card, next, actor);
      }
      const archived = await this.archiveCard(vault, snap, card, actor);
      if (!archived.ok) {
        return archived;
      }
      // E7: a terminal Accept is the ledger's merged line (the archive
      // itself already wrote the archived line).
      this.options.events?.ledger({ kind: 'merged', ticket: card.id });
      const warnings = [archived.warning];
      const worktreeWarning = await this.removeWorktreeAfterAccept(vault, snap, card);
      if (worktreeWarning !== null) {
        warnings.push(worktreeWarning);
      }
      const kept = warnings.filter((w): w is string => w !== undefined);
      return { ok: true, ...(kept.length === 0 ? {} : { warning: kept.join('; ') }) };
    });
  }

  /**
   * The clean-worktree removal of a terminal Accept (req-75 W3): the
   * T-0044 `worktree remove` path with `force: false` — a dirty tree
   * stays and says so; a live run keeps it untouched. Never a failed
   * accept: the ticket is already archived.
   */
  private async removeWorktreeAfterAccept(vault: EngineVault, snap: BoardSnapshot, card: TicketCard): Promise<string | null> {
    if (card.meta.repo === null) {
      return null;
    }
    const repo = snap.repos.find((r) => r.name === card.meta.repo) ?? null;
    if (repo === null || repo.path === null) {
      return null;
    }
    const runs = await this.fleetRecords();
    if (runs.some((r) => r.ticketId === card.id && !['done', 'stopped', 'failed'].includes(r.state))) {
      return 'A run is live on the ticket — the worktree was kept';
    }
    const outcome = await removeWorktree(this.git, repo.path, worktreePathFor(vault.path, repo, card.id), {
      force: false,
      links: repo.link,
    });
    if (outcome.ok) {
      return null;
    }
    return outcome.dirty === true ? 'The worktree has uncommitted changes and was kept' : outcome.error;
  }

  /**
   * The Ready card's "Send back…" (req-75 W3): the ordinary transition
   * to the nearest earlier agent phase (the build column in the default
   * pipeline), the Log line `<from> -> <to>` followed by `sent back:
   * <note>`, one commit.
   */
  sendBack(input: { id: string; note: string; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const snap = await this.snapshot();
      const card = findOnBoard(snap, input.id);
      if (card === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const at = snap.pipeline.findIndex((p) => p.id === card.phase);
      let to: string | null = null;
      for (let i = at - 1; i >= 0; i--) {
        if (isAutoPhase(snap.pipeline[i]!)) {
          to = snap.pipeline[i]!.id;
          break;
        }
      }
      if (to === null) {
        return { ok: false, error: `there is no agent phase before "${card.phase}" to send ${input.id} back to` };
      }
      return this.moveCard(vault, snap, card, to, input.actor ?? this.owner, `sent back: ${input.note.trim().slice(0, 500)}`);
    });
  }

  /**
   * The Ready page's data (req-75 W3): the parsed `## Changes` section
   * and the story, read from the ticket file — no new frontmatter.
   */
  async changesOf(id: string): Promise<ChangesReply> {
    const found = await this.findCard(id);
    if (found === null) {
      return { changes: null, story: [], totals: { minutes: null, tokens: null }, planApproved: null, result: null, launchable: false };
    }
    const story = storyOf(found.text);
    return {
      changes: parseChanges(found.text),
      story: story.items,
      totals: story.totals,
      planApproved: planApprovedOf(found.text),
      result: parseResult(found.text),
      launchable: await this.launchableFor(id),
    };
  }

  /** Whether "Launch this version" can work: a worktree on disk and a command to run in it. */
  private async launchableFor(id: string): Promise<boolean> {
    try {
      const vault = await this.detect();
      if (vault === null) {
        return false;
      }
      const snap = await this.snapshot();
      const card = findOnBoard(snap, id);
      const repo = card?.meta.repo == null ? null : snap.repos.find((r) => r.name === card.meta.repo) ?? null;
      if (card === null || repo === null) {
        return false;
      }
      const worktreePath = worktreePathFor(vault.path, repo, card.id);
      if (!(await fsp.stat(worktreePath).then((s) => s.isDirectory()).catch(() => false))) {
        return false;
      }
      return (
        repo.launch !== null ||
        (await fsp.stat(`${worktreePath}${path.sep}dev.ps1`).then((s) => s.isFile()).catch(() => false))
      );
    } catch {
      return false;
    }
  }

  /**
   * Unarchives a ticket (T-0042): a move out of `tickets/archive/` back
   * into a phase folder IS the board treatment — `archive -> <phase>`
   * stamp, Log line, one commit — never a raw move plus drift
   * normalization. The drag in Files feels exactly like the board's own
   * move (decision 7). The board itself shows nothing in archive/; the
   * file is read directly.
   */
  unarchive(input: { id: string; to: string; actor?: string }): Promise<BoardMutationResult> {
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
      const toDir = resolvePhaseDir(
        await this.ticketDirs(vault),
        snap.pipeline.findIndex((p) => p.id === input.to) + 1,
        input.to,
      );
      return runTransition(this.transitionIo(vault), {
        id: input.id,
        fromPath: `${TICKETS_ARCHIVE_DIR}/${input.id}.md`,
        readError: `${input.id} is not in the archive`,
        patch: { to: input.to, from: 'archive', now: new Date(), actor: input.actor ?? this.owner },
        toPath: `tickets/${toDir}/${input.id}.md`,
        commitMessage: `tickets: ${input.id} archive -> ${input.to}`,
        pushRemote: snap.pushRemote,
      });
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
  async removeWorktree(folder: string): Promise<BoardMutationResult> {
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
    const worktreeAbs = this.host.resolveAssetPath(vault.id, folder);
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
    this.host.announceChanges(vault.id, [], [folder]);
    this.announceChanged();
    return { ok: true };
  }

  setClaim(input: { id: string; mode: 'takeover' | 'release'; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      const previous = card.meta.claimedBy;
      if (input.mode === 'takeover' && previous === (input.actor ?? this.owner)) {
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
          actor: input.actor ?? this.owner,
          action:
            input.mode === 'takeover'
              ? `claim takeover${previous !== null ? ` (was ${previous})` : ''}`
              : 'claim release',
          ...(input.mode === 'takeover' ? { claimBy: input.actor ?? this.owner } : { releaseClaim: true }),
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        await this.host.write(vault.id, card.path, patched);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [card.path], `tickets: ${input.id} claim ${input.mode}`);
      this.host.announceChanges(vault.id, [card.path]);
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
    /** The dialog's handover choice (T-0049); null = not asked — fresh. */
    handover: HandoverMode | 'auto' | null;
    /**
     * The owner drives this run as an interactive dialog (req-65):
     * the worker is held from turn one, the run never gates or moves.
     * null = a normal run.
     */
    interactive: InteractiveMode | null;
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
      if (card.meta.run !== null && !(await this.clearEndedRunStamp(vault, card))) {
        return { ok: false, error: `${card.id} already has a live run — stop it first` };
      }
      const blocked = blockedRefusal(card);
      if (blocked !== null) {
        return { ok: false, error: blocked };
      }
      const workingPhase = snap.pipeline.find((p) => p.id === phaseId) ?? null;
      const repo =
        card.meta.repo === null ? null : (snap.repos.find((r) => r.name === card!.meta.repo) ?? null);
      // req-72: the ticket's further repos, resolved like the primary's —
      // an unknown name refuses the start (the board badges it already).
      const missingExtra = card.meta.repos.find((name) => name !== card.meta.repo && !snap.repos.some((r) => r.name === name));
      if (missingExtra !== undefined) {
        return { ok: false, error: `${card.id} names repo "${missingExtra}", but it is not in _meta/repos.md` };
      }
      const extraRepos = card.meta.repos
        .filter((name) => name !== card.meta.repo)
        .map((name) => snap.repos.find((r) => r.name === name)!)
        .filter((r) => r !== undefined);
      const text = await this.host.read(vault.id, card.path);
      let prompt: string | null = null;
      if (input.interactive !== null) {
        // req-65: the dialog's brief — the phase's `interactive:` ref,
        // else the shipped default for the mode. A manual checkpoint
        // column has no prompt of its own; the dialog gets one anyway.
        const ref =
          workingPhase?.interactive ??
          (input.interactive === 'plan' ? PLAN_INTERACTIVE_PROMPT : REFINE_INTERACTIVE_PROMPT);
        prompt = await this.readOptional(vault.id, `tickets/_meta/prompts/${ref}.md`);
        if (prompt === null) {
          return {
            ok: false,
            error: `the interactive prompt "${ref}" is missing — tickets/_meta/prompts/${ref}.md ("Add Drey's prompts" in the ticket settings re-adds it)`,
          };
        }
      } else {
        const promptRef = workingPhase === null ? null : columnPromptRef(workingPhase);
        if (promptRef !== null) {
          prompt = await this.readOptional(vault.id, `tickets/_meta/prompts/${promptRef}.md`);
          if (prompt === null) {
            return {
              ok: false,
              error: `the handover names prompt "${promptRef}", but tickets/_meta/prompts/${promptRef}.md is missing`,
            };
          }
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
        repoInstructions = await readRepoInstructions(repo.path, repo.instructions);
        diffStat = await worktreeDiffStat(
          this.git,
          worktreePathFor(vault.path, repo, card.id),
          repo.branch,
        );
      }
      const gateFailure = await this.lastGateFailure(card.id);
      // E3: the persona ladder (ticket pin > phase persona > engine
      // default) — a resolved persona contributes worker/model/prompt/
      // memory; an owner-picked worker in the dialog still wins.
      const loader = personaLoader((rel) => this.host.read(vault.id, rel));
      const personaResolution = await resolvePersonaForTicket(loader, {
        ticketPersona: card.meta.persona,
        phasePersona: workingPhase?.persona ?? null,
        defaultPersona: ((await this.host.configGet<string>('personas.default')) ?? '').trim() || null,
      });
      let personaDispatch: PersonaDispatch | null = null;
      if (personaResolution.persona !== null) {
        const derived = deriveWorkerModel(personaResolution.persona, null);
        personaDispatch = {
          id: personaResolution.persona.id,
          worker: derived.workerChoice,
          model: derived.model ?? '',
          prompt: await loader.prompt(personaResolution.persona.id),
          memory: await loader.memory(personaResolution.persona.id),
          coaching: await loader.thread(personaResolution.persona.id),
        };
      }
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
        extraRepos,
        promptText: prompt,
        defaultWorker: this.defaultWorker,
        permissionMode: input.permissionMode,
        gitPath: ((await this.host.configGet<string>('gitPath')) ?? '').trim(),
        workerChoice: input.workerChoice,
        repoInstructions,
        diffStat,
        gateFailure,
        caps: this.caps,
        ...(personaDispatch !== null ? { persona: personaDispatch } : {}),
        ...(input.handover !== null ? { handover: input.handover } : input.interactive !== null ? { handover: 'auto' } : {}),
        ...(input.interactive !== null ? { interactive: input.interactive } : {}),
      });
      if (!composed.ok) {
        return { ok: false, error: composed.error };
      }
      for (const truncation of composed.truncations) {
        this.host.log(
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
   * A `run:` stamp whose run provably ended (its record settled with an
   * end time — a down runner's synthetic `stopped` carries none) is a
   * leftover, e.g. of a card moved while its run went on: cleared with a
   * Log line and one commit. True when the ticket is free now.
   */
  private async clearEndedRunStamp(vault: EngineVault, card: TicketCard): Promise<boolean> {
    const stream = card.meta.run?.stream ?? null;
    if (stream === null) {
      return true;
    }
    const record = (await this.fleetRecords()).find((r) => r.id === stream) ?? null;
    if (record === null || !['done', 'stopped', 'failed'].includes(record.state) || record.endedAt === null) {
      return false;
    }
    const text = await this.host.read(vault.id, card.path);
    const patched = patchTicketFile(text, {
      to: card.phase,
      from: null,
      now: new Date(),
      actor: this.owner,
      clearRun: true,
      action: `stale run stamp cleared — run ${stream} had ended (${record.state})`,
    });
    await this.host.write(vault.id, card.path, patched);
    await this.commit(vault, [card.path], `tickets: ${card.id} stale run stamp cleared`);
    this.host.announceChanges(vault.id, [card.path]);
    return true;
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
   * The Changes-so-far box (req-75 W4a): the ticket's worktree diffed
   * against its base ref — committed (`<base>...HEAD`) and uncommitted
   * (the working tree vs `HEAD`) — as one file list, capped by the pure
   * half. Empty when there is no worktree to diff (no repo, no checkout,
   * nothing prepared yet).
   */
  async worktreeChangesOf(id: string): Promise<readonly WorktreeFile[]> {
    const vault = await this.detect();
    if (vault === null) {
      return [];
    }
    const snap = await this.snapshot();
    let card: TicketCard | null = null;
    for (const column of snap.columns) {
      const found = column.tickets.find((t) => t.id === id);
      if (found !== undefined) {
        card = found;
        break;
      }
    }
    const repoName = card !== null && card.meta.repo !== null ? card.meta.repo : null;
    const repo = repoName === null ? null : snap.repos.find((r) => r.name === repoName) ?? null;
    if (card === null || repo === null || repo.path === null) {
      return [];
    }
    const record = this.newestRecordFor(await this.fleetRecords(), card.id);
    const worktreePath = record !== null ? record.worktreePath : worktreePathFor(vault.path, repo, card.id);
    if (!existsSync(worktreePath)) {
      return [];
    }
    const base = repo.branch ?? 'main';
    try {
      const committed = await Promise.all([
        this.git.run(worktreePath, ['diff', '--numstat', `${base}...HEAD`]),
        this.git.run(worktreePath, ['diff', '--name-status', `${base}...HEAD`]),
      ]);
      const working = await Promise.all([
        this.git.run(worktreePath, ['diff', '--numstat', 'HEAD']),
        this.git.run(worktreePath, ['diff', '--name-status', 'HEAD']),
      ]);
      return mergeWorktreeChanges([
        { numstat: committed[0]!, nameStatus: committed[1]! },
        { numstat: working[0]!, nameStatus: working[1]! },
      ]);
    } catch {
      return [];
    }
  }

  /**
   * Liveness is the ticket's `run:` stamp ∪ non-terminal fleet records
   * (ADR-0080): never fleet status alone — `readHistory` marks a
   * still-live run `stopped` when the runner is down, and the stamps
   * are the persisted truth. A `detached` worker may still be running:
   * it counts as live.
   */
  private async liveWorktreePaths(vault: EngineVault, snap: BoardSnapshot): Promise<string[]> {
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

      // req-72: the further repos' worktrees follow (same branch, same
      // rules) — a dirty extra counts as force-consented with the primary,
      // a failure is a warning, never a failed action.
      const warnings: string[] = [];
      for (const name of card.meta.repos) {
        if (name === repo.name) {
          continue;
        }
        const extra = snap.repos.find((r) => r.name === name);
        if (extra === undefined || extra.path === null) {
          continue;
        }
        const extraOutcome = await removeWorktree(this.git, extra.path, worktreePathFor(vault.path, extra, card.id), {
          force: input.force,
          links: extra.link,
        });
        if (!extraOutcome.ok) {
          warnings.push(
            `${extra.name}: ${extraOutcome.dirty === true ? 'the worktree is dirty — not removed' : extraOutcome.error}`,
          );
        }
      }

      // The owner's button: one action-only Log line, one commit.
      const text = await this.host.read(vault.id, card.path);
      let warning: string | null = warnings.length > 0 ? `extra worktrees: ${warnings.join('; ')}` : null;
      try {
        const patched = patchTicketFile(text, {
          to: card.phase,
          from: null,
          now: new Date(),
          actor: this.owner,
          action: `worktree removed (${worktreePath})`,
        });
        await this.host.write(vault.id, card.path, patched);
        const commitNote = await this.commit(vault, [card.path], `tickets: ${card.id} worktree removed`);
        if (commitNote !== null) {
          warning = warning === null ? commitNote : `${warning} — ${commitNote}`;
        }
        this.host.announceChanges(vault.id, [card.path]);
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
    this.host.log(
      `worktree cleanup: ${report.removed.length} removed, ${report.keptDirty.length} kept dirty` +
        `, ${report.leftovers.length} leftover folder(s) swept` +
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
        report.leftovers.length > 0 ||
        orphans.length > 0 ||
        leftovers.length > 0
      ) {
        this.host.log(
          `worktree boot sweep: migrated ${report.removed.length}, kept dirty ${report.keptDirty.length}` +
            `, swept ${report.leftovers.length}` +
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
  private async ensureWorktreesIgnored(vault: EngineVault): Promise<void> {
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
      this.host.log(`ignoring the worktrees base failed: ${messageOf(error)}`, 'warn');
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
    color?: string | null;
  }): Promise<BoardMutationResult> {
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
        input.prompt === undefined &&
        input.color === undefined
      ) {
        return { ok: true }; // nothing to change (e.g. the handover-pin display state)
      }
      if (input.worker !== undefined) {
        const worker = input.worker?.trim() ?? '';
        if (worker !== '' && worker !== 'opencode' && worker !== 'claude-code') {
          return { ok: false, error: 'the worker is "opencode" or "claude-code"' };
        }
      }
      if (input.color !== undefined) {
        const color = input.color?.trim() ?? '';
        if (color !== '' && !/^#[0-9a-f]{6}$/i.test(color)) {
          return { ok: false, error: 'the color is a #rrggbb hex value' };
        }
      }
      let patched: string;
      try {
        patched = patchPipelinePhase(text, input.phase, {
          ...(input.worker !== undefined ? { worker: input.worker } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        await this.host.write(vault.id, PIPELINE_PATH, patched);
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
      if (input.color !== undefined) {
        what.push(`color ${input.color === null || input.color.trim() === '' ? 'default' : input.color.trim()}`);
      }
      const warning = await this.commit(vault, [PIPELINE_PATH], `tickets: columns ${input.phase} ${what.join(', ')}`);
      this.host.announceChanges(vault.id, [PIPELINE_PATH]);
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
    const dir = this.host.resolveAssetPath(vault.id, PROMPTS_DIR);
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
  savePrompt(input: { ref: string; text?: string; reset?: boolean }): Promise<BoardMutationResult> {
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
        await this.host.write(vault.id, file, text);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const verb = input.reset === true ? 'reset' : before === null ? 'add' : 'edit';
      const warning = await this.commit(vault, [file], `tickets: prompt ${input.ref} ${verb}`);
      this.host.announceChanges(vault.id, [file]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /** Adds the shipped prompts the vault lacks (never overwrites one); one commit. */
  restoreShippedPrompts(): Promise<BoardMutationResult> {
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
            await this.host.write(vault.id, file, text);
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
      this.host.announceChanges(vault.id, added);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  // --- personas (ADR-0088, E3) ----------------------------------------

  /** The loader over the detected vault's host reads — one seam for every persona read. */
  private personaLoaderFor(vault: EngineVault) {
    return personaLoader((rel) => this.host.read(vault.id, rel));
  }

  /**
   * The persona directory listing (E3): every
   * `tickets/_meta/personas/<id>/persona.md` parsed through the loader,
   * sorted by id; [] when no personas live in the vault.
   */
  async listPersonas(): Promise<readonly Persona[]> {
    const vault = await this.detect();
    if (vault === null) {
      return [];
    }
    const loader = this.personaLoaderFor(vault);
    const files = await this.host.listMarkdownFiles(vault.id);
    const ids: string[] = [];
    for (const file of files) {
      const match = /^tickets\/_meta\/personas\/([a-z0-9][a-z0-9-]{0,63})\/persona\.md$/.exec(file);
      if (match !== null) {
        ids.push(match[1]!);
      }
    }
    ids.sort();
    const personas: Persona[] = [];
    for (const id of ids) {
      const persona = await loader.load(id);
      if (persona !== null) {
        personas.push(persona);
      }
    }
    return personas;
  }

  /** The persona directory's ids (the improvement loop's sweep list). */
  async listPersonaIds(): Promise<readonly string[]> {
    const personas = await this.listPersonas();
    return personas.map((p) => p.id);
  }

  /**
   * The fleet ledger's raw text (`tickets/_meta/ledger.jsonl`); null
   * without a vault or a ledger — the aggregation happens at the callers
   * (the port's persona day costs), the service only reads the vault file.
   */
  async ledgerText(): Promise<string | null> {
    const vault = await this.detect();
    if (vault === null) {
      return null;
    }
    return this.readOptional(vault.id, LEDGER_FILE);
  }

  /**
   * The confirmed memory entry (E3 acceptance): one owner-confirmed
   * lesson appended to the persona's memory.md — the same store the
   * fleet's settle path writes through. Refuses unknown persona ids;
   * exactly one commit `personas: <id> memory +1` (a commit failure is
   * the usual warning, never a lost entry).
   */
  personaLearn(input: { id: string; entry: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      let id: string;
      try {
        id = personaRef(input.id);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const loader = this.personaLoaderFor(vault);
      if ((await loader.load(id)) === null) {
        return { ok: false, error: `persona "${id}" does not exist — create tickets/_meta/personas/${id}/persona.md first` };
      }
      // One line, always: flatten what the dialog sent, bounded.
      const entry = oneMemoryLine(input.entry);
      if (entry === '') {
        return { ok: false, error: 'a memory entry is one non-empty line' };
      }
      const path = memoryPathFor(id);
      try {
        await appendMemory(
          (rel) => this.host.read(vault.id, rel),
          (rel, text) => this.host.write(vault.id, rel, text),
          id,
          entry,
        );
      } catch (error) {
        return { ok: false, error: `memory write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [path], `personas: ${id} memory +1`);
      this.host.announceChanges(vault.id, [path]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  // --- persona chat, memory read/pin, setup patch (U4, concept §4.4/§4.5) ---

  /**
   * The persona chat's read (U4, concept §4.5): the coaching thread's
   * owner messages, file order. A thread that does not exist yet reads as
   * no messages — the persona exists, the conversation just never started.
   */
  async personaThread(personaId: string): Promise<PersonaThreadReply> {
    let id: string;
    try {
      id = personaRef(personaId);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    const vault = await this.detect();
    if (vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    if ((await this.personaLoaderFor(vault).load(id)) === null) {
      return { ok: false, error: personaMissing(id) };
    }
    const text = await this.readOptional(vault.id, threadPathFor(id));
    return { ok: true, messages: parseThread(text ?? '') };
  }

  /**
   * One owner message into the coaching thread (U4): appended as exactly
   * one line (a file is created chat-session style when absent), one
   * commit `personas: <id> thread` — the next run's `## Coaching` slice
   * reads it back.
   */
  personaThreadAppend(input: { id: string; text: string; actor?: string }): Promise<PersonaThreadReply> {
    return this.enqueue(async () => {
      let id: string;
      try {
        id = personaRef(input.id);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const persona = await this.personaLoaderFor(vault).load(id);
      if (persona === null) {
        return { ok: false, error: personaMissing(id) };
      }
      const path = threadPathFor(id);
      let updated: string;
      try {
        const existing = await this.readOptional(vault.id, path);
        const base = existing ?? newThreadText(persona.title, new Date());
        updated = appendThreadOwner(base, new Date(), input.text);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        await this.host.write(vault.id, path, updated);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [path], `personas: ${id} thread`);
      this.host.announceChanges(vault.id, [path]);
      this.announceChanged();
      return { ok: true, messages: parseThread(updated), ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The persona memory's read (U4, concept §4.4): the curated entries in
   * file order, each with its pin state — the same lines the context
   * pack's `## Memory` slice picks from, so an index here is the index
   * everywhere.
   */
  async personaMemory(personaId: string): Promise<PersonaMemoryReply> {
    let id: string;
    try {
      id = personaRef(personaId);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    const vault = await this.detect();
    if (vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    if ((await this.personaLoaderFor(vault).load(id)) === null) {
      return { ok: false, error: personaMissing(id) };
    }
    const text = await this.readOptional(vault.id, memoryPathFor(id));
    return { ok: true, entries: parseMemoryEntries(text ?? '') };
  }

  /**
   * One owner-taught memory entry (U4): appended through the persona
   * store's path (the one writer), flattened to one line, one commit
   * `personas: <id> memory entry`.
   */
  personaMemoryAppend(input: { id: string; text: string }): Promise<PersonaMemoryReply> {
    return this.enqueue(async () => {
      let id: string;
      try {
        id = personaRef(input.id);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      if ((await this.personaLoaderFor(vault).load(id)) === null) {
        return { ok: false, error: personaMissing(id) };
      }
      const entry = oneMemoryLine(input.text);
      if (entry === '') {
        return { ok: false, error: 'a memory entry is one non-empty line' };
      }
      const path = memoryPathFor(id);
      try {
        await appendMemory(
          (rel) => this.host.read(vault.id, rel),
          (rel, text) => this.host.write(vault.id, rel, text),
          id,
          entry,
        );
      } catch (error) {
        return { ok: false, error: `memory write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [path], `personas: ${id} memory entry`);
      this.host.announceChanges(vault.id, [path]);
      this.announceChanged();
      const text = await this.readOptional(vault.id, path);
      return { ok: true, entries: parseMemoryEntries(text ?? ''), ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The pin toggle (U4, concept §4.4 — "gepflegtes Asset"): the entry at
   * `index` (its position in {@link personaMemory}'s list) gains or loses
   * its trailing ` [pinned]` marker, one commit
   * `personas: <id> memory pinned|unpinned`. An out-of-range index
   * refuses with a readable error — never a silent no-op.
   */
  personaMemoryPin(input: { id: string; index: number; pinned: boolean }): Promise<PersonaMemoryReply> {
    return this.enqueue(async () => {
      let id: string;
      try {
        id = personaRef(input.id);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      if ((await this.personaLoaderFor(vault).load(id)) === null) {
        return { ok: false, error: personaMissing(id) };
      }
      if (!Number.isInteger(input.index) || input.index < 0) {
        return { ok: false, error: "the index is the entry's position in the GET list (0-based)" };
      }
      const path = memoryPathFor(id);
      const text = await this.readOptional(vault.id, path);
      if (text === null || text.trim() === '') {
        return { ok: false, error: `persona "${id}" has no memory entries yet` };
      }
      const updated = toggleMemoryPin(text, input.index, input.pinned);
      if (updated === null) {
        return { ok: false, error: `no memory entry at index ${input.index}` };
      }
      try {
        await this.host.write(vault.id, path, updated);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [path], `personas: ${id} memory ${input.pinned ? 'pinned' : 'unpinned'}`);
      this.host.announceChanges(vault.id, [path]);
      this.announceChanged();
      return { ok: true, entries: parseMemoryEntries(updated), ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The persona setup's PATCH (U4, concept §4.5 — the mirror to check,
   * the chat stays the primary way): only the sent keys are written onto
   * the parsed persona, the file rebuilt over `personaFileText` (the
   * owner's prose below the fence rides along), `prompt` additionally to
   * prompt.md — exactly one commit `personas: <id> updated` for both.
   */
  personaPatch(input: {
    id: string;
    title?: string;
    role?: string;
    worker?: string;
    model?: string;
    pool?: readonly string[];
    router?: string;
    color?: string;
    skills?: readonly string[];
    prompt?: string;
  }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      let id: string;
      try {
        id = personaRef(input.id);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      if ((await this.personaLoaderFor(vault).load(id)) === null) {
        return { ok: false, error: personaMissing(id) };
      }
      const refusal = personaPatchError(input);
      if (refusal !== null) {
        return { ok: false, error: refusal };
      }
      const sent = (key: string): boolean =>
        input[key as 'title' | 'role' | 'worker' | 'model' | 'pool' | 'router' | 'color' | 'skills' | 'prompt'] !== undefined;
      if (!['title', 'role', 'worker', 'model', 'pool', 'router', 'color', 'skills', 'prompt'].some(sent)) {
        return { ok: true }; // nothing to change
      }
      const personaPath = `${PERSONAS_DIR}/${id}/persona.md`;
      const current = await this.host.read(vault.id, personaPath);
      const { body, hadFence } = splitFrontmatter(current);
      const persona = parsePersonaFile(id, current);
      const next: Persona = {
        ...persona,
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.role !== undefined ? { role: input.role as Persona['role'] } : {}),
        ...(input.worker !== undefined ? { worker: input.worker.trim() } : {}),
        ...(input.model !== undefined || input.pool !== undefined || input.router !== undefined
          ? {
              models: {
                default: input.model !== undefined ? input.model.trim() : persona.models.default,
                pool: input.pool !== undefined ? input.pool.map((m) => m.trim()) : persona.models.pool,
                router: input.router !== undefined ? (input.router as PersonaRouter) : persona.models.router,
              },
            }
          : {}),
        ...(input.color !== undefined ? { color: input.color.trim() } : {}),
        ...(input.skills !== undefined ? { skills: input.skills.map((s) => s.trim()) } : {}),
      };
      const patched = personaFileText(next, hadFence ? body : undefined);
      const touched = [personaPath];
      try {
        await this.host.write(vault.id, personaPath, patched);
        if (input.prompt !== undefined) {
          const promptPath = `${PERSONAS_DIR}/${id}/prompt.md`;
          await this.host.write(vault.id, promptPath, input.prompt);
          touched.push(promptPath);
        }
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, touched, `personas: ${id} updated`);
      this.host.announceChanges(vault.id, touched);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The legacy column-key migration (E3, idempotent — the marker is the
   * absence of the legacy keys themselves): a pipeline phase still
   * carrying `worker:`/`model:`/`prompt:` keys is the pre-persona world.
   * Each such phase's configuration becomes a persona directory
   * (`persona.md` + `prompt.md`, the prompt text from
   * `_meta/prompts/<ref>.md` when that file exists, else an empty
   * prompt.md) and the phase rewrites to `persona: <id>` through
   * `patchPipelinePhase` — the legacy keys go, the `handover:` stays, so
   * the column keeps draining itself, now through the persona. Exactly
   * one commit `tickets: personas migrated`. Passes where every derived
   * persona already exists leave the owner's files alone. A failure
   * logs and leaves the board refresh unscathed.
   */
  private migrateLegacyPersonas(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const vault = await this.detect();
        if (vault === null) {
          return;
        }
        const pipelineText = await this.readOptional(vault.id, PIPELINE_PATH);
        if (pipelineText === null) {
          return;
        }
        const { phases } = parsePipeline(pipelineText);
        const legacy = phases.filter((p) => p.worker !== null || p.model !== null || p.prompt !== null);
        if (legacy.length === 0) {
          return; // nothing carries the old keys — the migration is done (or never needed)
        }
        const candidates = new Map<string, { readonly phaseId: string; readonly migration: PersonaMigration }>();
        for (const phase of legacy) {
          const migration = personaMigrationFor({ phaseId: phase.id, worker: phase.worker, model: phase.model, prompt: phase.prompt });
          if (migration !== null && !candidates.has(migration.id)) {
            candidates.set(migration.id, { phaseId: phase.id, migration });
          }
        }
        if (candidates.size === 0) {
          return;
        }
        const loader = this.personaLoaderFor(vault);
        const missing: PersonaMigration[] = [];
        for (const { migration } of candidates.values()) {
          if ((await loader.load(migration.id)) === null) {
            missing.push(migration);
          }
        }
        if (missing.length === 0) {
          return; // every derived persona exists — the owner's state stays as written
        }
        const written: string[] = [];
        for (const migration of missing) {
          const persona: Persona = {
            id: migration.id,
            title: migration.title,
            role: 'custom',
            worker: migration.worker,
            models: { default: migration.model ?? 'opus', pool: [migration.model ?? 'opus'], router: 'off' },
            color: '#a78bfa',
            skills: [],
            budget: null,
          };
          const personaPath = `${PERSONAS_DIR}/${migration.id}/persona.md`;
          await this.host.write(vault.id, personaPath, personaFileText(persona));
          written.push(personaPath);
          const promptText =
            migration.promptRef !== null
              ? await this.readOptional(vault.id, `${PROMPTS_DIR}/${migration.promptRef}.md`)
              : null;
          const promptPath = `${PERSONAS_DIR}/${migration.id}/prompt.md`;
          await this.host.write(vault.id, promptPath, promptText ?? '');
          written.push(promptPath);
        }
        // Every candidate phase rewrites — including those whose persona
        // already existed (their keys are still the old world).
        let patched = pipelineText;
        for (const { phaseId, migration } of candidates.values()) {
          patched = patchPipelinePhase(patched, phaseId, { persona: migration.id });
        }
        await this.host.write(vault.id, PIPELINE_PATH, patched);
        await this.commit(vault, [PIPELINE_PATH, ...written], 'tickets: personas migrated');
        this.host.announceChanges(vault.id, [PIPELINE_PATH, ...written]);
        this.announceChanged();
      } catch (error) {
        this.host.log(`persona migration failed: ${messageOf(error)}`, 'warn');
      }
    });
  }

  // --- the self-improvement loop (E6, concept §4.8) ---------------------

  /**
   * The E6 improvements card's data (concept §4.8): the persona's
   * improvements.md parsed tolerant-reader style, plus the open count
   * (the 1:1's work) and the friction count (findings still waiting for
   * an aggregation). A read — outside the single-writer queue; the
   * persona must exist, everything else tolerates absence.
   */
  async personaImprovements(personaId: string): Promise<PersonaImprovementsReply> {
    let id: string;
    try {
      id = personaRef(personaId);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    const vault = await this.detect();
    if (vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const persona = await this.personaLoaderFor(vault).load(id);
    if (persona === null) {
      return { ok: false, error: `persona "${id}" does not exist — create tickets/_meta/personas/${id}/persona.md first` };
    }
    const [improvementsText, frictionText] = await Promise.all([
      this.readOptional(vault.id, improvementsPathFor(id)),
      this.readOptional(vault.id, frictionPathFor(id)),
    ]);
    const proposals = parseImprovements(improvementsText ?? '').proposals;
    return {
      ok: true,
      persona,
      proposals,
      openCount: proposals.filter((p) => p.state === 'open').length,
      frictionCount: parseFriction(frictionText ?? '').length,
    };
  }

  /**
   * The aggregation's input (E6): the persona's raw friction findings,
   * the last aggregation stamp, and how many of this persona's fleet
   * records started since then (0 when never aggregated). A read —
   * tolerant everywhere, so an unknown persona or a missing vault reads
   * as an empty input rather than an error.
   */
  async improvementInput(personaId: string): Promise<ImprovementInput> {
    let id: string;
    try {
      id = personaRef(personaId);
    } catch {
      return { friction: [], lastAggregation: null, settledRuns: 0 };
    }
    const vault = await this.detect();
    if (vault === null) {
      return { friction: [], lastAggregation: null, settledRuns: 0 };
    }
    const [improvementsText, frictionText, runs] = await Promise.all([
      this.readOptional(vault.id, improvementsPathFor(id)),
      this.readOptional(vault.id, frictionPathFor(id)),
      this.fleetRecords().catch(() => [] as readonly RunInfo[]),
    ]);
    const lastAggregation = parseImprovements(improvementsText ?? '').lastAggregation;
    const settledRuns =
      lastAggregation === null
        ? 0
        : runs.filter((run) => (run.persona ?? null) === id && run.startedAt > lastAggregation).length;
    return { friction: parseFriction(frictionText ?? ''), lastAggregation, settledRuns };
  }

  /**
   * The aggregation's write (E6): the validated drafts become open
   * proposals — ids minted from the file (`imp-<n>`, never reused), one
   * strict re-render, lastAggregation stamped — and friction.md
   * truncates to its heading, the findings having moved into the
   * evidence. Exactly one commit `personas: <id> improvements +<n>`,
   * then the announcement.
   */
  applyAggregation(input: { id: string; drafts: readonly ImprovementDraft[]; now?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      let id: string;
      try {
        id = personaRef(input.id);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      if ((await this.personaLoaderFor(vault).load(id)) === null) {
        return { ok: false, error: `persona "${id}" does not exist — create tickets/_meta/personas/${id}/persona.md first` };
      }
      if (input.drafts.length === 0) {
        return { ok: true }; // nothing to aggregate — the files stay exactly as they are
      }
      const at = input.now ?? new Date().toISOString();
      const improvementsPath = improvementsPathFor(id);
      const existingText = (await this.readOptional(vault.id, improvementsPath)) ?? '';
      const file = parseImprovements(existingText);
      // The mint scans the raw text: even a hand-broken proposal's id is
      // never reused. The queue serializes, so the running max suffices.
      let next = Number(nextImprovementId(existingText).slice('imp-'.length));
      const added: ImprovementProposal[] = input.drafts.map((draft) => ({
        id: `imp-${next++}`,
        state: 'open',
        target: draft.target,
        title: draft.title,
        evidence: [...draft.evidence],
        content: draft.content,
        lesson: draft.lesson,
        at,
        decidedAt: null,
      }));
      const frictionPath = frictionPathFor(id);
      const frictionText = await this.readOptional(vault.id, frictionPath);
      const touched = [improvementsPath];
      try {
        await this.host.write(vault.id, improvementsPath, renderImprovements(id, { lastAggregation: at, proposals: [...file.proposals, ...added] }));
        if (frictionText !== null) {
          await this.host.write(vault.id, frictionPath, frictionHeadingOnly(frictionText));
          touched.push(frictionPath);
        }
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, touched, `personas: ${id} improvements +${added.length}`);
      this.host.announceChanges(vault.id, touched);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The 1:1's decision (E6): an open proposal is accepted (the target
   * applies — prompt.md rewritten, models.default patched through the
   * yaml doc-mutation, memory appended as one line) or dismissed; a
   * non-null lesson lands in memory.md either way. Unknown or already
   * decided proposals refuse with a readable error; exactly one commit
   * `personas: <id> improvement <accepted|dismissed> (<proposalId>)`.
   */
  decideImprovement(input: { id: string; proposalId: string; decision: ImprovementDecision; now?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      let id: string;
      try {
        id = personaRef(input.id);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      if ((await this.personaLoaderFor(vault).load(id)) === null) {
        return { ok: false, error: `persona "${id}" does not exist — create tickets/_meta/personas/${id}/persona.md first` };
      }
      const improvementsPath = improvementsPathFor(id);
      const file = parseImprovements((await this.readOptional(vault.id, improvementsPath)) ?? '');
      const proposal = file.proposals.find((p) => p.id === input.proposalId) ?? null;
      if (proposal === null) {
        return { ok: false, error: `${input.proposalId} is not one of ${id}'s improvement proposals` };
      }
      if (proposal.state !== 'open') {
        return { ok: false, error: `${input.proposalId} is already ${proposal.state}` };
      }
      const at = input.now ?? new Date().toISOString();
      const touched = new Set<string>([improvementsPath]);
      const appendLesson = async (line: string): Promise<string | null> => {
        try {
          const flattened = oneMemoryLine(line);
          // The memory file is a bullet list — the line carries its own marker.
          await appendMemory(
            (rel) => this.host.read(vault.id, rel),
            (rel, text) => this.host.write(vault.id, rel, text),
            id,
            flattened.startsWith('- ') ? flattened : `- ${flattened}`,
          );
          touched.add(memoryPathFor(id));
          return null;
        } catch (error) {
          return `memory write failed: ${messageOf(error)}`;
        }
      };
      if (input.decision === 'accepted') {
        try {
          if (proposal.target === 'prompt.md') {
            const promptPath = `${PERSONAS_DIR}/${id}/prompt.md`;
            await this.host.write(vault.id, promptPath, proposal.content);
            touched.add(promptPath);
          } else if (proposal.target === 'models.default') {
            const personaPath = `${PERSONAS_DIR}/${id}/persona.md`;
            const patched = patchPersonaDefaultModel(await this.host.read(vault.id, personaPath), proposal.content);
            await this.host.write(vault.id, personaPath, patched);
            touched.add(personaPath);
          } else {
            const failure = await appendLesson(proposal.content);
            if (failure !== null) {
              return { ok: false, error: failure };
            }
          }
        } catch (error) {
          return { ok: false, error: `write failed: ${messageOf(error)}` };
        }
      }
      if (proposal.lesson !== null) {
        const failure = await appendLesson(proposal.lesson);
        if (failure !== null) {
          return { ok: false, error: failure };
        }
      }
      const decided: ImprovementProposal = { ...proposal, state: input.decision, decidedAt: at };
      const paths = [...touched];
      try {
        await this.host.write(
          vault.id,
          improvementsPath,
          renderImprovements(id, { lastAggregation: file.lastAggregation, proposals: file.proposals.map((p) => (p.id === decided.id ? decided : p)) }),
        );
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, paths, `personas: ${id} improvement ${input.decision} (${proposal.id})`);
      this.host.announceChanges(vault.id, paths);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The repositories settings listing (req-72): `_meta/repos.md`'s
   * entries exactly as they parse, the file's path for display.
   */
  async listRepos(): Promise<ReposListing> {
    const vault = await this.detect();
    if (vault === null) {
      return { file: null, repos: [], error: null };
    }
    const text = await this.readOptional(vault.id, REPOS_PATH);
    const parse = parseRepos(text);
    return {
      file: this.host.resolveAssetPath(vault.id, REPOS_PATH),
      repos: parse.repos,
      error: parse.error,
    };
  }

  /**
   * Writes `repos.md` from the settings page's entries (req-72): the
   * frontmatter regenerated, the owner's prose kept, one commit.
   */
  saveRepos(repos: readonly RepoRef[]): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const names = new Set<string>();
      for (const repo of repos) {
        if (repo.name.trim() === '') {
          return { ok: false, error: 'a repository needs a name' };
        }
        if (names.has(repo.name)) {
          return { ok: false, error: `two repositories named "${repo.name}"` };
        }
        names.add(repo.name);
        if (repo.url.trim() === '') {
          return { ok: false, error: `"${repo.name}" needs a url` };
        }
      }
      const before = await this.readOptional(vault.id, REPOS_PATH);
      const text = reposFileText(repos, reposProse(before));
      if (before === text) {
        return { ok: true };
      }
      try {
        await this.host.write(vault.id, REPOS_PATH, text);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [REPOS_PATH], 'tickets: repos.md update');
      this.host.announceChanges(vault.id, [REPOS_PATH]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /** The native directory picker behind "Add from folder" (req-72) — the host's native dialog. */
  async pickFolder(): Promise<{ ok: boolean; path?: string }> {
    const chosen = await this.host.pickFolder('Folder with repositories');
    return chosen === null ? { ok: true } : { ok: true, path: chosen };
  }

  /** Probes a folder for git repositories (req-72) — the "Add from folder" seeds. */
  async scanRepos(folder: string): Promise<{ ok: true; candidates: readonly RepoCandidate[] } | { ok: false; error: string }> {
    try {
      const outcome = await scanRepoFolder(folder, (cwd, args) => this.git.run(cwd, args));
      return { ok: true, candidates: outcome.candidates };
    } catch (error) {
      return { ok: false, error: `the scan failed: ${messageOf(error)}` };
    }
  }

  /**
   * Every registered vault that carries a board (req-72): the projects —
   * one tickets repository each. The active one is what `detect()` picks:
   * the configured vault when it has a board, else the first that does.
   */
  async listProjects(): Promise<readonly ProjectRef[]> {
    const vaults = (await this.host.listVaults()).filter((v) => v.exists);
    const configured = await this.host.configGet<string>('vaultId');
    const ordered =
      configured === undefined
        ? vaults
        : [...vaults.filter((v) => v.id === configured), ...vaults.filter((v) => v.id !== configured)];
    const projects: ProjectRef[] = [];
    let activeSeen = false;
    for (const vault of ordered) {
      if ((await this.readOptional(vault.id, PIPELINE_PATH)) === null) {
        continue;
      }
      const active = !activeSeen;
      activeSeen = true;
      projects.push({ id: vault.id, name: vault.name, path: vault.path, active });
    }
    return projects;
  }

  /** Makes another project's board the active one (req-72); one config key. */
  async switchProject(id: string): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = (await this.host.listVaults()).find((v) => v.id === id && v.exists);
      if (vault === undefined) {
        return { ok: false, error: 'no such vault' };
      }
      if ((await this.readOptional(id, PIPELINE_PATH)) === null) {
        return { ok: false, error: `"${vault.name}" holds no tickets board — tickets/_meta/pipeline.md is missing` };
      }
      await this.host.configSet('vaultId', id);
      this.announceChanged();
      return { ok: true };
    });
  }

  /** Opens `_meta/prompts/` (or the tickets folder) in the OS file manager. */
  async openTicketsFolder(which: 'tickets' | 'prompts'): Promise<BoardMutationResult> {
    const vault = await this.detect();
    if (vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const dir = this.host.resolveAssetPath(vault.id, which === 'prompts' ? PROMPTS_DIR : 'tickets');
    if (dir === null) {
      return { ok: false, error: 'the folder is outside the vault' };
    }
    await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
    const failure = await this.host.revealPath(dir);
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
    const root = this.host.resolveAssetPath(vault.id, 'tickets');
    return {
      root,
      moves: planFolderNumbering(await this.ticketDirs(vault), snap.pipeline.map((p) => p.id)),
    };
  }

  /** "Number folders": the renumbering alone, one commit (req-50). */
  numberFolders(): Promise<BoardMutationResult> {
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
  reorderPhases(order: readonly string[]): Promise<BoardMutationResult> {
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

  /**
   * The settings page's column editor: add, rename or remove a phase in
   * `_meta/pipeline.md`, one commit each. A rename changes the title only
   * (the id, the folder and every ticket stay); an add writes a manual
   * phase whose folder appears on first use; a remove is refused while
   * tickets sit in the phase, so none is orphaned.
   */
  editPhase(
    input:
      | { op: 'add'; title: string; afterId?: string | null }
      | { op: 'rename'; phase: string; title: string }
      | { op: 'remove'; phase: string },
  ): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const text = await this.readOptional(vault.id, PIPELINE_PATH);
      if (text === null) {
        return { ok: false, error: 'tickets/_meta/pipeline.md is missing' };
      }
      const snap = await this.snapshot();
      let patched: string;
      let message: string;
      try {
        if (input.op === 'add') {
          const added = addPipelinePhase(text, { title: input.title, afterId: input.afterId ?? null });
          patched = added.text;
          message = `tickets: add phase ${added.id}`;
        } else if (input.op === 'rename') {
          patched = renamePipelinePhase(text, input.phase, input.title);
          message = `tickets: rename phase ${input.phase}`;
        } else {
          const column = snap.columns.find((c) => c.phase.id === input.phase);
          const count = column?.tickets.length ?? 0;
          if (count > 0) {
            return {
              ok: false,
              error: `${count} ticket${count === 1 ? '' : 's'} still in "${column?.phase.title ?? input.phase}" — move ${count === 1 ? 'it' : 'them'} to another column first`,
            };
          }
          patched = removePipelinePhase(text, input.phase);
          message = `tickets: remove phase ${input.phase}`;
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        await this.host.write(vault.id, PIPELINE_PATH, patched);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(vault, [PIPELINE_PATH], message);
      this.host.announceChanges(vault.id, [PIPELINE_PATH]);
      this.announceChanged();
      return warning === null ? { ok: true } : { ok: true, warning };
    });
  }

  /** The shared body of reorder and "Number folders"; runs inside the queue. */
  private async renumber(
    vault: EngineVault,
    snap: BoardSnapshot,
    order: readonly string[],
    pipelineText: string | null,
    message: string,
  ): Promise<BoardMutationResult> {
    const root = this.host.resolveAssetPath(vault.id, 'tickets');
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
        await this.host.write(vault.id, PIPELINE_PATH, pipelineText);
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
        this.host.log(warning, 'warn');
      }
    }
    this.host.announceChanges(vault.id, paths);
    this.announceChanged();
    return {
      ok: true,
      moved: moves.length,
      ...(warning === null ? {} : { warning }),
    };
  }

  initialize(vaultId: string | null): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const vaults = await this.host.listVaults();
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
        await this.host.write(target.id, PIPELINE_PATH, DEFAULT_PIPELINE);
        await this.host.write(target.id, REPOS_PATH, DEFAULT_REPOS);
        for (const [ref, text] of shipped) {
          await this.host.write(target.id, `${PROMPTS_DIR}/${ref}.md`, text);
        }
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      // The worktrees base is ignored from day one (ADR-0080: ensured,
      // not documented — one own commit when it changes something).
      await this.ensureWorktreesIgnored(target);
      const warning = await this.commit(
        target,
        [PIPELINE_PATH, REPOS_PATH, ...promptPaths],
        'tickets: initialize board',
      );
      this.host.announceChanges(target.id, [PIPELINE_PATH, REPOS_PATH, ...promptPaths]);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  onVaultEvent(event: EngineVaultChangeEvent): void {
    // A registry round may have moved the tickets vault itself.
    if (event.vaultId === undefined && event.kind === 'refresh') {
      this.gitLocations.clear();
    }
    this.announceChanged();
  }
}