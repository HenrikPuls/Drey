/**
 * The one place a RunRequest is built (M85): Drey's board service (an
 * owner-started run) and the runner's orchestrator (a dispatched run)
 * both come through here, so the request they hand the supervisor —
 * worker ladder, model pin, prompt ref, move target, claim identity —
 * cannot drift. Pure: file reads (the prompt text, the ticket text)
 * stay with the caller.
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import {
  branchForTicket,
  type PipelinePhase,
  type RepoRef,
  type TicketCard,
} from '../contracts/tickets';
import { acceptanceCommands, ticketSections } from '../core/ticket-files';
import { composeInstruction, parseWorkerValue, resolveAssignment, type Truncation } from './assignment';
import { personaMemorySection } from './context-pack';
import { DEFAULT_FLEET_CAPS, type FleetCaps, type HandoverMode, type InteractiveMode, type PermissionMode, type RunRequest, type WorkerProviderId } from './protocol';
import { worktreePathFor } from './worktree-home';

export interface ComposeRunInput {
  readonly card: TicketCard;
  /** The ticket file's full text. */
  readonly ticketText: string;
  /** Absolute path of the tickets vault. */
  readonly vaultPath: string;
  /** The working column's phase config (for an owner run: the phase the
   *  ticket sits in — the two are the same there). */
  readonly workingPhase: PipelinePhase | null;
  /** The move target on a green gate, or null to end the run in place. */
  readonly nextPhaseId: string | null;
  /** The directory the green move writes into (T-0041: resolved against
   *  the dirs on disk, `resolvePhaseDir`); null = the bare phase id. */
  readonly nextPhaseDir: string | null;
  /** pipeline.md's `push:` remote (T-0041); null = never push. */
  readonly pushRemote: string | null;
  /** Whether `nextPhaseId` claims (claim: true) — stamps the agent identity. */
  readonly nextPhaseClaims: boolean;
  readonly repo: RepoRef | null;
  /**
   * The ticket's further work repos (req-72), already resolved and
   * primary-excluded by the caller — one worktree each on the same
   * branch. A repo without a local path is refused here, like the
   * primary's.
   */
  readonly extraRepos?: readonly RepoRef[];
  /** The prompt file's text, when the assignment names one (read by the caller). */
  readonly promptText: string | null;
  readonly defaultWorker: string;
  readonly permissionMode: PermissionMode;
  /** The plugin's gitPath ('' = `git`). */
  readonly gitPath: string;
  /** The run dialog's explicit worker choice (owner runs only). */
  readonly workerChoice: string | null;
  /**
   * The work repo's agent instructions (T-0048 context pack), read by the
   * caller; null = the repo carries none.
   */
  readonly repoInstructions: string | null;
  /** The worktree's raw diff stat (T-0048), read by the caller; null = none. */
  readonly diffStat: string | null;
  /** The previous run's raw gate failure (T-0048 retry), read by the caller; null = a first run. */
  readonly gateFailure: string | null;
  /** The instruction output caps (T-0048); absent = `DEFAULT_FLEET_CAPS`. */
  readonly caps?: FleetCaps;
  /**
   * Set by the orchestrator for the pipeline's first worker column: a
   * ticket entering there carries no acceptance criteria yet (writing
   * them is the plan's job), so the run gates structurally — the gate
   * then checks the criteria came into existence — instead of refusing.
   */
  readonly structuralGateAllowed?: boolean;
  /** Set when the orchestrator dispatches — the pool whose slot this run occupies. */
  readonly dispatchedBy?: string;
  /**
   * The handover ask (T-0049): the start dialog's explicit mode, or
   * 'auto' from the dispatcher — absent (an older caller) means fresh.
   */
  readonly handover?: HandoverMode | 'auto';
  /**
   * The owner drives this run as a dialog (req-65): the acceptance
   * refusal is lifted, the brief's completion discipline becomes the
   * dialog discipline, and the request carries the mode so the runner
   * holds the worker from turn one and never gates or moves.
   */
  readonly interactive?: InteractiveMode;
  /**
   * The persona the dispatch resolved (E3, ADR-0088) — the ladder's
   * winner, loaded from the vault by the caller; null = the assignment
   * ring decides everything, exactly as before personas.
   */
  readonly persona?: PersonaDispatch | null;
}

/**
 * What a resolved persona contributes to a dispatch (E3): the worker
 * harness and model pin (`deriveWorkerModel` with a null context
 * estimate), its prompt as the instruction base instead of the phase
 * handover prompt, and its curated memory for the instruction's
 * `## Memory` slice.
 */
export interface PersonaDispatch {
  /** The persona id — what `RunInfo.persona` stamps and the report groups by. */
  readonly id: string;
  /** The harness pin (`opencode` | `claude-code`; anything unreadable leaves the ring in charge). */
  readonly worker: string;
  /** The model pin. */
  readonly model: string;
  /** The persona's prompt text; null/blank = the phase prompt stands. */
  readonly prompt: string | null;
  /** The persona's memory text ('' when the file is absent). */
  readonly memory: string;
}

export type ComposeRunResult =
  | {
      readonly ok: true;
      readonly request: RunRequest;
      readonly truncations: readonly Truncation[];
      /**
       * The resolved persona id for the supervisor to stamp on
       * `RunInfo.persona` (null on ring dispatches) — the request itself
       * stays the wire shape it always was.
       */
      readonly persona: string | null;
    }
  | { readonly ok: false; readonly error: string };

export function composeRunRequest(input: ComposeRunInput): ComposeRunResult {
  if (input.repo === null) {
    return {
      ok: false,
      error: `${input.card.id} names no repository — set repo: to a _meta/repos.md entry`,
    };
  }
  if (input.repo.path === null) {
    return {
      ok: false,
      error: `"${input.repo.name}" has no local path: in _meta/repos.md — the worker needs a checkout`,
    };
  }
  // req-72: every extra repo needs a checkout too — the fleet prepares
  // one worktree per repo before the run starts.
  const extraRepos: {
    name: string;
    repoPath: string;
    worktreePath: string;
    baseRef: string | null;
    links?: readonly string[];
  }[] = [];
  for (const extra of input.extraRepos ?? []) {
    if (extra.name === input.repo.name) {
      continue; // the primary twice would prepare one worktree twice
    }
    if (extra.path === null) {
      return {
        ok: false,
        error: `"${extra.name}" has no local path: in _meta/repos.md — the ticket names it beside ${input.repo.name}`,
      };
    }
    extraRepos.push({
      name: extra.name,
      repoPath: extra.path,
      worktreePath: worktreePathFor(input.vaultPath, extra, input.card.id),
      baseRef: extra.branch,
      ...(extra.link !== undefined && extra.link.length > 0 ? { links: [...extra.link] } : {}),
    });
  }
  const acceptance = acceptanceCommands(input.ticketText);
  if (acceptance.length === 0 && input.structuralGateAllowed !== true && input.interactive === undefined) {
    return {
      ok: false,
      error: `${input.card.id} has no acceptance criteria — the machine gate would have nothing to run`,
    };
  }
  const handover = input.workingPhase?.handover ?? null;
  const assignment = resolveAssignment({
    ticketWorker: input.workerChoice ?? input.card.meta.worker,
    columnWorker: input.workingPhase?.worker ?? null,
    columnModel: input.workingPhase?.model ?? null,
    handover,
    repoWorker: input.repo.worker,
    configuredDefault: input.defaultWorker,
  });
  // E3: a loaded persona beats the legacy ring for provider and model —
  // a harness the fleet cannot run (an 'api' persona) leaves the ring's
  // choice in place, as does every ring refusal when no persona resolved.
  // An owner-picked worker in the start dialog still wins over the
  // persona (the concept's override order: the owner is the final
  // authority); the persona's prompt and memory apply regardless.
  const persona = input.persona ?? null;
  const personaWorker = persona !== null ? parseWorkerValue(persona.worker) : null;
  const ownerPicked = (input.workerChoice ?? null) !== null;
  let provider: WorkerProviderId;
  let model: string | null;
  if (persona !== null && personaWorker !== null && !ownerPicked) {
    provider = personaWorker.provider;
    model = persona.model;
  } else if (assignment.ok) {
    provider = assignment.provider;
    model = assignment.model;
  } else {
    return { ok: false, error: assignment.error };
  }
  const personaPrompt = persona !== null && persona.prompt !== null && persona.prompt.trim() !== '' ? persona.prompt : null;
  const promptText = personaPrompt ?? input.promptText;
  const branch = input.card.meta.branch ?? branchForTicket(input.card.id);
  // The worktree's home (ADR-0080): computed here, carried on the
  // request — the runner never derives paths, and the brief names the
  // absolute location so the worker never has to find it.
  const worktreePath = worktreePathFor(input.vaultPath, input.repo, input.card.id);
  const sections = ticketSections(input.ticketText);
  const instruction = composeInstruction({
    ticketId: input.card.id,
    title: input.card.meta.title ?? input.card.id,
    repo: input.repo.name,
    branch,
    worktreePath,
    phase: input.card.phase,
    description: sections.description,
    plan: sections.plan,
    handover: sections.handover,
    prompt: promptText,
    acceptance,
    ticketFile: path.join(input.vaultPath, input.card.path),
    ...(input.repo.link !== undefined && input.repo.link.length > 0 ? { links: input.repo.link } : {}),
    ...(extraRepos.length > 0
      ? { extraRepos: extraRepos.map((r) => ({ name: r.name, worktreePath: r.worktreePath, base: r.baseRef })) }
      : {}),
    repoInstructions: input.repoInstructions,
    diffStat: input.diffStat,
    gateFailure: input.gateFailure,
    caps: input.caps ?? DEFAULT_FLEET_CAPS,
    ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
    ...(persona !== null ? { memorySection: personaMemorySection(persona.memory) } : {}),
  });
  const request: RunRequest = {
    ticketId: input.card.id,
    ticketsVaultPath: input.vaultPath,
    ticketRelPath: input.card.path,
    phase: input.card.phase,
    repoPath: input.repo.path,
    worktreePath,
    branch,
    baseRef: input.repo.branch,
    ...(input.repo.link !== undefined && input.repo.link.length > 0 ? { links: input.repo.link } : {}),
    ...(extraRepos.length > 0 ? { extraRepos } : {}),
    provider,
    model,
    permissionMode: input.permissionMode,
    instruction: instruction.text,
    continuationInstruction: instruction.continuation,
    briefDigest: createHash('sha256').update(instruction.stable).digest('hex'),
    acceptance,
    gate: acceptance.length > 0 ? 'commands' : 'structural',
    git: input.gitPath.trim() === '' ? 'git' : input.gitPath.trim(),
    // An interactive dialog never moves: the move target stays null even
    // if a caller passed one — the owner moves the ticket (req-65).
    nextPhase: input.interactive !== undefined ? null : input.nextPhaseId,
    nextPhaseDir: input.interactive !== undefined || input.nextPhaseId === null ? null : input.nextPhaseDir,
    pushRemote: input.pushRemote,
    claimIdentity: input.nextPhaseClaims && input.nextPhaseId !== null && input.interactive === undefined ? agentIdentity() : null,
    ...(limitsOf(input.workingPhase) !== null ? { limits: limitsOf(input.workingPhase)! } : {}),
    ...(input.workerChoice !== null ? { recordWorker: input.workerChoice } : {}),
    ...(input.dispatchedBy !== undefined ? { column: input.dispatchedBy } : {}),
    ...(input.handover !== undefined ? { handover: input.handover } : {}),
    ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
  };
  return { ok: true, request, truncations: instruction.truncations, persona: persona?.id ?? null };
}

/** The column's own ceilings as the request carries them, or null when it sets none. */
function limitsOf(phase: PipelinePhase | null): { maxTurns?: number; maxWorkMs?: number } | null {
  if (phase === null || (phase.maxTurns === null && phase.maxWorkMin === null)) {
    return null;
  }
  return {
    ...(phase.maxTurns !== null ? { maxTurns: phase.maxTurns } : {}),
    ...(phase.maxWorkMin !== null ? { maxWorkMs: phase.maxWorkMin * 60_000 } : {}),
  };
}

/** The fleet's actor identity for stamps (`agent@<host>`). */
export function agentIdentity(): string {
  return `agent@${hostname().toLowerCase()}`;
}
