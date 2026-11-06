/**
 * The one place a RunRequest is built (M85): Drey's board service (an
 * owner-started run) and the runner's orchestrator (a dispatched run)
 * both come through here, so the request they hand the supervisor —
 * worker ladder, model pin, prompt ref, move target, claim identity,
 * and since E8 the ticket's form (a scout ticket composes an
 * exploration, not a build) — cannot drift. Pure: file reads (the
 * prompt text, the ticket text) stay with the caller.
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
import { composeInstruction, composeScoutInstruction, parseWorkerValue, resolveAssignment, type Truncation } from './assignment';
import { personaCoachingSection, personaMemorySection } from './context-pack';
import { DEFAULT_FLEET_CAPS, type FleetCaps, type HandoverMode, type InteractiveMode, type PermissionMode, type RunDkTarget, type RunRequest, type WorkerProviderId } from './protocol';
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
  /** E10-6: park the ticket for this human persona after a green gate instead of moving it on. */
  readonly parkFor?: string | null;
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
  /** E14-5: the ticket lives in a dricket store - the run claims and releases it through `dk`. */
  readonly dk?: RunDkTarget;
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
  /** The harness pin (`opencode` | `claude-code` | `kimi`; anything unreadable leaves the ring in charge). */
  readonly worker: string;
  /** The model pin. */
  readonly model: string;
  /** The persona's prompt text; null/blank = the phase prompt stands. */
  readonly prompt: string | null;
  /** The persona's memory text ('' when the file is absent). */
  readonly memory: string;
  /** The persona's coaching thread text ('' when thread.md is absent) — U4. */
  readonly coaching: string;
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
  // A scout ticket (form: scout, E8, concept §5.6) runs an exploration,
  // not a build: no worktree is prepared — the named repo's checkout
  // (else the tickets vault itself) is the run's read ground, the gate
  // is 'none' and nothing moves. A NAMED repo still needs a local path
  // (a ticket pointing at an unreadable checkout is a refusal, never a
  // guess); only a ticket naming no repo at all falls back to the vault.
  const scout = (input.card.meta.form ?? 'ship') === 'scout';
  const repo = input.repo;
  if (repo === null && !scout) {
    return {
      ok: false,
      error: `${input.card.id} names no repository — set repo: to a _meta/repos.md entry`,
    };
  }
  if (repo !== null && repo.path === null) {
    return {
      ok: false,
      error: `"${repo.name}" has no local path: in _meta/repos.md — the worker needs a checkout`,
    };
  }
  // req-72: every extra repo needs a checkout too — the fleet prepares
  // one worktree per repo before a ship run starts. A scout run reads
  // them in place instead: named read grounds, never a prepared tree.
  const extraRepos: {
    name: string;
    repoPath: string;
    worktreePath: string;
    baseRef: string | null;
    links?: readonly string[];
  }[] = [];
  const extraReadGrounds: { name: string; path: string }[] = [];
  for (const extra of input.extraRepos ?? []) {
    if (repo !== null && extra.name === repo.name) {
      continue; // the primary twice would prepare one worktree twice
    }
    if (extra.path === null) {
      return {
        ok: false,
        error: `"${extra.name}" has no local path: in _meta/repos.md — the ticket names it beside ${repo?.name ?? 'no primary repo'}`,
      };
    }
    if (scout) {
      extraReadGrounds.push({ name: extra.name, path: extra.path });
    } else {
      extraRepos.push({
        name: extra.name,
        repoPath: extra.path,
        worktreePath: worktreePathFor(input.vaultPath, extra, input.card.id),
        baseRef: extra.branch,
        ...(extra.link !== undefined && extra.link.length > 0 ? { links: [...extra.link] } : {}),
      });
    }
  }
  // A scout run has no machine gate (concept §5.6) — no acceptance
  // commands are demanded, carried or run.
  const acceptance = scout ? [] : acceptanceCommands(input.ticketText);
  if (acceptance.length === 0 && !scout && input.structuralGateAllowed !== true && input.interactive === undefined) {
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
    repoWorker: repo?.worker ?? null,
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
  const sections = ticketSections(input.ticketText);
  const ticketFile = path.join(input.vaultPath, input.card.path);
  // The scout run's directory is its read ground — the named repo's
  // checkout, else the tickets vault — computed here and carried on the
  // request like the worktree home (ADR-0080): the runner never derives
  // paths, and the brief names the absolute location so the worker never
  // has to find it. No worktree is ever prepared there.
  const readGround = repo?.path ?? input.vaultPath;
  const worktreePath = scout ? readGround : worktreePathFor(input.vaultPath, repo!, input.card.id);
  const instruction = scout
    ? composeScoutInstruction({
        ticketId: input.card.id,
        title: input.card.meta.title ?? input.card.id,
        readGround,
        repoName: repo?.name ?? null,
        ticketFile,
        phase: input.card.phase,
        description: sections.description,
        plan: sections.plan,
        prompt: promptText,
        repoInstructions: input.repoInstructions,
        ...(extraReadGrounds.length > 0 ? { extraRepos: extraReadGrounds } : {}),
        ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
        ...(persona !== null
          ? { memorySection: personaMemorySection(persona.memory), coachingSection: personaCoachingSection(persona.coaching), personaId: persona.id }
          : {}),
      })
    : composeInstruction({
        ticketId: input.card.id,
        title: input.card.meta.title ?? input.card.id,
        repo: repo!.name,
        branch,
        worktreePath,
        phase: input.card.phase,
        description: sections.description,
        plan: sections.plan,
        handover: sections.handover,
        prompt: promptText,
        acceptance,
        ticketFile,
        ...(repo!.link !== undefined && repo!.link.length > 0 ? { links: repo!.link } : {}),
        ...(extraRepos.length > 0
          ? { extraRepos: extraRepos.map((r) => ({ name: r.name, worktreePath: r.worktreePath, base: r.baseRef })) }
          : {}),
        repoInstructions: input.repoInstructions,
        diffStat: input.diffStat,
        gateFailure: input.gateFailure,
        caps: input.caps ?? DEFAULT_FLEET_CAPS,
        ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
        ...(persona !== null
          ? { memorySection: personaMemorySection(persona.memory), coachingSection: personaCoachingSection(persona.coaching) }
          : {}),
      });
  // A scout run never gates and never moves (concept §5.6) — the same
  // move-target rule as an interactive dialog: the ticket stays where it
  // sits until the owner promotes it from the report card.
  const moves = !scout && input.interactive === undefined;
  const request: RunRequest = {
    ticketId: input.card.id,
    ...(scout ? { form: 'scout' as const } : {}),
    ticketsVaultPath: input.vaultPath,
    ticketRelPath: input.card.path,
    phase: input.card.phase,
    repoPath: readGround,
    worktreePath,
    branch,
    baseRef: scout ? null : repo!.branch,
    ...(repo !== null && !scout && repo.link !== undefined && repo.link.length > 0 ? { links: repo.link } : {}),
    ...(extraRepos.length > 0 ? { extraRepos } : {}),
    provider,
    model,
    permissionMode: input.permissionMode,
    instruction: instruction.text,
    continuationInstruction: instruction.continuation,
    briefDigest: createHash('sha256').update(instruction.stable).digest('hex'),
    acceptance,
    gate: scout ? 'none' : acceptance.length > 0 ? 'commands' : 'structural',
    git: input.gitPath.trim() === '' ? 'git' : input.gitPath.trim(),
    nextPhase: moves ? input.nextPhaseId : null,
    nextPhaseDir: !moves || input.nextPhaseId === null ? null : input.nextPhaseDir,
    pushRemote: input.pushRemote,
    claimIdentity: moves && input.nextPhaseClaims && input.nextPhaseId !== null ? agentIdentity() : null,
    ...(limitsOf(input.workingPhase) !== null ? { limits: limitsOf(input.workingPhase)! } : {}),
    ...(input.workerChoice !== null ? { recordWorker: input.workerChoice } : {}),
    ...(input.dispatchedBy !== undefined ? { column: input.dispatchedBy } : {}),
    ...(input.handover !== undefined ? { handover: input.handover } : {}),
    ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
    ...(input.dk !== undefined ? { dk: input.dk } : {}),
    ...(moves && input.parkFor ? { parkFor: input.parkFor } : {}),
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
