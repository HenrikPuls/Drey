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
import { isWorkerProvider, type WorkerProviderId } from './protocol';
import { parseHandover } from '../../shared/tickets';

export type AssignmentSource = 'ticket' | 'handover' | 'repo' | 'default';

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
      if (candidate.source === 'ticket' || candidate.source === 'handover') {
        // An explicit-but-unreadable pin is a refusal, not a fallback.
        return { ok: false, error: `the ${candidate.source}'s worker "${candidate.value}" is unknown — use opencode or claude-code` };
      }
      continue; // a stale repo/config default degrades to the next level
    }
    return {
      ok: true,
      provider: parsed.provider,
      model: parsed.model,
      source: candidate.source,
      promptRef: promptRefOf(input.handover),
    };
  }
  return { ok: true, provider: 'opencode', model: null, source: 'default', promptRef: promptRefOf(input.handover) };
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
}

/**
 * Composes the run's instruction: who and where the worker is, what the
 * ticket says (description + plan), the fleet's rules (stay on the
 * branch, leave the worktree the only place), and the machine gate it
 * must keep green. Deterministic text — no model involved.
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
  const description = input.description.trim();
  if (description !== '') {
    parts.push(`What and why:\n${description}`);
  }
  const plan = input.plan?.trim();
  if (plan !== null && plan !== undefined && plan !== '') {
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
  return parts.join('\n\n');
}
