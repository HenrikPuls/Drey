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
import { archivedTicketIds, nextTicketId, TICKETS_ARCHIVE_DIR, TICKET_ID_PATTERN, type BoardSnapshot, type RecentDone, FolderStatus, PipelinePhase, ProjectRef, PromptEntry, PromptListing, RepoCandidate, RepoRef, ReposListing, TicketCard, TicketForm, TicketPriority, TicketTrack } from '../contracts/tickets';
import { parseChanges, parseResult, planApprovedOf, storyOf, type ChangesReply } from '../contracts/changes';
import { type RefineReply, TicketReply, AttachmentReply, type DocumentSaveReply, type TicketDocumentLocation } from '../contracts/replies';
import { documentRelPath, idOfDocumentPath } from '../store/document-paths';
import { detailFromContent } from '../store/dricket-ticket-store';
import { assembleBoard, parseRepos, addPipelinePhase, patchPipelinePhase, removePipelinePhase, renamePipelinePhase, parsePipeline, reorderPipelinePhases, reposFileText, reposProse } from '../core/ticket-board';
import { newTicketFileText, parseTicketFile, patchTicketFile, patchBlockedBy, patchChain, patchForm, patchTrack, ticketPathParts, withLogLine } from '../core/ticket-files';
import { withPlanSection } from '../core/plan-section';
import { applyFlowOp, type FlowOp } from '../core/flow-edit';
import type { FlowReply, FlowSaveReply, FlowStepView, FlowTarget, FlowScope } from '../contracts/flow';
import { isManualPhase, MANUAL_PHASE, MANUAL_TITLE, mergeChain, parseChainEntry, renderChainEntries, validateChain } from '../core/chain-delta';
import { deletePlanPart, movePlanPart, parsePlanParts, partChainEntries, withPlanParts, type PlanPart } from '../core/plan-parts';
import { blockerOf, indicesToMint, lockedIndices, matchPartTickets, partStateOf, partTicketText, releaseLogText, startLineOf, type PartTicket } from '../core/plan-release';
import type { PlanPartCard, PlanPartsEdit, PlanPartsReply, PlanReleaseReply, PlanReleaseScope } from '../contracts/plan-approval';
import type { ChainEntry } from '../contracts/chain';
import { refineTicket, revisionOf } from '../core/ticket-refine';
import { applyFolderNumbering, listTicketDirs, planFolderNumbering, resolvePhaseDir } from '../core/phase-dirs';
import { archivedEntriesOf, detectDrift, recentDoneOf, type DriftDetection } from '../core/normalize';
import { blockedRefusal } from '../core/blocked';
import { runTransition, type TransitionIo } from '../core/transition';
import { openStatusItems, parseStatusLog, type StatusLine, type StatusVerb } from '../core/status-log';
import { commentViewsOf, renderStatusComment, slugStatusKey, statusLinesOfComments, type TicketCommentView } from '../core/status-comment';
import { LEDGER_FILE, parseLedger, settledUsageByTicket, type LedgerWrite } from '../core/ledger';
import { estimateFrom, type EstimateKey, type RunEstimate } from '../core/estimate';
import { withReviewFeedback, type ReviewComment } from '../core/review-feedback';
import { parseVerlaufEntries, type VerlaufEntry } from '../core/verlauf';
import { mergeWorktreeChanges, diffOfOutput, isSafeRepoPath, MAX_FILE_VIEW_BYTES, type TicketDiff, type TicketFileReply, type WorktreeFile } from '../core/worktree-changes';
import { planWorktreeRemoval } from '../core/worktree-removal';
import { TicketsGit, type RepoLocation } from '../core/tickets-git';
import { TicketStoreError } from '../ports/ticket-store';
import { FileTicketStore } from '../store/file-ticket-store';
import { checkoutOf, createDricketStore, groupByStage, readStoreSettings, type StoreListing, type StoreSettings } from '../store/store-settings';
import { archivedRecordFiles, recordToBoardFile } from '../store/store-board';
import type { TicketDetail } from '../ports/ticket-store';
import { ARCHIVED_LABEL, type BridgeOptions } from '../store/legacy-bridge';
import { StoreBoardSource } from '../store/store-board-source';
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
import { dkTargetFor, retreatStages } from '../fleet/dk-target';
import { type ChainConfig, type ChainStoreConfig, FleetCaps, FleetHandoverConfig, HandoverMode, InteractiveMode, PermissionMode, RunDkTarget, RunInfo, FleetPools } from '../fleet/protocol';
import { type EngineHost, type EngineVaultChangeEvent, EngineVault, FleetPort } from './host';
import { handoverFromConfig, handoverOverrideKeys } from './handover-config';
import { appendMemory, memoryPathFor, parseMemoryEntries, toggleMemoryPin } from './persona-store';
import { HUMAN_PERSONA_ID, humanPersona, isHumanPersona, personaFileText, personaMigrationFor, parsePersonaFile, personaRef, PERSONAS_DIR, PERSONA_ROLES, type Persona, type PersonaMigration, type PersonaRouter } from '../core/persona';
import { appendThreadOwner, newThreadText, parseThread, threadPathFor } from '../core/persona-thread';
import { scanRepoFolder } from './repos-scan';

const PIPELINE_PATH = 'tickets/_meta/pipeline.md';
const REPOS_PATH = 'tickets/_meta/repos.md';
const ATTACHMENTS_DIR = 'tickets/attachments';
/** Names a shape turn's repository read never opens: git internals, dependency folders, secrets. */
const REPO_READ_DENIED = /^(\.git|node_modules|\.env.*|\.ssh|.*\.(pem|key))$/i;
const PROMPTS_DIR = 'tickets/_meta/prompts';
const PROMPT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLAN_INTERACTIVE_PROMPT = 'plan-interactive-default';
const DEFAULT_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual, persona: you }
  - { id: plan, title: Plan, claim: true, handover: agent plan-default }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }
  - { id: review, title: Review, handover: manual, persona: you }
  - { id: sign-off, title: Sign Off, handover: manual, persona: you }
  - { id: done, title: Done, handover: none }
---
The pipeline: ordered phases (first = capture target, last = terminal),
configurable per handover (manual | agent <prompt-ref> | ci | none).
Inbox is the owner's triage queue: move a ticket into Plan when it is
worth planning. Plan and Build are worked by agents; the columns the
human persona works carry persona: you (its name is configurable) -
Inbox, Review and Sign Off. Review and Sign Off are the owner's
checkpoints (Sign Off is where the work is committed: merged and pushed). See specs/ticket-schema.md.
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
/** The flow editor's frame (E10-5): the chain being edited and where it flows from. */
interface FlowFrame {
  readonly vault: EngineVault;
  readonly card: TicketCard;
  readonly text: string;
  readonly snap: BoardSnapshot;
  readonly phases: readonly { readonly id: string; readonly title: string }[];
  readonly title: string;
  readonly scope: FlowScope;
  readonly currentId: string;
  readonly saved: readonly ChainEntry[];
  /** Who builds: the ticket's pin or the part's builder; null = the pipeline decides. */
  readonly builder: string | null;
  readonly part: PlanPart | null;
  readonly readOnly: string | null;
}

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
    return 'the worker is not empty ("opencode", "claude-code", "kimi" or "api")';
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
  /** The ticket's status log (E7); the manual step's finish writes its line here (E10-6). */
  readonly status?: (cardPath: string, at: string, verb: StatusVerb, payload: string) => void;
}

/** The optional construction extras (E7); the default keeps every existing call site. */
export interface BoardServiceOptions {
  /** The fleet ledger writes behind the board's lifecycle events; absent = silent no-op. */
  readonly events?: LedgerEvents;
}

/** A dricket write that met a ticket changed in the meantime (dk exit 12): nothing was written, the caller asks the user. */
/** What `dk add` writes as the description of a ticket nobody has filled yet. */
const DK_EMPTY_DESCRIPTION = '(no description)';

export class TicketChangedError extends Error {
  constructor(id: string) {
    super(`${id} changed in the meantime — nothing was written. Reload it and edit again.`);
    this.name = 'TicketChangedError';
  }
}

export class EngineBoardService {
  private queueTail: Promise<unknown> = Promise.resolve();
  private readonly gitLocations = new Map<string, RepoLocation | null>();
  private emitDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Who hears the debounced board change besides the renderer (the remote, req-66). */
  private readonly changeListeners = new Set<() => void>();
  private lastChainConfig: string | null = null;
  /** The dricket-backed board and the shadow comparison (E14-2); idle while `tickets.backend` is `files`. */
  private readonly storeBoard: StoreBoardSource;
  /** E14-4b: the store settings while the board runs on dricket (set by every snapshot), else null: tickets are then read and written through the store, never as vault files. */
  private dricket: StoreSettings | null = null;
  /** E14-4b: the record each board mutation read (ticket id -> record), so its write carries the rev it was made on. Refreshed by every read inside the queue. */
  private readonly records = new Map<string, TicketDetail>();

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
  ) {
    this.storeBoard = new StoreBoardSource(path.join(host.userRoot, 'shadow'), (message, level) => host.log(message, level), undefined, createDricketStore, {
      // E14-4: the store's own writes, its file watcher and the remote sync round announce a changed board.
      onChange: () => this.announceChanged(),
    });
  }

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

  /** Stops the store's file watcher and sync round (the engine is shutting down). */
  dispose(): void {
    this.storeBoard.dispose();
  }

  /** After {@link dispose}: resolves when the store's background processes ended (see `StoreBoardSource.idle`). */
  idle(): Promise<void> {
    return this.storeBoard.idle();
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
    const common = {
      vaultId: vault.id,
      vaultName: vault.name,
      activeVaultName: active?.name ?? null,
      isGitRepo: location !== null,
      defaultWorker: this.defaultWorker,
      pipelineText,
      reposText,
      // The settled runs' usage (concept §4.3): one vault-file read, the
      // pure assembly only attaches the sums to the matching cards.
      ticketUsage: settledUsageByTicket(parseLedger(ledgerText ?? '')),
    };
    // E14-2: `tickets.backend` decides where the TICKETS come from; the
    // pipeline, repos and ledger stay in this vault either way.
    const store = await readStoreSettings(this.host.configGet.bind(this.host));
    this.dricket = store.backend === 'dricket' ? store : null;
    const snapshot = store.backend === 'dricket'
      ? await this.storeBoard.board(store, common)
      : assembleBoard({
        ...common,
        files,
        // The same file list already carries the archive — no extra reads.
        recentDone: recentDoneOf(files, Date.now()),
      });
    if (store.shadow) {
      // The UI keeps the files board; the store's board is built beside it
      // and the difference is written to a report (never shown, never fatal).
      this.storeBoard.scheduleShadow(store, common, snapshot);
    }
    // The chain follows the pipeline: an automatic column anywhere
    // points the runner at this vault (M85). Cheap and idempotent —
    // the runner re-reads the vault on every dispatch pass anyway.
    await this.refreshHandover(snapshot);
    await this.syncChainConfig(vault, snapshot.pipeline);
    return snapshot;
  }

  /**
   * The read-only listing from the `TicketStore` behind `tickets.backend`
   * (E14-1, ADR-0090): `files` reads the tickets vault through the file
   * store, `dricket` shells out to `dk`. Never throws — a missing `dk` or a
   * misconfigured store comes back as `{ ok: false, error }`. Not the board:
   * columns here are the store's stages; the board over `TicketRecord[]` is
   * E14-2.
   */
  async storeListing(): Promise<StoreListing> {
    const settings = await readStoreSettings(this.host.configGet.bind(this.host));
    try {
      if (settings.backend === 'dricket') {
        if (settings.dkStore === '') {
          return { ok: false, backend: 'dricket', error: 'no dricket store configured (tickets.dk.store)' };
        }
        const store = createDricketStore(settings);
        const [records, capabilities] = await Promise.all([store.list(), store.capabilities()]);
        return { ok: true, backend: 'dricket', version: capabilities.version, columns: groupByStage(records) };
      }
      const vault = await this.detect();
      if (vault === null) {
        return { ok: false, backend: 'files', error: 'no tickets vault detected' };
      }
      const store = new FileTicketStore({
        listMarkdownFiles: () => this.host.listMarkdownFiles(vault.id),
        read: (p) => this.host.read(vault.id, p),
        write: (p, text) => this.host.write(vault.id, p, text),
        commit: (paths, message) => this.commit(vault, paths, message),
        announce: (paths) => this.host.announceChanges(vault.id, paths),
      });
      return { ok: true, backend: 'files', version: null, columns: groupByStage(await store.list()) };
    } catch (error) {
      return { ok: false, backend: settings.backend, error: error instanceof TicketStoreError || error instanceof Error ? error.message : String(error) };
    }
  }

  /** Re-reads the handover thresholds with the board's override keys (T-0049). */
  private async refreshHandover(snap: BoardSnapshot): Promise<void> {
    this.handover = await handoverFromConfig(
      this.host.configGet.bind(this.host),
      handoverOverrideKeys(snap, this.defaultWorker),
    );
  }

  /**
   * Why the chain may not be switched on, or null. On `tickets.backend = dricket` the chain reads
   * its tickets from the store's checkout (E14-5b), so it needs one: an explicit
   * `tickets.dk.checkout`, or a local `tickets.dk.store` directory. A remote store without a
   * checkout would leave the runner one `dk` call per ticket; that is refused.
   */
  async chainRefusal(): Promise<string | null> {
    const store = await this.refreshDricket();
    if (store === null) {
      return null;
    }
    if (store.dkStore === '') {
      return 'The chain needs the dricket store (tickets.dk.store)';
    }
    return checkoutOf(store) === null
      ? 'The chain reads the store from its checkout: set tickets.dk.checkout (a remote store has none yet)'
      : null;
  }

  /**
   * "Release leftover claims" (E14-5b (4)): a runner that was killed with a run in flight leaves its
   * `agent-<run>@<host>` claim on the ticket until the lease ends. The runner releases every agent
   * claim of this host that no live run holds - back to where the ticket sat, else one stage back.
   */
  async releaseLeftoverClaims(): Promise<{ readonly ok: true; readonly released: readonly string[]; readonly skipped: readonly { readonly id: string; readonly reason: string }[] } | { readonly ok: false; readonly error: string }> {
    const store = await this.refreshDricket();
    if (store === null) {
      return { ok: false, error: 'There are no dk claims on the files backend' };
    }
    const snap = await this.snapshot();
    try {
      if (this.fleet.releaseLeftoverClaims === undefined) {
        return { ok: false, error: 'this fleet port cannot release claims' };
      }
      return await this.fleet.releaseLeftoverClaims(await this.chainStoreOf(store), retreatStages(snap.pipeline));
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** The store the chain and the leftover release hand to the runner process. */
  private async chainStoreOf(store: StoreSettings): Promise<ChainStoreConfig> {
    const trailers = await this.host.configGet<boolean | string>('dk.trailers');
    return { dkPath: store.dkPath, dkStore: store.dkStore, dkDataDir: store.dkDataDir, dkCheckout: store.dkCheckout, trailers: trailers === true || trailers === 'true' };
  }

  /** Keeps the runner's chain config in step with the pipeline (never spawns). */
  private async syncChainConfig(
    vault: { readonly path: string } | null,
    pipeline: readonly PipelinePhase[],
  ): Promise<ChainConfig | null> {
    const dricket = this.dricket;
    if (dricket !== null && (dricket.dkStore === '' || checkoutOf(dricket) === null)) {
      return null; // the dispatcher reads the store's checkout (E14-5b): without one there is nothing to point it at
    }
    const defaultPersona = ((await this.host.configGet<string>('personas.default')) ?? '').trim() || null;
    const chain: ChainConfig | null =
      vault !== null && pipeline.some((phase) => isAutoPhase(phase))
        ? {
            ticketsVaultPath: vault.path,
            ...(dricket !== null ? { store: await this.chainStoreOf(dricket) } : {}),
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
        return { vault, card, text: await this.readCardText(vault, card) };
      }
    }
    return null;
  }

  /**
   * A ticket that left the board's columns -- accepted into the archive (E13-21): the
   * files backend reads `tickets/archive/<id>.md`, dricket the record that carries the
   * `archived` label. Read-only: it opens like any ticket, only its moves are off.
   */
  private async findArchived(id: string): Promise<{ vault: EngineVault; card: TicketCard; text: string } | null> {
    const vault = await this.detect();
    if (vault === null || !TICKET_ID_PATTERN.test(id)) {
      return null;
    }
    const path = `${TICKETS_ARCHIVE_DIR}/${id}.md`;
    let text: string;
    try {
      if (this.dricket === null) {
        text = await this.host.read(vault.id, path);
      } else {
        const record = await this.storeBoard.record(this.dricket, id);
        if (!record.labels.includes(ARCHIVED_LABEL)) {
          return null;
        }
        text = recordToBoardFile(record, 'archive').text;
      }
    } catch {
      return null;
    }
    const parsed = parseTicketFile(text, path);
    const card: TicketCard = { id, path, phase: 'archive', meta: parsed.meta, worker: this.defaultWorker, blocked: [], blocks: [], issues: parsed.issues };
    return { vault, card, text };
  }

  /**
   * The archive's tickets of any age (E13-21 "Show older"), newest first, narrowed by
   * `query` (id or title words): the files backend reads `tickets/archive/`, dricket the
   * archived records. The Work panel and Mission Control list them behind "Show older".
   */
  async archivedTickets(input: { query?: string; limit?: number } = {}): Promise<{ ok: true; tickets: readonly RecentDone[] } | { ok: false; error: string }> {
    try {
      const vault = await this.detect();
      if (vault === null) {
        return { ok: true, tickets: [] };
      }
      const store = await this.refreshDricket();
      const files = store === null
        ? await Promise.all(
            (await this.host.listMarkdownFiles(vault.id))
              .filter((p) => p.startsWith(`${TICKETS_ARCHIVE_DIR}/`))
              .map(async (path) => ({ path, text: await this.host.read(vault.id, path) })),
          )
        : archivedRecordFiles(await this.storeBoard.records(store));
      return { ok: true, tickets: archivedEntriesOf(files, { query: input.query, limit: input.limit }) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** One ticket's card and file text, for the remote's ticket view (req-66). */
  async readTicket(id: string): Promise<TicketReply> {
    const found = (await this.findCard(id)) ?? (await this.findArchived(id));
    if (found === null) {
      return { ok: false, error: `${id} is not on the board` };
    }
    const comments = this.dricket === null ? null : await this.commentsOf(this.dricket, id);
    return {
      ok: true,
      card: found.card,
      text: found.text,
      revision: revisionOf(found.text),
      ...(comments === null ? {} : { comments }),
    };
  }

  /**
   * One ticket by id for the chat (D-7a): a card on the board, else an archived
   * ticket — an accepted ticket leaves the board (`tickets/archive/` on the files
   * backend, the `archived` label on dricket) and `readTicket` knows no card for
   * it. Text and comments only: an archived ticket has no card to show.
   */
  async readAnyTicket(id: string): Promise<{ readonly ok: true; readonly text: string; readonly comments?: readonly TicketCommentView[] } | { readonly ok: false; readonly error: string }> {
    const onBoard = await this.readTicket(id);
    if (onBoard.ok) {
      return { ok: true, text: onBoard.text, ...(onBoard.comments === undefined ? {} : { comments: onBoard.comments }) };
    }
    const vault = await this.detect();
    if (vault === null) {
      return onBoard;
    }
    try {
      const store = this.dricket;
      if (store !== null) {
        const record = await this.storeBoard.record(store, id);
        return { ok: true, text: recordToBoardFile(record, record.stage).text, comments: await this.commentsOf(store, id) };
      }
      const archived = (await this.host.listMarkdownFiles(vault.id)).find((p) => p === `${TICKETS_ARCHIVE_DIR}/${id}.md`);
      return archived === undefined ? onBoard : { ok: true, text: await this.host.read(vault.id, archived) };
    } catch {
      return onBoard; // the store does not know the id either: the honest "not on the board"
    }
  }

  /** The ticket's comments read from the store's `comments/` files, oldest first (E14-6); empty off dricket. */
  async ticketComments(id: string): Promise<readonly TicketCommentView[]> {
    await this.refreshDricket();
    return this.dricket === null ? [] : this.commentsOf(this.dricket, id);
  }

  /** A comment-read failure is an empty thread, never a failed ticket view. */
  private async commentsOf(store: StoreSettings, id: string): Promise<readonly TicketCommentView[]> {
    try {
      return commentViewsOf(await this.storeBoard.comments(store, id));
    } catch (error) {
      this.host.log(`tickets: comments of ${id} could not be read: ${messageOf(error)}`, 'warn');
      return [];
    }
  }

  /**
   * One status event of a ticket (E14-6). On a store it is a keyed comment
   * (`dk comment`; `working` is never persisted, a keyless `resolved` closes
   * nothing); on the files backend the old status log line. A failure is a log
   * line, never a failed mutation (the same contract as the ledger).
   */
  private async noteStatus(card: TicketCard, verb: StatusVerb, input: { key?: string | null; text?: string; detail?: string }, actor: string): Promise<void> {
    const store = this.dricket;
    if (store === null) {
      this.options.events?.status?.(card.path, new Date().toISOString(), verb, input.text ?? input.key ?? '');
      return;
    }
    const text = renderStatusComment({ verb, ...input });
    if (text === null) {
      return;
    }
    try {
      await this.storeBoard.comment(store, card.id, text, actor);
    } catch (error) {
      this.host.log(`tickets: the ${verb} comment on ${card.id} could not be written: ${messageOf(error)}`, 'warn');
    }
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
    if (this.dricket !== null) {
      // E14-6: on a store the verbs are the first lines of the ticket's comments.
      try {
        return statusLinesOfComments(await this.storeBoard.comments(this.dricket, id));
      } catch {
        return [];
      }
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
        await this.writeCardText(vault, card, refined);
      } catch (error) {
        return error instanceof TicketChangedError
          ? { ok: false, conflict: true, error: error.message }
          : { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} refined`);
      this.announceCard(vault, card);
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
        await this.writeCardText(vault, card, input.text);
      } catch (error) {
        return error instanceof TicketChangedError
          ? { ok: false, conflict: true, error: error.message }
          : { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} edited`);
      this.announceCard(vault, card);
      this.announceChanged();
      return { ok: true, revision: revisionOf(input.text), ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The proof card's diff (concept §5.3): the worktree branch against
   * its base, one capped unified diff. No worktree/no repo → an empty
   * diff (the card shows the Changes section alone, honestly).
   */
  /**
   * The run estimate for a (gate, persona, model) triple from the owner's
   * own history (E11-4): the `## Verlauf` lines of every ticket under
   * `tickets/`, archive included. Null below three matching runs.
   */
  async estimateOf(key: EstimateKey): Promise<RunEstimate | null> {
    const vault = await this.detect();
    if (vault === null) {
      return null;
    }
    const history: VerlaufEntry[] = [];
    for (const file of await this.host.listMarkdownFiles(vault.id)) {
      if (!file.startsWith('tickets/') || file.startsWith('tickets/_meta/')) {
        continue;
      }
      try {
        history.push(...parseVerlaufEntries(await this.host.read(vault.id, file)));
      } catch {
        // An unreadable file adds nothing to the history.
      }
    }
    return estimateFrom(history, key);
  }

  /** A ticket's file on its branch (`git show HEAD:<path>`), for the diff's "Whole file" view. */
  async ticketFile(id: string, filePath: string): Promise<TicketFileReply> {
    if (!isSafeRepoPath(filePath)) {
      return { ok: false, error: 'not a path inside the repository' };
    }
    const where = await this.diffWorktree(id);
    if (where === null) {
      return { ok: false, error: `${id} has no worktree to read from` };
    }
    try {
      const output = await this.git.run(where.worktreePath, ['show', `HEAD:${filePath}`]);
      const truncated = Buffer.byteLength(output, 'utf8') > MAX_FILE_VIEW_BYTES;
      return { ok: true, text: truncated ? output.slice(0, MAX_FILE_VIEW_BYTES) : output, truncated };
    } catch {
      return { ok: false, error: `${filePath} is not on the ticket branch` };
    }
  }

  async ticketDiff(id: string): Promise<TicketDiff> {
    const where = await this.diffWorktree(id);
    if (where === null) {
      return { files: [], truncated: false };
    }
    try {
      const output = await this.git.run(where.worktreePath, ['diff', '--unified=3', `${where.base}...HEAD`]);
      return diffOfOutput(output);
    } catch {
      return { files: [], truncated: false };
    }
  }

  /** The ticket's worktree and the base its diff runs against; null when there is none yet. */
  private async diffWorktree(id: string): Promise<{ worktreePath: string; base: string } | null> {
    const vault = await this.detect();
    if (vault === null) {
      return null;
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
      return null;
    }
    const record = this.newestRecordFor(await this.fleetRecords(), card.id);
    const worktreePath = record !== null ? record.worktreePath : worktreePathFor(vault.path, repo, card.id);
    return existsSync(worktreePath) ? { worktreePath, base: repo.branch ?? 'main' } : null;
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
        await this.writeCardText(vault, card, refined);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} refined`);
      this.announceCard(vault, card);
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
        await this.writeCardText(vault, card, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} track ${input.track ?? 'none'}`);
      this.announceCard(vault, card);
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
        await this.writeCardText(vault, card, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} form ${input.form}`);
      this.announceCard(vault, card);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The shared plan (E10-3, concept v2 §5.8): replaces the ticket's
   * `## Plan` chapter — and nothing else of the file — with the shape
   * turn's text. One commit `tickets: <id> plan`. A live run refuses; an
   * unchanged plan is a no-op success.
   */
  setPlan(input: { id: string; plan: string; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Change the plan when the run has ended.' };
      }
      const patched = withPlanSection(text, input.plan);
      if (patched === text.replace(/\r\n/g, '\n')) {
        return { ok: true };
      }
      try {
        await this.writeCardText(vault, card, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} plan`);
      this.announceCard(vault, card);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * A shape turn's read-only look into the ticket's repository (E10-3):
   * a file's text (cut at the view cap) or, for a path ending in `/` (or
   * empty), the directory's entries. Only the ticket's own repo, only
   * inside it; `.git`, dependency folders and secret files stay shut.
   */
  async readRepoFile(
    id: string,
    relPath: string,
  ): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }> {
    const found = await this.findCard(id);
    if (found === null) {
      return { ok: false, error: `${id} is not on the board` };
    }
    const snap = await this.snapshot();
    const repoName = found.card.meta.repo ?? found.card.meta.repos[0] ?? null;
    const repo = repoName === null ? null : snap.repos.find((r) => r.name === repoName) ?? null;
    if (repo === null || repo.path === null) {
      return { ok: false, error: `${id} names no repository with a local path` };
    }
    const isDir = relPath === '' || relPath === '.' || relPath.endsWith('/');
    const clean = relPath === '' || relPath === '.' ? '' : relPath.replace(/\/+$/, '');
    if (clean !== '' && !isSafeRepoPath(clean)) {
      return { ok: false, error: `"${relPath}" is not a path inside the repository` };
    }
    const segments = clean === '' ? [] : clean.split('/');
    if (segments.some((s) => REPO_READ_DENIED.test(s))) {
      return { ok: false, error: `"${relPath}" is not readable` };
    }
    const abs = path.join(repo.path, ...segments);
    try {
      if (isDir) {
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        const names = entries
          .filter((e) => !REPO_READ_DENIED.test(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .slice(0, 200);
        return { ok: true, text: names.join('\n') };
      }
      const buffer = await fsp.readFile(abs);
      if (buffer.includes(0)) {
        return { ok: false, error: `"${relPath}" is a binary file` };
      }
      const cut = buffer.length > MAX_FILE_VIEW_BYTES;
      return { ok: true, text: `${buffer.subarray(0, MAX_FILE_VIEW_BYTES).toString('utf8')}${cut ? '\n… (cut)' : ''}` };
    } catch {
      return { ok: false, error: `"${relPath}" does not exist` };
    }
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
        await this.writeCardText(vault, card, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const value = canonical === null ? 'standard' : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} chain ${value}`);
      this.announceCard(vault, card);
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
        await this.writeCardText(vault, card, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const value = input.blockedBy.length === 0 ? 'none' : `${input.blockedBy.length} ${input.blockedBy.length === 1 ? 'id' : 'ids'}`;
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} blocked-by ${value}`);
      this.announceCard(vault, card);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  // --- the plan to approve (E10-4, concept v2 §5.9) ----------------------------

  /** The build queue's phase: `build`, else the phase after the first, else the first. */
  private buildPhaseOf(snap: BoardSnapshot): PipelinePhase | null {
    return snap.pipeline.find((p) => p.id === 'build') ?? snap.pipeline[1] ?? snap.pipeline[0] ?? null;
  }

  /** The tickets that name `parentId` as their parent, as the matcher reads them. */
  private childrenOf(snap: BoardSnapshot, parentId: string): PartTicket[] {
    return snap.columns.flatMap((column) =>
      column.tickets
        .filter((t) => t.meta.parent === parentId)
        .map((t) => ({ id: t.id, title: t.meta.title ?? t.id, phase: column.phase.id, running: t.meta.run !== null })),
    );
  }

  /**
   * The cards of a ticket's plan to approve: its `### Parts` with the
   * ticket each part became (by title among the tickets that name this
   * one as `parent:`), the state and the lock that follows, each part's
   * flow from the build gate on, and the personas the picker offers. A
   * read — nothing is written, nothing normalized.
   */
  async planParts(id: string): Promise<PlanPartsReply> {
    const found = await this.findCard(id);
    if (found === null) {
      return { ok: false, error: `${id} is not on the board` };
    }
    const snap = await this.snapshot();
    const build = this.buildPhaseOf(snap);
    if (build === null) {
      return { ok: false, error: snap.pipelineError ?? 'the pipeline is empty' };
    }
    const parsed = parsePlanParts(found.text);
    const matches = matchPartTickets(parsed.parts, this.childrenOf(snap, id));
    const terminal = snap.pipeline[snap.pipeline.length - 1]!.id;
    const buildAt = snap.pipeline.findIndex((p) => p.id === build.id);
    const queue = new Set(snap.pipeline.slice(0, buildAt + 1).map((p) => p.id));
    const personas = await this.listPersonas();
    const defaultPersona = build.persona ?? (((await this.host.configGet<string>('personas.default')) ?? '').trim() || null);
    const phases = snap.pipeline.map((p) => ({ id: p.id, title: p.title }));
    const parts: PlanPartCard[] = parsed.parts.map((part, index) => {
      const own = matches[index] ?? null;
      const entries = partChainEntries(part);
      const steps = mergeChain(phases, build.id, entries).filter((step) => step.state !== 'past' && step.phase !== terminal);
      return {
        index,
        title: part.title,
        reason: part.reason,
        persona: part.persona,
        chain: part.chain,
        flow: steps.map((step) => ({
          phase: step.phase,
          title: step.title,
          persona: step.phase === build.id ? (part.persona ?? defaultPersona) : (step.persona ?? snap.pipeline.find((p) => p.id === step.phase)?.persona ?? null),
          inserted: step.inserted,
          skipped: step.skipped,
          notify: step.notify,
        })),
        ticket: own?.id ?? null,
        state: partStateOf(own, queue, terminal),
        phase: own?.phase ?? null,
        locked: own !== null,
        start: startLineOf(index, matches),
      };
    });
    return {
      ok: true,
      ticket: id,
      title: found.card.meta.title ?? id,
      parts,
      gate: build.id,
      defaultPersona,
      personas: personas.map((p) => ({
        id: p.id,
        title: p.title,
        role: isHumanPersona(p) ? '' : p.role,
        color: p.color,
        model: isHumanPersona(p) ? '' : (deriveWorkerModel(p, null).model ?? ''),
      })),
      warnings: parsed.warnings,
    };
  }

  /**
   * The owner's edit on the card list — a persona pick, a move, a delete —
   * written as the new `### Parts` chapter of the parent's Plan. A part
   * that is a ticket already refuses (and nothing may move above one);
   * the list never drops below two parts (that is "Keep as one ticket",
   * a decision of its own). One commit `tickets: <id> parts`.
   */
  editPlanParts(input: { id: string; edit: PlanPartsEdit; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      if (card.meta.run !== null) {
        return { ok: false, error: 'A run is live on this ticket. Change the parts when the run has ended.' };
      }
      const snap = await this.snapshot();
      const parts = parsePlanParts(text).parts;
      if (parts.length < 2) {
        return { ok: false, error: 'This plan has no parts to change.' };
      }
      const locked = lockedIndices(matchPartTickets(parts, this.childrenOf(snap, input.id)));
      const edit = input.edit;
      let next: readonly PlanPart[];
      if (edit.op === 'move') {
        const moved = movePlanPart(parts, edit.from, edit.to, locked);
        if (!moved.ok) {
          return { ok: false, error: moved.error };
        }
        next = moved.parts;
      } else if (edit.op === 'delete') {
        const deleted = deletePlanPart(parts, edit.index, locked);
        if (!deleted.ok) {
          return { ok: false, error: deleted.error };
        }
        if (deleted.parts.length < 2) {
          return { ok: false, error: 'A split needs two parts. Keep the plan as one ticket instead.' };
        }
        next = deleted.parts;
      } else {
        const target = parts[edit.index];
        if (target === undefined) {
          return { ok: false, error: 'no such part position' };
        }
        if (locked.has(edit.index)) {
          return { ok: false, error: `"${target.title}" is released as a ticket — its persona changes there` };
        }
        if (edit.persona !== null && !(await this.listPersonaIds()).includes(edit.persona)) {
          return { ok: false, error: personaMissing(edit.persona) };
        }
        next = parts.map((part, i) => (i === edit.index ? { ...part, persona: edit.persona } : part));
      }
      const patched = withPlanParts(text, next);
      if (patched === text.replace(/\r\n/g, '\n')) {
        return { ok: true };
      }
      try {
        await this.writeCardText(vault, card, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} parts`);
      this.announceCard(vault, card);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The flow editor's frame (E10-5): which chain, from which gate on, what
   * the file holds now, and whether it may change at all. The ticket scope
   * is the card's own `chain:`; the part scope is one part's `chain:` line
   * in the parent's `### Parts`, flowing from the build gate.
   */
  private async flowFrame(target: FlowTarget): Promise<FlowFrame | { readonly error: string }> {
    const found = await this.findCard(target.id);
    if (found === null) {
      return { error: `${target.id} is not on the board` };
    }
    const { vault, card, text } = found;
    const snap = await this.snapshot();
    const phases = snap.pipeline.map((p) => ({ id: p.id, title: p.title }));
    if (phases.length < 2) {
      return { error: snap.pipelineError ?? 'the pipeline is empty' };
    }
    const title = card.meta.title ?? target.id;
    if (target.part === null) {
      return {
        vault,
        card,
        text,
        snap,
        phases,
        title,
        scope: { kind: 'ticket' },
        currentId: card.phase,
        saved: card.meta.chain ?? [],
        builder: card.meta.persona ?? null,
        part: null,
        readOnly: card.meta.run !== null ? 'A run is live on this ticket. Change the flow when the run has ended.' : null,
      };
    }
    const build = this.buildPhaseOf(snap);
    if (build === null) {
      return { error: snap.pipelineError ?? 'the pipeline has no build queue' };
    }
    const parts = parsePlanParts(text).parts;
    const part = parts[target.part];
    if (part === undefined || parts.length < 2) {
      return { error: 'no such part in this plan' };
    }
    const locked = lockedIndices(matchPartTickets(parts, this.childrenOf(snap, target.id))).has(target.part);
    const defaultPersona = build.persona ?? (((await this.host.configGet<string>('personas.default')) ?? '').trim() || null);
    return {
      vault,
      card,
      text,
      snap,
      phases,
      title,
      scope: { kind: 'part', index: target.part, title: part.title },
      currentId: build.id,
      saved: partChainEntries(part),
      builder: part.persona ?? defaultPersona,
      part,
      readOnly: locked ? `"${part.title}" is released as a ticket — change its flow on that ticket.` : null,
    };
  }

  /** A flow frame's chain as the editor shows it: the merged gates from the current one on, the terminal phase left out. */
  private async flowReply(frame: FlowFrame, entries: readonly ChainEntry[]): Promise<FlowReply> {
    await this.ensureHumanPersona();
    const personas = await this.listPersonas();
    const terminal = frame.snap.pipeline[frame.snap.pipeline.length - 1]!.id;
    const buildId = this.buildPhaseOf(frame.snap)?.id ?? null;
    const modelOf = (personaId: string | null): string | null => {
      const persona = personas.find((p) => p.id === personaId);
      return persona === undefined || isHumanPersona(persona) ? null : (deriveWorkerModel(persona, null).model ?? null);
    };
    const steps: FlowStepView[] = mergeChain(frame.phases, frame.currentId, entries)
      .map((step, index): FlowStepView | null => {
        if (step.state === 'past' || step.phase === terminal) {
          return null;
        }
        const column = frame.snap.pipeline.find((p) => p.id === step.phase);
        const base = step.phase === buildId && !step.inserted && frame.builder !== null ? frame.builder : (column?.persona ?? null);
        const persona = step.persona ?? base;
        return {
          index,
          phase: step.phase,
          title: step.title,
          state: step.state === 'current' ? 'current' : 'future',
          inserted: step.inserted,
          skipped: step.skipped,
          moved: step.moved,
          notify: step.notify,
          persona,
          pinned: step.persona !== null,
          model: modelOf(persona),
          owner:
            isHumanPersona(personas.find((p) => p.id === persona)) ||
            (persona === null && (isManualPhase(step.phase) || (column?.handover ?? '').trim().startsWith('manual'))),
          locked: step.state === 'current' || frame.readOnly !== null,
        };
      })
      .filter((step): step is FlowStepView => step !== null);
    return {
      ok: true,
      ticket: frame.card.id,
      title: frame.title,
      scope: frame.scope,
      chain: renderChainEntries(entries),
      saved: renderChainEntries(frame.saved),
      steps,
      // E10-6: the manual step is no pipeline directory - always on offer (once per flow).
      phases: [
        ...frame.phases.filter((phase) => phase.id !== terminal),
        ...(frame.phases.some((phase) => phase.id === MANUAL_PHASE) ? [] : [{ id: MANUAL_PHASE, title: MANUAL_TITLE }]),
      ],
      personas: personas.map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        color: p.color,
        model: isHumanPersona(p) ? '' : (deriveWorkerModel(p, null).model ?? ''),
      })),
      readOnly: frame.readOnly,
    };
  }

  private async flowEntriesOf(chain: readonly string[], frame: FlowFrame): Promise<ChainEntry[] | { readonly error: string }> {
    const entries: ChainEntry[] = [];
    for (const raw of chain) {
      const entry = parseChainEntry(raw);
      if (entry === null) {
        return { error: `chain entry "${raw}" is not readable` };
      }
      entries.push(entry);
    }
    const refusal = validateChain(frame.phases, frame.currentId, entries);
    if (refusal !== null) {
      return { error: refusal };
    }
    const all = await this.listPersonas();
    const ids = all.map((p) => p.id);
    for (const entry of entries) {
      const persona = entry.kind === 'insert' || entry.kind === 'assign' ? entry.persona : null;
      if (persona !== null && !ids.includes(persona)) {
        return { error: personaMissing(persona) };
      }
      // E10-6: a manual step is worked by a human - an agent persona cannot hold one.
      if (entry.kind === 'insert' && isManualPhase(entry.phase) && persona !== null && !isHumanPersona(all.find((p) => p.id === persona))) {
        return { error: `A manual step is yours to work - ${persona} is an agent. Pick ${HUMAN_PERSONA_ID} or nobody.` };
      }
    }
    return entries;
  }

  /** The flow as the file holds it (E10-5). */
  async flowOf(target: FlowTarget): Promise<FlowReply> {
    const frame = await this.flowFrame(target);
    return 'error' in frame ? { ok: false, error: frame.error } : this.flowReply(frame, frame.saved);
  }

  /**
   * One edit on a draft chain (E10-5): the draft arrives, the edited draft
   * returns — nothing is written. `view` re-reads a draft (Paul's).
   */
  async flowEdit(input: FlowTarget & { chain: readonly string[]; edit: FlowOp }): Promise<FlowReply> {
    const frame = await this.flowFrame(input);
    if ('error' in frame) {
      return { ok: false, error: frame.error };
    }
    const entries = await this.flowEntriesOf(input.chain, frame);
    if ('error' in entries) {
      return { ok: false, error: entries.error };
    }
    if (input.edit.op === 'persona' && input.edit.persona !== null && !(await this.listPersonaIds()).includes(input.edit.persona)) {
      return { ok: false, error: personaMissing(input.edit.persona) };
    }
    if (frame.readOnly !== null && input.edit.op !== 'view') {
      return { ok: false, error: frame.readOnly };
    }
    const edited = applyFlowOp(frame.phases, frame.currentId, entries, input.edit);
    if (!edited.ok) {
      return { ok: false, error: edited.error };
    }
    return this.flowReply(frame, edited.entries);
  }

  /**
   * "Save flow" (E10-5): the draft becomes the ticket's `chain:` (the
   * setChain write: one header rewrite, one Log line, one commit) or one
   * part's `chain:` in the parent's plan (one commit
   * `tickets: <id> part <n> flow`). A part that is a ticket already, a
   * live run and a delta that does not hold refuse.
   */
  async saveFlow(input: FlowTarget & { chain: readonly string[]; actor?: string }): Promise<FlowSaveReply> {
    if (input.part === null) {
      return this.setChain({ id: input.id, chain: input.chain, ...(input.actor === undefined ? {} : { actor: input.actor }) });
    }
    const partIndex = input.part;
    return this.enqueue(async (): Promise<FlowSaveReply> => {
      const frame = await this.flowFrame(input);
      if ('error' in frame) {
        return { ok: false, error: frame.error };
      }
      if (frame.readOnly !== null) {
        return { ok: false, error: frame.readOnly };
      }
      const entries = await this.flowEntriesOf(input.chain, frame);
      if ('error' in entries) {
        return { ok: false, error: entries.error };
      }
      const canonical = renderChainEntries(entries);
      const parts = parsePlanParts(frame.text).parts;
      const next = parts.map((part, i) => (i === partIndex ? { ...part, chain: canonical } : part));
      const patched = withPlanParts(frame.text, next);
      if (patched === frame.text.replace(/\r\n/g, '\n')) {
        return { ok: true };
      }
      try {
        await this.writeCardText(frame.vault, frame.card, patched);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const warning = await this.commitCard(frame.vault, frame.card, `tickets: ${input.id} part ${partIndex + 1} flow`);
      this.announceCard(frame.vault, frame.card);
      this.announceChanged();
      return { ok: true, ...(warning === null ? {} : { warning }) };
    });
  }

  /** What Paul reads before he drafts a flow (E10-5): the standard flow, the flow now, the crew. */
  async flowDraftContext(target: FlowTarget): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }> {
    const frame = await this.flowFrame(target);
    if ('error' in frame) {
      return { ok: false, error: frame.error };
    }
    if (frame.readOnly !== null) {
      return { ok: false, error: frame.readOnly };
    }
    const reply = await this.flowReply(frame, frame.saved);
    if (!reply.ok) {
      return reply;
    }
    const personas = reply.personas.map((p) => `- ${p.id} (${p.title})`).join('\n');
    const standard = frame.phases.map((p) => p.id).join(' -> ');
    const now = reply.steps
      .map(
        (s) =>
          `${s.index}. ${s.phase}${s.persona === null ? '' : ` — ${s.persona}`}${s.skipped ? ' (struck)' : ''}${s.inserted ? ' (added)' : ''}${s.notify ? ' (tell me)' : ''}${s.state === 'current' ? ' (running now, locked)' : ''}`,
      )
      .join('\n');
    const plan = frame.part !== null ? `\nThis flow belongs to part "${frame.part.title}"${frame.part.reason === null ? '' : ` — ${frame.part.reason}`}.` : '';
    return {
      ok: true,
      text: `Ticket ${target.id}: ${frame.title}${plan}\n\nStandard flow (phase ids): ${standard}\nThe flow now, from the current gate:\n${now}\nSaved delta: ${reply.saved.length === 0 ? '(none — standard flow)' : reply.saved.join('; ')}\n\nPersonas:\n${personas}`,
    };
  }

  /**
   * The approval (E10-4): every part of the plan that is not a ticket yet
   * — or only the first such part — becomes its own ticket in the build
   * queue: `parent:` the plan's ticket, the builder's `persona:` pin, the
   * part's own `chain:` delta, `blocked-by:` the part before it (so part
   * 2 waits until part 1 reaches the terminal phase). Everything is
   * checked first and written in one commit `tickets: <id> plan released`;
   * the parent gets one Log line and keeps the plan.
   */
  releasePlan(input: { id: string; scope: PlanReleaseScope; actor?: string }): Promise<PlanReleaseReply> {
    return this.enqueue(async () => {
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const { vault, card, text } = found;
      const snap = await this.snapshot();
      const build = this.buildPhaseOf(snap);
      if (build === null || snap.pipeline.length < 2) {
        return { ok: false, error: snap.pipelineError ?? 'the pipeline has no build queue' };
      }
      const parts = parsePlanParts(text).parts;
      if (parts.length < 2) {
        return { ok: false, error: 'This plan has no parts to release.' };
      }
      const matches = matchPartTickets(parts, this.childrenOf(snap, input.id));
      const store = this.dricket;
      // A released part whose ticket is still the empty stub `dk add` made (a release that
      // broke between add and put) is filled by the next approval: that is the resume.
      const stubs: number[] = [];
      if (store !== null) {
        for (let i = 0; i < matches.length; i += 1) {
          const match = matches[i];
          if (match !== null && match !== undefined && (await this.storeBoard.record(store, match.id)).body.includes(DK_EMPTY_DESCRIPTION)) {
            stubs.push(i);
          }
        }
      }
      const mint = [...new Set([...stubs, ...indicesToMint(matches, input.scope)])].sort((a, b) => a - b);
      if (mint.length === 0) {
        return { ok: false, error: 'Every part is released already.' };
      }
      const personaIds = await this.listPersonaIds();
      const phases = snap.pipeline.map((p) => ({ id: p.id, title: p.title }));
      for (const index of mint) {
        const part = parts[index]!;
        if (part.persona !== null && !personaIds.includes(part.persona)) {
          return { ok: false, error: `Part ${index + 1}: ${personaMissing(part.persona)}` };
        }
        const refusal = validateChain(phases, build.id, partChainEntries(part));
        if (refusal !== null) {
          return { ok: false, error: `Part ${index + 1}: ${refusal}` };
        }
      }
      if (store !== null) {
        return this.releaseInStore(store, { vault, card, text }, snap, build, parts, matches, mint, input);
      }
      const known = [
        ...snap.columns.flatMap((c) => c.tickets.map((t) => t.id)),
        ...archivedTicketIds(await this.host.listMarkdownFiles(vault.id)),
      ];
      const dirs = await this.ticketDirs(vault);
      const buildDir = resolvePhaseDir(dirs, snap.pipeline.findIndex((p) => p.id === build.id) + 1, build.id);
      const ids = new Map<number, string>();
      matches.forEach((m, i) => {
        if (m !== null) {
          ids.set(i, m.id);
        }
      });
      const now = new Date();
      const actor = input.actor ?? this.owner;
      const files: { path: string; text: string }[] = [];
      for (const index of mint) {
        const id = nextTicketId(known);
        known.push(id);
        ids.set(index, id);
        files.push({
          path: `tickets/${buildDir}/${id}.md`,
          text: partTicketText({
            id,
            parentId: input.id,
            parentTitle: card.meta.title ?? input.id,
            part: parts[index]!,
            index,
            total: parts.length,
            repo: card.meta.repo,
            repos: card.meta.repos,
            priority: card.meta.priority,
            priorities: snap.priorities,
            firstPhase: snap.pipeline[0]!.id,
            phase: build.id,
            blockedBy: blockerOf(index, ids),
            now,
            actor,
          }),
        });
      }
      const minted = mint.map((index) => ids.get(index)!);
      try {
        for (const file of files) {
          await this.host.writeAnnounced(vault.id, file.path, file.text);
        }
        await this.writeCardText(vault, card, withLogLine(text, now, actor, releaseLogText(minted)));
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commit(
        vault,
        [...files.map((f) => f.path), card.path],
        `tickets: ${input.id} plan released (${minted.length} ${minted.length === 1 ? 'part' : 'parts'})`,
      );
      this.announceCard(vault, card);
      this.announceChanged();
      return { ok: true, tickets: minted, ...(warning === null ? {} : { warning }) };
    });
  }

  /**
   * The approval on dricket (E14-4b): children first, parent last, resumable. Each
   * part is `dk add` (title, parent, depends — a complete linked stub) plus one
   * `put` of the part ticket; the parent's Log line is the last write. A failure
   * stops there and names what exists; approving again matches the existing
   * children by title, fills a stub left empty and mints only the rest.
   */
  private async releaseInStore(
    store: StoreSettings,
    found: { vault: EngineVault; card: TicketCard; text: string },
    snap: BoardSnapshot,
    build: PipelinePhase,
    parts: readonly PlanPart[],
    matches: readonly (PartTicket | null)[],
    mint: readonly number[],
    input: { id: string; actor?: string },
  ): Promise<PlanReleaseReply> {
    const { vault, card, text } = found;
    const ids = new Map<number, string>();
    matches.forEach((m, i) => {
      if (m !== null) {
        ids.set(i, m.id);
      }
    });
    const now = new Date();
    const actor = input.actor ?? this.owner;
    const done: string[] = [];
    try {
      for (const index of mint) {
        const part = parts[index]!;
        const blocker = blockerOf(index, ids);
        let id = ids.get(index) ?? null;
        if (id === null) {
          id = (
            await this.storeBoard.add(store, {
              title: part.title,
              priority: card.meta.priority,
              kind: 'human',
              parent: input.id,
              ...(blocker === null ? {} : { dependsOn: [blocker] }),
            })
          ).id;
          ids.set(index, id);
        }
        const body = partTicketText({
          id,
          parentId: input.id,
          parentTitle: card.meta.title ?? input.id,
          part,
          index,
          total: parts.length,
          repo: card.meta.repo,
          repos: card.meta.repos,
          priority: card.meta.priority,
          priorities: snap.priorities,
          firstPhase: snap.pipeline[0]!.id,
          phase: build.id,
          blockedBy: blocker,
          now,
          actor,
        });
        await this.putRecord(store, await this.storeBoard.record(store, id), body, { stage: build.id });
        done.push(id);
      }
      await this.writeCardText(vault, card, withLogLine(text, now, actor, releaseLogText(done)));
    } catch (error) {
      this.announceChanged();
      const so = done.length === 0 ? '' : ` Released so far: ${done.join(', ')}.`;
      return { ok: false, error: `release stopped: ${messageOf(error)}.${so} Approve again to continue — the parts that exist are kept.` };
    }
    this.announceChanged();
    return { ok: true, tickets: done };
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
      if (vault === null || (await this.refreshDricket()) !== null) {
        // On dricket the store owns the layout: there are no phase folders to drift.
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

  // --- ticket documents of a dricket store in the editor (E14-4c, ADR-0090) -----

  /**
   * Where the ticket's document is: the store's checkout and the checkout-relative path
   * (`tickets/<prefix>/<shard>/<id>/ticket.md`). Null on the files backend, without a
   * checkout, and for a ticket the store does not have: the caller then opens the vault
   * file as before.
   */
  async ticketDocument(input: { id: string }): Promise<TicketDocumentLocation | null> {
    const store = await this.refreshDricket();
    const checkout = store === null ? null : checkoutOf(store);
    const relPath = documentRelPath(input.id);
    if (store === null || checkout === null || relPath === null) {
      return null;
    }
    try {
      await this.storeBoard.record(store, input.id);
    } catch {
      return null;
    }
    return { checkout, path: relPath };
  }

  /**
   * The editor's save of a ticket document (E14-4c): the tab's text goes back through
   * `dk put --claim --if-version <rev>` — never as a file. `rev` is the one the tab read,
   * taken from the text itself; `force` (the save-conflict merge was resolved against the
   * stored document) puts on the rev the store has now. Exit 12 is a `conflict` reply with
   * the document as stored, nothing written; dk judges the document, a refusal comes back
   * as `error` with dk's own message.
   */
  saveDocument(input: { path: string; text: string; force?: boolean }): Promise<DocumentSaveReply> {
    return this.enqueue(async () => {
      const store = await this.refreshDricket();
      if (store === null) {
        return { ok: false, error: 'Ticket documents are saved through dricket; the dricket backend is off.' };
      }
      const id = idOfDocumentPath(input.path);
      if (id === null) {
        return { ok: false, error: `${input.path} is not a ticket document.` };
      }
      try {
        const current = await this.storeBoard.record(store, id);
        const expectedRev = input.force === true ? current.rev : detailFromContent(input.text).rev;
        if (expectedRev === null) {
          return { ok: false, error: 'The document has no rev: it cannot be saved. Reload the ticket.' };
        }
        const outcome = await this.storeBoard.write(store, id, input.text, { expectedRev });
        if (!outcome.ok) {
          return { ok: false, conflict: { text: outcome.conflict.current.text, rev: outcome.conflict.current.rev } };
        }
        const saved = await this.storeBoard.record(store, id);
        this.announceChanged();
        return { ok: true, text: saved.text, rev: saved.rev ?? outcome.result.rev };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    });
  }

  // --- the ticket write door (E14-4b, ADR-0090) ---------------------------------
  // On the files backend a card is a vault file: written, committed, announced.
  // On dricket a card is a store record folded into the legacy shape: the very
  // same text patchers run on it, and the result goes back through `dk put
  // --claim --if-version <rev>` (legacy-bridge). Exit 12 means the ticket moved
  // on: nothing was written, the user is told and re-reads.

  /** The card's file text — read from the vault, or the store record folded into the legacy shape. */
  private async readCardText(vault: EngineVault, card: TicketCard): Promise<string> {
    if (this.dricket === null) {
      return this.host.read(vault.id, card.path);
    }
    const record = await this.storeBoard.record(this.dricket, card.id);
    this.records.set(card.id, record);
    return recordToBoardFile(record, card.phase).text;
  }

  /** Writes the patched card text; a changed-in-the-meantime ticket (dk exit 12) throws {@link TicketChangedError}. */
  private async writeCardText(vault: EngineVault, card: TicketCard, text: string): Promise<void> {
    const store = this.dricket;
    if (store === null) {
      await this.host.write(vault.id, card.path, text);
      return;
    }
    const record = this.records.get(card.id) ?? (await this.storeBoard.record(store, card.id));
    // A header edit keeps the stage the document has; only a move changes it.
    await this.putRecord(store, record, text, { stage: record.stage });
    this.records.delete(card.id);
  }

  private async putRecord(store: StoreSettings, record: TicketDetail, legacyText: string, bridge: BridgeOptions): Promise<void> {
    const outcome = await this.storeBoard.writeLegacy(store, record, legacyText, bridge);
    if (!outcome.ok) {
      throw new TicketChangedError(record.id);
    }
  }

  /** The commit of a card edit: a git commit on the files backend; on dricket `put` already committed. */
  private commitCard(vault: EngineVault, card: TicketCard, message: string): Promise<string | null> {
    return this.dricket === null ? this.commit(vault, [card.path], message) : Promise.resolve(null);
  }

  private announceCard(vault: EngineVault, card: TicketCard): void {
    if (this.dricket === null) {
      this.host.announceChanges(vault.id, [card.path]);
    }
  }

  /** Re-reads `tickets.backend`: the store settings while the board runs on dricket, else null. */
  private async refreshDricket(): Promise<StoreSettings | null> {
    const settings = await readStoreSettings(this.host.configGet.bind(this.host));
    this.dricket = settings.backend === 'dricket' ? settings : null;
    return this.dricket;
  }

  /**
   * Where a run of this board claims its ticket (E14-5): the store, the stage a release
   * may retreat to (dk refuses an agent's same-stage release) and whether the store has a
   * `blocked` stage to park in. Trailers are opt-in (`tickets.dk.trailers`).
   */
  private async runTarget(store: StoreSettings, pipeline: readonly PipelinePhase[], phaseId: string): Promise<RunDkTarget> {
    return dkTargetFor(await this.chainStoreOf(store), pipeline, phaseId);
  }

  /** A human's claim takeover / release on a dricket ticket: `dk claim` / `dk release`, dk decides (E14-5). */
  private async setClaimInStore(
    store: StoreSettings,
    input: { id: string; mode: 'takeover' | 'release'; actor?: string },
  ): Promise<BoardMutationResult> {
    const found = await this.findCard(input.id);
    if (found === null) {
      return { ok: false, error: `${input.id} is not on the board` };
    }
    const actor = input.actor ?? this.owner;
    try {
      if (input.mode === 'takeover') {
        await this.storeBoard.claim(store, input.id, { actor, kind: 'human', size: 'S' });
      } else {
        await this.storeBoard.release(store, input.id, { actor, stage: found.card.phase });
      }
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    this.announceChanged();
    return { ok: true };
  }

  /**
   * The transition machine's IO over the store: no vault file moves, no commit of
   * its own (one `put` is the commit). `read` folds the record, `write` is the
   * `put` with the target stage; the archive is stage `terminal` + the `archived`
   * label, an unarchive removes it.
   */
  private dricketTransitionIo(store: StoreSettings, terminal: string): TransitionIo {
    const idOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const inArchive = (p: string): boolean => p.startsWith(`${TICKETS_ARCHIVE_DIR}/`);
    return {
      read: async (p) => {
        const record = await this.storeBoard.record(store, idOf(p));
        if (inArchive(p) && !record.labels.includes(ARCHIVED_LABEL)) {
          throw new Error(`${record.id} is not archived`);
        }
        this.records.set(record.id, record);
        return recordToBoardFile(record, ticketPathParts(p)?.phase ?? terminal).text;
      },
      write: async (p, text) => {
        const id = idOf(p);
        const record = this.records.get(id) ?? (await this.storeBoard.record(store, id));
        const stage = inArchive(p) ? terminal : (ticketPathParts(p)?.phase ?? record.stage);
        await this.putRecord(store, record, text, { stage, archived: inArchive(p) });
        this.records.delete(id);
      },
      renameInto: () => Promise.resolve({ ok: true }),
      commit: () => Promise.resolve(null),
      push: () => Promise.resolve(null),
      announce: () => this.announceChanged(),
    };
  }

  /** The IO of a board move: vault files on the files backend, the store on dricket (the terminal phase is where an archived ticket stays). */
  private moveIo(vault: EngineVault, snap: BoardSnapshot): TransitionIo {
    return this.dricket === null
      ? this.transitionIo(vault)
      : this.dricketTransitionIo(this.dricket, snap.pipeline[snap.pipeline.length - 1]?.id ?? 'done');
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
      const store = this.dricket;
      if (store !== null) {
        return this.createInStore(store, snap, input);
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

  /**
   * Capture on dricket (E14-4b): `dk add` allocates the number and leaves a valid
   * stub (title, priority), then ONE `put` fills the document the way a capture
   * writes it (header, Description, Log). A failure between the two leaves a
   * titled ticket in the first column, never a hole.
   */
  private async createInStore(
    store: StoreSettings,
    snap: BoardSnapshot,
    input: { title: string; actor?: string; priority: TicketPriority; repo: string | null; repos?: readonly string[]; description: string; raw?: string },
  ): Promise<{ ok: false; error: string } | { ok: true; id: string; path: string }> {
    const firstPhase = snap.pipeline[0]!.id;
    let id: string;
    try {
      id = (await this.storeBoard.add(store, { title: input.title, priority: input.priority, kind: 'human' })).id;
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
      await this.putRecord(store, await this.storeBoard.record(store, id), text, { stage: firstPhase });
    } catch (error) {
      this.announceChanged();
      return { ok: false, error: `dricket: ${messageOf(error)}` };
    }
    this.announceChanged();
    return { ok: true, id, path: `tickets/${firstPhase}/${id}.md` };
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
    text?: string,
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
    const result = await runTransition(this.moveIo(vault, snap), {
      id: card.id,
      fromPath: card.path,
      ...(text !== undefined ? { text } : {}),
      patch: { to, from, now: new Date(), actor },
      ...(extraLog !== undefined ? { extraLog } : {}),
      toPath: `tickets/${toDir}/${card.id}.md`,
      commitMessage: `tickets: ${card.id} ${from} -> ${to}`,
      pushRemote: snap.pushRemote,
    });
    // E7: the ledger's phase line rides the successful move.
    // On a store the stage history is dk's (and derivable), so no `phase` line (E14-6).
    if (result.ok && this.dricket === null) {
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
    const result = await runTransition(this.moveIo(vault, snap), {
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
        // E10-6: finishing a manual step is an ordinary Accept; the Log says whose step it was.
        const finished = card.meta.awaiting === undefined ? undefined : `manual step finished by ${actor} (${card.meta.awaiting})`;
        const moved = await this.moveCard(vault, snap, card, next, actor, finished);
        if (moved.ok && finished !== undefined) {
          await this.noteStatus(card, 'done', { text: finished }, actor);
        }
        return moved;
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
  sendBack(input: {
    id: string;
    note: string;
    actor?: string;
    /** E11-3: line comments of the review; they land in the ticket's Handover as structured feedback. */
    comments?: readonly ReviewComment[];
  }): Promise<BoardMutationResult> {
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
      let text: string | undefined;
      if (input.comments !== undefined && input.comments.length > 0) {
        text = withReviewFeedback(await this.readCardText(vault, card), input.comments);
      }
      const actor = input.actor ?? this.owner;
      const moved = await this.moveCard(vault, snap, card, to, actor, `sent back: ${input.note.trim().slice(0, 500)}`, text);
      if (moved.ok && this.dricket !== null) {
        // E14-6: the note, whole, is a comment on the ticket (the Log line keeps the short form for the story).
        await this.commentOn(card, `sent back: ${input.note.trim()}`, actor);
      }
      return moved;
    });
  }

  /** A plain comment on a store ticket; a failure is a log line, the move it follows already happened. */
  private async commentOn(card: TicketCard, text: string, actor: string): Promise<void> {
    const store = this.dricket;
    if (store === null) {
      return;
    }
    try {
      await this.storeBoard.comment(store, card.id, text, actor);
    } catch (error) {
      this.host.log(`tickets: the comment on ${card.id} could not be written: ${messageOf(error)}`, 'warn');
    }
  }

  /**
   * The owner's answer to a Needs-you decision (E14-6): a `resolved: <key>`
   * comment closing the key, the answer as its detail. The key defaults to the
   * ticket's only open `needs-decision`/`blocked` key. On the files backend
   * the status log gets the `resolved` line (the answer text has no home there).
   */
  answerNeed(input: { id: string; key?: string; text?: string; actor?: string }): Promise<BoardMutationResult> {
    return this.enqueue(async () => {
      await this.refreshDricket();
      const found = await this.findCard(input.id);
      if (found === null) {
        return { ok: false, error: `${input.id} is not on the board` };
      }
      const open = openStatusItems(await this.statusOf(input.id)).filter((item) => item.key !== null);
      let key = slugStatusKey(input.key ?? '');
      if (key === null && (input.key ?? '').trim() === '') {
        key = open.length === 1 ? open[0]!.key : null;
      }
      if (key === null) {
        return { ok: false, error: open.length === 0 ? `${input.id} has no open decision to answer` : 'name the decision key to answer' };
      }
      if (!open.some((item) => item.key === key)) {
        return { ok: false, error: `${input.id} has no open decision "${key}"` };
      }
      await this.noteStatus(found.card, 'resolved', { key, ...(input.text !== undefined && input.text.trim() !== '' ? { detail: input.text } : {}) }, input.actor ?? this.owner);
      this.announceChanged();
      return { ok: true };
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
      return runTransition(this.moveIo(vault, snap), {
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
      const store = await this.refreshDricket();
      if (store !== null) {
        return this.setClaimInStore(store, input);
      }
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
        await this.writeCardText(vault, card, patched);
      } catch (error) {
        return { ok: false, error: `write failed: ${messageOf(error)}` };
      }
      const warning = await this.commitCard(vault, card, `tickets: ${input.id} claim ${input.mode}`);
      this.announceCard(vault, card);
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
      const dricket = await this.refreshDricket();
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
      if (dricket === null && card.meta.run !== null && !(await this.clearEndedRunStamp(vault, card))) {
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
      const text = await this.readCardText(vault, card);
      let prompt: string | null = null;
      if (input.interactive !== null) {
        // req-65: the dialog's brief — the phase's `interactive:` ref,
        // else the shipped plan default.
        const ref = workingPhase?.interactive ?? PLAN_INTERACTIVE_PROMPT;
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
        ...(dricket !== null ? { dk: await this.runTarget(dricket, snap.pipeline, phaseId) } : {}),
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
    await this.writeCardText(vault, card, patched);
    await this.commitCard(vault, card, `tickets: ${card.id} stale run stamp cleared`);
    this.announceCard(vault, card);
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
      const text = await this.readCardText(vault, card);
      let warning: string | null = warnings.length > 0 ? `extra worktrees: ${warnings.join('; ')}` : null;
      try {
        const patched = patchTicketFile(text, {
          to: card.phase,
          from: null,
          now: new Date(),
          actor: this.owner,
          action: `worktree removed (${worktreePath})`,
        });
        await this.writeCardText(vault, card, patched);
        const commitNote = await this.commitCard(vault, card, `tickets: ${card.id} worktree removed`);
        if (commitNote !== null) {
          warning = warning === null ? commitNote : `${warning} — ${commitNote}`;
        }
        this.announceCard(vault, card);
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
        if (worker !== '' && worker !== 'opencode' && worker !== 'claude-code' && worker !== 'kimi') {
          return { ok: false, error: 'the worker is "opencode", "claude-code" or "kimi"' };
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
   * The owner's own persona (E10-6): `personas/you`, kind `human`, next to
   * Paul, Ben, Ralf and Tessa. Created once when absent (idempotent - an
   * existing file is the owner's and stays as written); its title is the
   * config `personas.humanName` ('You' by default) and is editable like
   * any persona's. One commit `tickets: you persona`. A failure logs.
   * Called where the persona is first shown (the Team list, the flow editor) -
   * never on a plain board refresh, so a vault nobody opens it in stays untouched.
   */
  /** The configured display name of the human persona (`personas.humanName`), 'You' when unset or blank. */
  private async humanNameOfConfig(): Promise<string> {
    return (((await this.host.configGet<string>('personas.humanName')) ?? '').trim()) || 'You';
  }

  /**
   * Renames the human persona (Settings -> Tickets -> Team, "Your name"): the persona file's
   * title is what every surface shows (column pins, Team, the flow editor, the phone), so the
   * rename is one `personaPatch`; a missing persona is created first. Blank = back to "You".
   * The caller stores the same name in config `personas.humanName` so new boards start with it.
   */
  async setHumanName(name: string): Promise<BoardMutationResult> {
    const title = name.trim() === '' ? 'You' : name.trim();
    await this.ensureHumanPersona();
    return this.personaPatch({ id: HUMAN_PERSONA_ID, title });
  }

  ensureHumanPersona(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const vault = await this.detect();
        if (vault === null) {
          return;
        }
        const personaPath = `${PERSONAS_DIR}/${HUMAN_PERSONA_ID}/persona.md`;
        if ((await this.readOptional(vault.id, personaPath)) !== null) {
          return;
        }
        await this.host.write(vault.id, personaPath, personaFileText(humanPersona(await this.humanNameOfConfig())));
        await this.commit(vault, [personaPath], 'tickets: you persona');
        this.host.announceChanges(vault.id, [personaPath]);
        this.announceChanged();
      } catch (error) {
        this.host.log(`human persona setup failed: ${messageOf(error)}`, 'warn');
      }
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
            kind: 'agent',
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
      const humanPersonaPath = `${PERSONAS_DIR}/${HUMAN_PERSONA_ID}/persona.md`;
      try {
        await this.host.write(target.id, PIPELINE_PATH, DEFAULT_PIPELINE);
        await this.host.write(target.id, REPOS_PATH, DEFAULT_REPOS);
        await this.host.write(target.id, humanPersonaPath, personaFileText(humanPersona(await this.humanNameOfConfig())));
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
        [PIPELINE_PATH, REPOS_PATH, humanPersonaPath, ...promptPaths],
        'tickets: initialize board',
      );
      this.host.announceChanges(target.id, [PIPELINE_PATH, REPOS_PATH, humanPersonaPath, ...promptPaths]);
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