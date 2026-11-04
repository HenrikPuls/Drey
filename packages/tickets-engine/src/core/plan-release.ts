/**
 * Releasing a plan's parts (E10-4, concept v2 §5.9): the pure half of
 * the "Plan to approve" card. A part is a line of the parent's
 * `### Parts` until the owner approves; then it becomes its own ticket
 * (`parent:`, the builder's `persona:`, its own `chain:` delta, and a
 * `blocked-by:` on the part before it, so the order of the plan is the
 * order of the work). From then on the part is **locked** in the list —
 * the ticket is the truth, the list only shows where it stands.
 *
 * A part is matched to its ticket by title among the tickets that name
 * the parent (`parent:`): the title is what the release wrote, and the
 * list refuses to rename a part, so the match is stable.
 */
import type { PriorityConfig, TicketPriority } from '../contracts/tickets';
import type { PartState, PlanReleaseScope } from '../contracts/plan-approval';
import { splitFrontmatter } from '../../../../shared/frontmatter';
import { newTicketFileText, patchHeaderFields, patchTicketFile } from './ticket-files';
import type { PlanPart } from './plan-parts';

/** One ticket that names the parent — what the matcher and the state read. */
export interface PartTicket {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  /** A run is live on the ticket. */
  readonly running: boolean;
}

const norm = (title: string): string => title.replace(/\s+/g, ' ').trim().toLowerCase();

/** The ticket each part became, by position; null = not released yet. Every ticket matches once. */
export function matchPartTickets(parts: readonly PlanPart[], tickets: readonly PartTicket[]): (PartTicket | null)[] {
  const free = [...tickets].sort((a, b) => a.id.localeCompare(b.id));
  return parts.map((part) => {
    const at = free.findIndex((t) => norm(t.title) === norm(part.title));
    return at < 0 ? null : free.splice(at, 1)[0]!;
  });
}

/**
 * Where a part's ticket stands. `queuePhases` are the phases a released
 * ticket waits in before a worker takes it (up to and including the
 * build queue); `terminal` is the pipeline's last phase.
 */
export function partStateOf(ticket: PartTicket | null, queuePhases: ReadonlySet<string>, terminal: string): PartState {
  if (ticket === null) {
    return 'new';
  }
  if (ticket.phase === terminal) {
    return 'done';
  }
  if (ticket.running) {
    return 'running';
  }
  return queuePhases.has(ticket.phase) ? 'queued' : 'active';
}

/** The positions that are tickets already — the set `movePlanPart` / `deletePlanPart` lock. */
export function lockedIndices(matches: readonly (PartTicket | null)[]): Set<number> {
  const locked = new Set<number>();
  matches.forEach((m, i) => {
    if (m !== null) {
      locked.add(i);
    }
  });
  return locked;
}

/**
 * The start rule line of a card: the first part that is still new
 * `Runs now`, a later one `After part <n>` (the part before it), a
 * released one names its ticket.
 */
export function startLineOf(index: number, matches: readonly (PartTicket | null)[]): string {
  const own = matches[index] ?? null;
  if (own !== null) {
    return `Released as ${own.id}`;
  }
  return index === 0 ? 'Runs now' : `After part ${index}`;
}

/** The part indices a release mints, in order: every new part, or only the first. */
export function indicesToMint(matches: readonly (PartTicket | null)[], scope: PlanReleaseScope): number[] {
  const open = matches.flatMap((m, i) => (m === null ? [i] : []));
  return scope === 'first' ? open.slice(0, 1) : open;
}

/**
 * The ticket id a minted part waits for: the ticket of the part before
 * it (released earlier or minted just now), none for the first part.
 * `ids` maps part index → ticket id for everything released or minted so far.
 */
export function blockerOf(index: number, ids: ReadonlyMap<number, string>): string | null {
  return index === 0 ? null : (ids.get(index - 1) ?? null);
}

export interface PartDescriptionInput {
  readonly parentId: string;
  readonly parentTitle: string;
  readonly part: PlanPart;
  readonly index: number;
  readonly total: number;
}

/** The description a part's ticket starts with: what it is, why, and where the whole plan lives. */
export function partDescription(input: PartDescriptionInput): string {
  const lines = [input.part.title.replace(/\s+/g, ' ').trim()];
  if (input.part.reason !== null && input.part.reason.trim() !== '') {
    lines.push('', input.part.reason.replace(/\s+/g, ' ').trim());
  }
  lines.push('', `Part ${input.index + 1} of ${input.total} of ${input.parentId} (${input.parentTitle.replace(/\s+/g, ' ').trim()}). The whole plan is in the Plan section of ${input.parentId}.`);
  return lines.join('\n');
}

export interface PartTicketInput {
  readonly id: string;
  readonly parentId: string;
  readonly parentTitle: string;
  readonly part: PlanPart;
  readonly index: number;
  readonly total: number;
  readonly repo: string | null;
  readonly repos: readonly string[];
  readonly priority: TicketPriority;
  readonly priorities: PriorityConfig;
  /** The pipeline's first phase (the capture target) the ticket is created in. */
  readonly firstPhase: string;
  /** The phase the ticket lands in — the build queue; the Log shows the move from the first phase. */
  readonly phase: string;
  readonly blockedBy: string | null;
  readonly now: Date;
  readonly actor: string;
}

/**
 * A part's ticket file: the canonical creation text, then the keys only
 * a part carries (`parent`, `persona`, `blocked-by`, `chain`) set through
 * the header patcher, so the file keeps every convention of a ticket
 * the owner typed.
 */
export function partTicketText(input: PartTicketInput): string {
  const base = newTicketFileText({
    id: input.id,
    title: input.part.title.replace(/\s+/g, ' ').trim(),
    repo: input.repo,
    ...(input.repos.length > 1 ? { repos: input.repos } : {}),
    priority: input.priority,
    rank: 5000,
    firstPhase: input.firstPhase,
    now: input.now,
    actor: input.actor,
    description: partDescription(input),
  });
  const { yamlText, body } = splitFrontmatter(base);
  let block = patchHeaderFields(`---\n${yamlText ?? ''}\n---`, {
    ...(input.blockedBy !== null ? { blockedBy: [input.blockedBy] } : {}),
    ...(input.part.chain.length > 0 ? { chain: input.part.chain } : {}),
  }, input.priorities);
  const extra = [`parent: ${input.parentId}`, ...(input.part.persona !== null ? [`persona: ${input.part.persona}`] : [])];
  block = block.replace(/\n---$/, `\n${extra.join('\n')}\n---`);
  const created = `${block}\n${body}`;
  return input.phase === input.firstPhase
    ? created
    : patchTicketFile(created, { to: input.phase, from: input.firstPhase, now: input.now, actor: input.actor });
}

/** The Log line the parent gets when parts were released. */
export function releaseLogText(ids: readonly string[]): string {
  return `plan released: ${ids.join(', ')}`;
}
