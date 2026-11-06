/**
 * The fleet's worker assignment (M84; the owner's ruling): for different
 * tasks, different workers — resolved ticket-first, then the pipeline
 * phase's handover pin, then the work repo's default, then the plugin's
 * configured default, then the fleet's first provider.
 *
 * Worker values name a provider and optionally pin a model:
 * `opencode`, `claude-code`, `kimi`, `claude-code/sonnet`. An unreadable value
 * is a refusal at run start — never a guess (ADR-0076).
 */
import { isWorkerProvider, BLOCKED_MARKER, QUESTION_MARKER, type FleetCaps, type InteractiveMode, type WorkerProviderId } from './protocol';
import { parseHandover } from '../contracts/tickets';
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
        return { ok: false, error: `the ${candidate.source}'s worker "${candidate.value}" is unknown — use opencode, claude-code or kimi` };
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
  /**
   * The earlier step's `## Handover` section of the ticket (State,
   * Decisions, Open, Files, Verified) — what a next step or a resumed
   * run reads first instead of the Log tail. Empty/absent on a ticket
   * no step has handed over yet.
   */
  readonly handover?: string;
  /** The worktree's raw diff stat vs the base (`worktreeDiffStat`); capped here (head). */
  readonly diffStat: string | null;
  /** The previous run's raw gate failure; capped here (tail). */
  readonly gateFailure: string | null;
  /** The output caps; the caller resolves them from `fleet.cap.*`. */
  readonly caps: FleetCaps;
  /** The repo's `link:` folders the runner links into the worktree (req-56). */
  readonly links?: readonly string[];
  /**
   * The ticket's further repos (req-72), primary excluded: one worktree
   * each on the same branch, prepared before the run. Named in the brief
   * so the worker never hunts for the checkouts.
   */
  readonly extraRepos?: readonly {
    readonly name: string;
    readonly worktreePath: string;
    /** The base the worktree branches from (repos.md `branch:`); null = HEAD. */
    readonly base: string | null;
  }[];
  /**
   * An interactive dialog (req-65): the brief's completion discipline is
   * replaced by the dialog discipline — no gate, no move, the owner moves
   * the ticket.
   */
  readonly interactive?: InteractiveMode;
  /**
   * The resolved persona's curated memory, already sliced by
   * `context-pack`'s `personaMemorySection` (E3, ADR-0088): carried as the
   * first of the instruction's variable parts — the stable prefix
   * (instructions, prompt, plan) must not move with the persona's lessons.
   * Null/absent = no section, byte-identical persona-less briefs.
   */
  readonly memorySection?: string | null;
  /**
   * The resolved persona's coaching, already sliced by `context-pack`'s
   * `personaCoachingSection` (U4, concept §4.5): rides directly after the
   * memory in the variable parts — the owner's corrections reach the next
   * run. Null/absent = no section.
   */
  readonly coachingSection?: string | null;
}

/** One capped section of the instruction — the caller logs each application. */
export interface Truncation {
  readonly section: 'diffStat' | 'gateFailure';
  readonly originalSize: number;
}

export interface ComposedInstruction {
  readonly text: string;
  readonly truncations: readonly Truncation[];
  /**
   * What a resumed session that already holds this brief is prompted
   * with (req-80): who/where, the diff stat, the gate failure, the gate
   * and the discipline — never the instructions, template or plan again.
   */
  readonly continuation: string;
  /** The stable parts serialized — the caller hashes them into `RunRequest.briefDigest` (this module also runs in the renderer). */
  readonly stable: string;
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
  'parks the step (the failure is logged and the ticket waits). When you CANNOT complete the step — what blocks ' +
  'it is the owner\u2019s to decide, or completing it would break a rule of this brief — end your final message ' +
  `with \`${BLOCKED_MARKER} <reason in one line>\`: the runner then runs no gate and moves nothing, and the ticket waits ` +
  'for the owner. Never declare done what you did not finish.';

/** The most of an earlier handover the brief carries. */
const HANDOVER_CAP = 2_000;

/**
 * What a step leaves for the next one and for its own resume: a short
 * structured section instead of long Log lines that every later reader
 * pays for again.
 */
const HANDOVER_DISCIPLINE =
  "Handover: before you end, replace the ticket file's `## Handover` section (add it before `## Log` if it is " +
  'missing; never a second one) with: State (`done` or `blocked`, one line), Decisions (up to three bullets), Open ' +
  '(what the next step must check first), Files (the main ones), Verified (the commands you ran and their result). ' +
  'Under 15 lines. Log lines stay one short line (under 200 characters) — detail belongs in the handover.';

/**
 * The interactive dialog's discipline (req-65): no gate, no move — the
 * conversation is the deliverable, the owner moves the ticket.
 */
const INTERACTIVE_DISCIPLINE =
  'Dialog discipline: you are in an interactive dialog with the owner — this is not a dispatched run. Your finished ' +
  'turn does not end anything: the runner runs no gate and moves nothing. Keep working in turns; end a turn with a ' +
  'question when the owner must decide something, and end it with a short statement of what you did and what is ' +
  'open when the step is where you both want it. The owner moves the ticket on the board themselves when the ' +
  'dialog is over — never claim a move happened.';

/**
 * How a worker asks the owner (req-64, the fixed shape since req-75 W2):
 * a turn whose last message opens with the marker does not end the run —
 * the run waits, the owner is notified, and the answer arrives in this
 * same session. The shape lets every surface that answers show the
 * question's context and its options with one tap (`question-shape.ts`).
 */
const ASKING =
  `Asking the owner: if you cannot go on without a decision only the owner can make, end your turn with a message ` +
  `that starts with \`${QUESTION_MARKER}\` and follows this shape, one item per line: the question; "Ticket:" what ` +
  `the ticket is about in one line; "Where:" where you stand; "Why:" why you ask; "Options:" two to four numbered ` +
  `options, each "<n>. <option> — <its consequence>"; "Recommendation: <n> — <why>". The run then waits, the owner ` +
  `is notified, and their answer arrives here in this session (a picked option arrives as "<n>. <option>"); continue ` +
  `the step from it. Ask only what blocks the step — what the plan, the ticket or the repo already answers, decide ` +
  `yourself; open points that can wait go into the ticket's Log.\n\n` +
  `Example:\n` +
  `${QUESTION_MARKER} Should dragging a heading also move the text below it?\n` +
  `Ticket: Outline — drag headings to reorder the note.\n` +
  `Where: step 2 of 4, the drop handler; step 1 is green.\n` +
  `Why: the plan says "reorder headings" but not whether the section body moves.\n` +
  `Options:\n` +
  `1. Move the whole section — one undo step, what other editors do\n` +
  `2. Only the heading line — the text stays, structure usually breaks\n` +
  `Recommendation: 1 — it keeps the note's structure intact.`;

/**
 * Composes the run's instruction as a context pack (T-0048), in this
 * order — stable first, so the prefix up to the `## Plan` heading is
 * byte-identical for any two runs of the same repo and phase:
 *
 * 1. the repo's agent instructions, verbatim;
 * 2. the phase instruction template (a resolved persona's prompt rides
 *    here — it IS the template for its runs);
 * 3. `## Plan` verbatim;
 * 4. the variable parts: who/where, the description, the persona's
 *    `## Memory` slice (E3), the earlier step's handover, the diff stat
 *    (head-capped), the previous run's gate failure on a retry
 *    (tail-capped), the gate commands, the completion discipline and
 *    how to ask the owner.
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
  if (input.extraRepos !== undefined && input.extraRepos.length > 0) {
    const lines = input.extraRepos.map(
      (r) => `- ${r.name}: ${r.worktreePath}${r.base !== null ? ` (base ${r.base})` : ''}`,
    );
    parts.push(
      `Further repositories this ticket names, each prepared as its own worktree on the same branch (${input.branch}) — ` +
        `work and commit there too when the step touches them:\n${lines.join('\n')}`,
    );
  }
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
  // The parts that change between runs of one step — the tail of the full
  // brief and the whole of a resume's continuation (req-80).
  const changing: string[] = [];
  const memorySection = input.memorySection != null && input.memorySection.trim() !== '' ? input.memorySection : null;
  if (memorySection !== null) {
    changing.push(memorySection);
  }
  const coachingSection = input.coachingSection != null && input.coachingSection.trim() !== '' ? input.coachingSection : null;
  if (coachingSection !== null) {
    changing.push(coachingSection);
  }
  const handover = input.handover?.trim();
  if (handover != null && handover !== '') {
    changing.push(
      `The earlier step's handover (written by the worker before you — trust it, check only what it marks Open):\n\n${handover.slice(0, HANDOVER_CAP)}`,
    );
  }
  const diffStat = input.diffStat?.trim();
  if (diffStat != null && diffStat !== '') {
    const capped = capHead(input.diffStat!, { lines: input.caps.diffStatLines, bytes: input.caps.diffStatBytes });
    if (capped.truncated) {
      truncations.push({ section: 'diffStat', originalSize: capped.originalSize });
    }
    changing.push(
      `The branch so far (committed since it left the base, then uncommitted):\n\n${capped.text}`,
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
    changing.push(
      `The previous run failed the machine gate — fix this first. The branch already holds the earlier work, ` +
        `so continue from the existing diff instead of starting over. The failure's tail:\n\n${capped.text}`,
    );
  }
  const gate =
    input.acceptance.length > 0
      ? 'The machine gate runs exactly these after you finish — keep them green, and commit your work on the branch before you end:\n' +
        input.acceptance.map((command) => `- \`${command}\``).join('\n')
      : null;
  const discipline = input.interactive !== undefined ? INTERACTIVE_DISCIPLINE : COMPLETION_DISCIPLINE;
  parts.push(...changing);
  if (gate !== null) {
    parts.push(gate);
  }
  parts.push(discipline);
  if (input.interactive === undefined) {
    parts.push(HANDOVER_DISCIPLINE);
  }
  parts.push(ASKING);

  const continuation = [
    `You are resuming ticket ${input.ticketId} — ${input.title}, the "${input.phase}" step, in this same session. ` +
      `Your full brief for this step is earlier in this conversation and still holds — do not re-read what it ` +
      `already told you. Work checkout: ${input.worktreePath} (branch ${input.branch}). Continue where you stopped — ` +
      `do not start the step over; what is already committed or written down stands.`,
    ...changing,
    ...(gate !== null ? [gate] : []),
    discipline,
    ...(input.interactive === undefined ? [HANDOVER_DISCIPLINE] : []),
  ].join('\n\n');
  const stable = JSON.stringify([
    repoInstructions ?? '',
    prompt ?? '',
    plan ?? '',
    description,
    input.acceptance,
    input.interactive ?? null,
    input.worktreePath,
    input.branch,
  ]);
  return { text: parts.join('\n\n'), truncations, continuation, stable };
}

// ---------------------------------------------------------------------------
// The scout run's brief (E8, concept §5.6): exploration only — no worktree,
// no branch, no gate, no move. Where the ship brief names a writable
// checkout and a machine gate, the scout brief names a READ ground, the
// ticket file as the one writable place, and the exact `## Report` shape
// the engine reads back for the "Needs you" report card.

/**
 * The scout discipline: the deliverable is the `## Report` chapter in the
 * ticket file plus the decision list the owner decides over; the run's end
 * declares the exploration done, nothing gates and nothing moves.
 */
const SCOUT_DISCIPLINE =
  'Scout discipline: you are on an exploration, not a build — change nothing in any repo: no edits, no commits, no branch, no installs. ' +
  'Read freely: the read ground, its git history, the tickets vault. Your ONE writable place is your own ticket file — the report ' +
  'chapter goes there, nowhere else. End your turn when the exploration is done: the runner runs no gate and moves nothing; the ' +
  'report card waits for the owner in "Needs you", and they promote the ticket to a build ticket from there. When you cannot ' +
  `complete the exploration — a decision only the owner can make, a place you may not read — end your final message with \`${BLOCKED_MARKER} ` +
  '<reason in one line>`: nothing moves, the ticket waits for the owner. Never report what you did not verify.';

/**
 * The report chapter's exact shape — the strict writer's grammar of
 * `core/scout.ts`, spelled out for the worker. The reader forgives, so
 * the writer must not improvise: headings verbatim, decisions numbered
 * D1, D2, …, every line left `- [ ]` for the owner to check.
 */
function scoutReportShape(by: string): string {
  return (
    'The report chapter — replace the ticket file\'s whole `## Report` section with exactly this shape (headings verbatim):\n\n' +
    `## Report\n\nWritten on <UTC stamp, YYYY-MM-DDTHH:mm:ssZ> by ${by}.\n\n### Summary\n\n` +
    '<what you found: the facts, the options, the trade-offs — what the owner must know to decide>\n\n### Decisions\n\n' +
    '- [ ] D1: <the question the owner must decide> — Recommendation: <your recommendation>\n' +
    '- [ ] D2: <the next decision, in the order the owner should decide them> — Recommendation: <…>\n\n' +
    'Every decision line stays `- [ ]` unchecked — the owner checks them when deciding; a line without a recommendation ' +
    'omits the ` — Recommendation: …` tail. No decisions open is a legitimate report: omit the whole `### Decisions` ' +
    'heading when nothing stays open.'
  );
}

export interface ScoutInstructionInput {
  readonly ticketId: string;
  readonly title: string;
  /**
   * The read ground's absolute path — the named repo's checkout, or the
   * tickets vault itself when the ticket names no repo. Read-only; the
   * brief forbids writing there.
   */
  readonly readGround: string;
  /** The read ground's repo name (`drey`); null = the tickets vault. */
  readonly repoName: string | null;
  /** Absolute path of the ticket file — the one writable place. */
  readonly ticketFile: string;
  readonly phase: string;
  readonly description: string;
  readonly plan: string | null;
  /** A resolved persona's prompt; null = the built-in scout brief only. */
  readonly prompt: string | null;
  /** The read ground's agent instructions, verbatim like the ship brief. */
  readonly repoInstructions: string | null;
  /** The ticket's further repos: read-only grounds, never write there. */
  readonly extraRepos?: readonly { readonly name: string; readonly path: string }[];
  /** The resolved persona's `## Memory` slice (E3); absent = no section. */
  readonly memorySection?: string | null;
  /** The resolved persona's `## Coaching` slice (U4); absent = no section. */
  readonly coachingSection?: string | null;
  /** The persona id the Written-on line signs with; null/'' = `scout`. */
  readonly personaId?: string | null;
  /**
   * An interactive dialog on a scout ticket: the dialog discipline
   * replaces the scout discipline, everything else stands.
   */
  readonly interactive?: InteractiveMode;
}

/**
 * Composes the scout run's brief in the context-pack order — stable
 * first (repo instructions, the persona prompt, `## Plan`), then the
 * variable parts (who/where, the read ground, the ticket file, the
 * description, the persona's memory, the report's shape, the
 * discipline, how to ask). No gate commands, no diff stat, no gate
 * failure: a scout run has no branch and no gate to fail.
 */
export function composeScoutInstruction(input: ScoutInstructionInput): ComposedInstruction {
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

  parts.push(
    `You are scouting ticket ${input.ticketId} — ${input.title}. Exploration only: you change nothing in any repo — ` +
      'no edits, no commits, no branch.',
  );
  parts.push(
    `Read ground: ${input.readGround}` +
      (input.repoName !== null ? ` (the "${input.repoName}" checkout)` : ' (the tickets vault)') +
      ' — read-only; never write there. Its git history and every data file in it are fair game.',
  );
  if (input.extraRepos !== undefined && input.extraRepos.length > 0) {
    const lines = input.extraRepos.map((r) => `- ${r.name}: ${r.path} (read-only)`);
    parts.push(`Further repositories this ticket names — read-only grounds, never write there:\n${lines.join('\n')}`);
  }
  parts.push(`The ticket sits in the "${input.phase}" phase of the owner's board — it stays there; this run moves nothing.`);
  parts.push(
    `The ticket file: ${input.ticketFile} — the ONE file you may edit. The report chapter goes into it; ` +
      'nothing else in the vault or any repo is yours to write.',
  );
  const description = input.description.trim();
  if (description !== '') {
    parts.push(`What and why:\n${description}`);
  }
  const changing: string[] = [];
  const memorySection = input.memorySection != null && input.memorySection.trim() !== '' ? input.memorySection : null;
  if (memorySection !== null) {
    changing.push(memorySection);
  }
  const coachingSection = input.coachingSection != null && input.coachingSection.trim() !== '' ? input.coachingSection : null;
  if (coachingSection !== null) {
    changing.push(coachingSection);
  }
  const by = input.personaId !== undefined && input.personaId !== null && input.personaId.trim() !== '' ? input.personaId.trim() : 'scout';
  const discipline = input.interactive !== undefined ? INTERACTIVE_DISCIPLINE : SCOUT_DISCIPLINE;
  parts.push(...changing);
  parts.push(scoutReportShape(by));
  parts.push(discipline);
  parts.push(ASKING);

  const continuation = [
    `You are resuming the exploration of ticket ${input.ticketId} — ${input.title}, the scout run, in this same session. ` +
      `Your full brief for this exploration is earlier in this conversation and still holds — do not re-read what it already ` +
      `told you. Read ground: ${input.readGround} (read-only). Your one writable place stays the ticket file: ${input.ticketFile}.`,
    ...changing,
    'The report\'s shape stands: `## Report` with the Written-on line, `### Summary`, `### Decisions` of ' +
      '`- [ ] Dn: <question> — Recommendation: <yours>` — unchecked, in the order the owner should decide them.',
    discipline,
  ].join('\n\n');
  const stable = JSON.stringify([
    repoInstructions ?? '',
    prompt ?? '',
    plan ?? '',
    description,
    'scout',
    input.readGround,
  ]);
  return { text: parts.join('\n\n'), truncations, continuation, stable };
}
