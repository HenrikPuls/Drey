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
import { isWorkerProvider, QUESTION_MARKER, type WorkerProviderId } from './protocol';
import { parseHandover } from '../../shared/tickets';

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
// The instruction the worker receives.

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
  /** The repo's `link:` folders the runner links into the worktree (req-56). */
  readonly links?: readonly string[];
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
 * How a worker asks the owner (req-57): a turn whose last message opens
 * with the marker does not end the run — the run waits, the owner is
 * notified, and the answer arrives in this same session.
 */
const ASKING =
  `Asking the owner: if you cannot go on without a decision only the owner can make, end your turn with a message ` +
  `that starts with \`${QUESTION_MARKER}\` followed by the question (and the options you see, if any). The run then ` +
  `waits, the owner is notified, and their answer arrives here in this session; continue the step from it. Ask only ` +
  `what blocks the step — what the plan, the ticket or the repo already answers, decide yourself; open points that ` +
  `can wait go into the ticket's Log.`;

/**
 * Composes the run's instruction: who and where the worker is, what the
 * ticket says (description + plan), the fleet's rules (stay on the
 * branch, leave the worktree the only place), the machine gate it
 * must keep green, and the completion discipline. Deterministic text —
 * no model involved.
 */
export function composeInstruction(input: InstructionInput): string {
  const parts: string[] = [];
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
  const plan = input.plan?.trim() ?? '';
  if (input.ticketFile !== undefined && input.ticketFile !== '' && (description !== '' || plan !== '')) {
    // The worker re-read the whole ticket file first thing in every run
    // (req-55): a second copy of what follows here, carried by every
    // model call of the run.
    parts.push(
      'The ticket\'s description' +
        (plan !== '' ? ' and plan are' : ' is') +
        ' quoted in full below — do not read the ticket file to learn them. When you edit it, read only the ' +
        'section you change (the Log is at its end: read its last lines).',
    );
  }
  if (description !== '') {
    parts.push(`What and why:\n${description}`);
  }
  if (plan !== '') {
    parts.push(`The ticket's plan:\n${plan}`);
  }
  if (input.prompt !== null && input.prompt.trim() !== '') {
    parts.push(`The phase's prompt:\n${input.prompt.trim()}`);
  }
  if (input.acceptance.length > 0) {
    parts.push(
      'The machine gate runs exactly these after you finish — keep them green, and commit your work on the branch before you end:\n' +
        input.acceptance.map((command) => `- \`${command}\``).join('\n'),
    );
  }
  parts.push(COMPLETION_DISCIPLINE);
  parts.push(ASKING);
  return parts.join('\n\n');
}
