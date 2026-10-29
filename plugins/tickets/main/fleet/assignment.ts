/**
 * The fleet's worker assignment (M84; the owner's ruling): for different
 * tasks, different workers — resolved ticket-first, then the pipeline
 * phase's handover pin, then the work repo's default, then the plugin's
 * configured default, then the fleet's first provider.
 *
 * Worker values name a provider and optionally pin a model:
 * `opencode`, `claude-code`, `claude-code/sonnet`. An unreadable value
 * is a refusal at run start — never a guess (ADR-0076).
 */
import { isWorkerProvider, type FleetCaps, type WorkerProviderId } from './protocol';
import { parseHandover } from '../../shared/tickets';
import { capHead, capTail } from './capping';

export type AssignmentSource = 'ticket' | 'column' | 'handover' | 'repo' | 'default';

export interface WorkerChoice {
  readonly provider: WorkerProviderId;
  readonly model: string | null;
  readonly source: AssignmentSource;
}

/** `<provider>` or `<provider>/<model>` — null when unreadable. */
export function parseWorkerValue(value: string): { provider: WorkerProviderId; model: string | null } | null {
  const text = value.trim();
  const slashAt = text.indexOf('/');
  const providerPart = slashAt === -1 ? text : text.slice(0, slashAt);
  const modelPart = slashAt === -1 ? null : text.slice(slashAt + 1);
  if (!isWorkerProvider(providerPart)) {
    return null;
  }
  return { provider: providerPart, model: modelPart !== null && modelPart !== '' ? modelPart : null };
}

export interface AssignmentInput {
  /** The ticket's `worker:` frontmatter pin (raw, may be null). */
  readonly ticketWorker: string | null;
  /** The working column's `worker:` key (M85) — between ticket and handover. */
  readonly columnWorker?: string | null;
  /** The working column's `model:` key (M85) — wins over a model inside a pin. */
  readonly columnModel?: string | null;
  /** The phase's raw handover spec (`agent build-default@opencode`). */
  readonly handover: string | null;
  /** The work repo's `worker:` default from `_meta/repos.md`. */
  readonly repoWorker: string | null;
  /** The plugin's configured default worker. */
  readonly configuredDefault: string | null;
}

export type Assignment =
  | ({ readonly ok: true; readonly promptRef: string | null } & WorkerChoice)
  | { readonly ok: false; readonly error: string };

/**
 * Resolves who runs the ticket. Handover modes other than `agent` do
 * not constrain the assignment — the owner can start an on-demand run
 * from any phase (ADR-0075: M84 runs are on-demand); the handover only
 * contributes its `@worker` pin and its prompt ref.
 */
export function resolveAssignment(input: AssignmentInput): Assignment {
  const candidates: ReadonlyArray<{ source: AssignmentSource; value: string | null }> = [
    { source: 'ticket', value: input.ticketWorker },
    { source: 'column', value: input.columnWorker ?? null },
    { source: 'handover', value: input.handover === null ? null : parseHandoverWorkerValue(input.handover) },
    { source: 'repo', value: input.repoWorker },
    { source: 'default', value: input.configuredDefault },
  ];
  for (const candidate of candidates) {
    if (candidate.value === null || candidate.value.trim() === '') {
      continue;
    }
    const parsed = parseWorkerValue(candidate.value);
    if (parsed === null) {
      if (candidate.source === 'ticket' || candidate.source === 'handover' || candidate.source === 'column') {
        // An explicit-but-unreadable pin is a refusal, not a fallback.
        return { ok: false, error: `the ${candidate.source}'s worker "${candidate.value}" is unknown — use opencode or claude-code` };
      }
      continue; // a stale repo/config default degrades to the next level
    }
    const model = input.columnModel !== undefined && input.columnModel !== null && input.columnModel.trim() !== ''
      ? input.columnModel.trim()
      : parsed.model;
    return {
      ok: true,
      provider: parsed.provider,
      model,
      source: candidate.source,
      promptRef: promptRefOf(input.handover),
    };
  }
  const fallbackModel = input.columnModel !== undefined && input.columnModel !== null && input.columnModel.trim() !== ''
    ? input.columnModel.trim()
    : null;
  return { ok: true, provider: 'opencode', model: fallbackModel, source: 'default', promptRef: promptRefOf(input.handover) };
}


function parseHandoverWorkerValue(handover: string): string | null {
  return parseHandover(handover).worker;
}

function promptRefOf(handover: string | null): string | null {
  return handover === null ? null : parseHandover(handover).promptRef;
}

// ---------------------------------------------------------------------------
// The instruction the worker receives (T-0048: the context pack — stable
// parts first so the prompt prefix stays identical across runs, variable
// parts last).

export interface InstructionInput {
  readonly ticketId: string;
  readonly title: string;
  readonly repo: string | null;
  readonly branch: string;
  readonly worktreePath: string;
  readonly phase: string;
  readonly description: string;
  readonly plan: string | null;
  readonly prompt: string | null;
  readonly acceptance: readonly string[];
  /**
   * Absolute path of the ticket file in the tickets repo (outside the
   * worktree). Named in the brief so the worker never has to hunt the
   * disk for it — a plan-phase worker spent most of a run doing that.
   */
  readonly ticketFile?: string;
  /**
   * The work repo's agent instructions (`CLAUDE.md` preferred,
   * `AGENTS.md` fallback), read by the caller: inlined VERBATIM as the
   * instruction's first section, never capped — the CLI's own auto-load
   * differs by provider and version and cannot be the cache-stability
   * anchor.
   */
  readonly repoInstructions: string | null;
  /** The worktree's raw `git diff --stat` vs the base; capped here (head). */
  readonly diffStat: string | null;
  /** The previous run's raw gate failure; capped here (tail). */
  readonly gateFailure: string | null;
  /** The output caps; the caller resolves them from `fleet.cap.*`. */
  readonly caps: FleetCaps;
  /** The repo's `link:` folders the runner links into the worktree (req-56). */
  readonly links?: readonly string[];
}

/** One capped section of the instruction — the caller logs each application. */
export interface Truncation {
  readonly section: 'diffStat' | 'gateFailure';
  readonly originalSize: number;
}

export interface ComposedInstruction {
  readonly text: string;
  readonly truncations: readonly Truncation[];
}

/**
 * The completion discipline every run brief ends with (M85, ADR-0077):
 * step completion is the agent's call — its finished turn is the
 * declaration — and the machine gate is the safety net under it, not an
 * independent mover.
 */
const COMPLETION_DISCIPLINE =
  'Completion discipline: work the step, then run the gate commands above yourself and fix what they surface. ' +
  'Declare the step done only when every command passes and you consider the work ready — your finished turn is ' +
  'that declaration. After it the runner re-runs the gate: green moves the ticket one column right; a red gate ' +
  'parks the step (the failure is logged and the ticket waits).';

/**
 * Composes the run's instruction as a context pack (T-0048), in this
 * order — stable first, so the prefix up to the `## Plan` heading is
 * byte-identical for any two runs of the same repo and phase:
 *
 * 1. the repo's agent instructions, verbatim;
 * 2. the phase instruction template;
 * 3. `## Plan` verbatim;
 * 4. the variable parts: who/where, the description, the diff stat
 *    (head-capped), the previous run's gate failure on a retry
 *    (tail-capped), the gate commands, the completion discipline.
 *
 * Deterministic text — no model involved; the capping is reported, never
 * marked inside the text (bookkeeping the model does not need).
 */
export function composeInstruction(input: InstructionInput): ComposedInstruction {
  const parts: string[] = [];
  const truncations: Truncation[] = [];

  const repoInstructions = input.repoInstructions?.trim();
  if (repoInstructions != null && repoInstructions !== '') {
    parts.push(repoInstructions);
  }
  const prompt = input.prompt?.trim();
  if (prompt != null && prompt !== '') {
    parts.push(prompt);
  }
  const plan = input.plan?.trim();
  if (plan != null && plan !== '') {
    parts.push(`## Plan\n\n${plan}`);
  }

  parts.push(`You are working ticket ${input.ticketId} — ${input.title}.`);
  parts.push(
    `Work checkout: ${input.worktreePath} (branch ${input.branch}` +
      (input.repo !== null ? `, repo ${input.repo}` : '') +
      `). Stay on that branch; it and the worktree are your only writable places.`,
  );
  parts.push(`The ticket sits in the "${input.phase}" phase of the owner's board.`);
  if (input.links !== undefined && input.links.length > 0) {
    // Workers used to probe for the toolchain and improvise — junctions
    // of their own, even an install — in every run (req-56).
    parts.push(
      `Toolchain: ${input.links.map((l) => `\`${l}\``).join(', ')} ${input.links.length === 1 ? 'is' : 'are'} linked into the ` +
        `checkout from the repo's main folder, ready to use. Do not run an install (npm ci, npm install, …) and do not ` +
        `create or replace links: the folders are shared with the owner's checkout.`,
    );
  }
  if (input.ticketFile !== undefined && input.ticketFile !== '') {
    parts.push(
      `The ticket file: ${input.ticketFile} — it lives in the tickets repo, outside the worktree, and is the one ` +
        `file besides the worktree you may edit (the plan and the Log go there). Use this path directly; do not search the disk for it.`,
    );
  }
  const description = input.description.trim();
  if (input.ticketFile !== undefined && input.ticketFile !== '' && (description !== '' || plan !== null)) {
    // The worker re-read the whole ticket file first thing in every run
    // (req-55): a second copy of what this brief already carries, paid
    // again by every model call of the run.
    parts.push(
      'The ticket\'s description' +
        (plan != null && plan !== '' ? ' and plan are' : ' is') +
        ' quoted in full in this brief — do not read the ticket file to learn them. When you edit it, read only the ' +
        'section you change (the Log is at its end: read its last lines).',
    );
  }
  if (description !== '') {
    parts.push(`What and why:\n${description}`);
  }
  const diffStat = input.diffStat?.trim();
  if (diffStat != null && diffStat !== '') {
    const capped = capHead(input.diffStat!, { lines: input.caps.diffStatLines, bytes: input.caps.diffStatBytes });
    if (capped.truncated) {
      truncations.push({ section: 'diffStat', originalSize: capped.originalSize });
    }
    parts.push(
      `The branch so far — \`git diff --stat\` against the base (committed and uncommitted):\n\n${capped.text}`,
    );
  }
  const gateFailure = input.gateFailure?.trim();
  if (gateFailure != null && gateFailure !== '') {
    const capped = capTail(input.gateFailure!, {
      lines: input.caps.gateFailureLines,
      bytes: input.caps.gateFailureBytes,
    });
    if (capped.truncated) {
      truncations.push({ section: 'gateFailure', originalSize: capped.originalSize });
    }
    parts.push(
      `The previous run failed the machine gate — fix this first. The branch already holds the earlier work, ` +
        `so continue from the existing diff instead of starting over. The failure's tail:\n\n${capped.text}`,
    );
  }
  if (input.acceptance.length > 0) {
    parts.push(
      'The machine gate runs exactly these after you finish — keep them green, and commit your work on the branch before you end:\n' +
        input.acceptance.map((command) => `- \`${command}\``).join('\n'),
    );
  }
  parts.push(COMPLETION_DISCIPLINE);
  return { text: parts.join('\n\n'), truncations };
}
