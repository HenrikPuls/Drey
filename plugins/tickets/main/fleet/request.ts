/**
 * The one place a RunRequest is built (M85): Drey's board service (an
 * owner-started run) and the runner's orchestrator (a dispatched run)
 * both come through here, so the request they hand the supervisor —
 * worker ladder, model pin, prompt ref, move target, claim identity —
 * cannot drift. Pure: file reads (the prompt text, the ticket text)
 * stay with the caller.
 */
import { hostname } from 'node:os';
import path from 'node:path';
import {
  branchForTicket,
  type PipelinePhase,
  type RepoRef,
  type TicketCard,
} from '../../shared/tickets';
import { acceptanceCommands, ticketSections } from '../ticket-files';
import { composeInstruction, resolveAssignment, type Truncation } from './assignment';
import { DEFAULT_FLEET_CAPS, type FleetCaps, type HandoverMode, type PermissionMode, type RunRequest } from './protocol';
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
}

export type ComposeRunResult =
  | { readonly ok: true; readonly request: RunRequest; readonly truncations: readonly Truncation[] }
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
  const acceptance = acceptanceCommands(input.ticketText);
  if (acceptance.length === 0 && input.structuralGateAllowed !== true) {
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
  if (!assignment.ok) {
    return { ok: false, error: assignment.error };
  }
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
    prompt: input.promptText,
    acceptance,
    ticketFile: path.join(input.vaultPath, input.card.path),
    ...(input.repo.link !== undefined && input.repo.link.length > 0 ? { links: input.repo.link } : {}),
    repoInstructions: input.repoInstructions,
    diffStat: input.diffStat,
    gateFailure: input.gateFailure,
    caps: input.caps ?? DEFAULT_FLEET_CAPS,
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
    ...(input.repo.link !== undefined && input.repo.link.length > 0 ? { links: input.repo.link } : {}),
    provider: assignment.provider,
    model: assignment.model,
    permissionMode: input.permissionMode,
    instruction: instruction.text,
    acceptance,
    gate: acceptance.length > 0 ? 'commands' : 'structural',
    git: input.gitPath.trim() === '' ? 'git' : input.gitPath.trim(),
    nextPhase: input.nextPhaseId,
    nextPhaseDir: input.nextPhaseId === null ? null : input.nextPhaseDir,
    pushRemote: input.pushRemote,
    claimIdentity: input.nextPhaseClaims && input.nextPhaseId !== null ? agentIdentity() : null,
    ...(input.workerChoice !== null ? { recordWorker: input.workerChoice } : {}),
    ...(input.dispatchedBy !== undefined ? { column: input.dispatchedBy } : {}),
    ...(input.handover !== undefined ? { handover: input.handover } : {}),
  };
  return { ok: true, request, truncations: instruction.truncations };
}

/** The fleet's actor identity for stamps (`agent@<host>`). */
export function agentIdentity(): string {
  return `agent@${hostname().toLowerCase()}`;
}
