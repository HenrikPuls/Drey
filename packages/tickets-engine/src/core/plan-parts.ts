/**
 * The plan's parts (E10, concept v2 §5.9): an optional `### Parts`
 * chapter under `## Plan` that splits a plan into steps which become
 * their own tickets when the owner approves it. The order IS the plan's
 * order, so moving or deleting a part is a list edit. The canonical
 * shape (specs/ticket-schema.md, "Parts"):
 *
 *     ### Parts
 *
 *     - [ ] Split a file diff into hunks
 *       persona: ben
 *       reason: pure logic first, so the panel can build on it
 *       chain: insert security(ralf, notify) after review; skip qa
 *     - [ ] Hunk rows in the Source control panel
 *       persona: ben
 *
 * Reading is tolerant (the asymmetric-tolerance rule): a line that is no
 * part and no detail is skipped with a warning, a detail key that is not
 * known warns, a chain entry outside the grammar warns and drops — never
 * a guess. Writing is strict and canonical. One part means no chapter at
 * all ("Keep as one"): {@link withPlanParts} removes the chapter then.
 */
import type { ChainEntry } from '../contracts/chain';
import { parseChainEntry } from './chain-delta';

export interface PlanPart {
  /** The part's one-line title. */
  readonly title: string;
  /** `[x]` — the part's ticket has been accepted. */
  readonly done: boolean;
  /** The builder persona pin (`persona: ben`); null = the ladder decides. */
  readonly persona: string | null;
  /** Why the part exists; null = none given. */
  readonly reason: string | null;
  /** The part's own chain delta, canonical strings; the parent's never leaks in. */
  readonly chain: readonly string[];
}

export interface ParsedPlanParts {
  readonly parts: readonly PlanPart[];
  /** Findings of the tolerant read, one line each. */
  readonly warnings: readonly string[];
}

export const PARTS_HEADING = '### Parts';

const PART = /^- \[([ xX])\] (.+)$/;
const DETAIL = /^\s{2,}([a-z]+):[ \t]*(.*)$/;
const PERSONA = /^[a-z][a-z0-9-]{0,63}$/;

type MutablePart = { -readonly [K in keyof PlanPart]: PlanPart[K] };

/** The `## Plan` section's [start, end) in the text (heading excluded); null without one. */
function planBounds(text: string): { start: number; end: number } | null {
  const heading = /^## Plan[ \t]*$/m.exec(text);
  if (heading === null) {
    return null;
  }
  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(start));
  return { start, end: next === null ? text.length : start + next.index };
}

/** The `### Parts` chapter inside the Plan: [start, end) including its heading; null without one. */
function partsBounds(text: string): { start: number; end: number } | null {
  const plan = planBounds(text);
  if (plan === null) {
    return null;
  }
  const body = text.slice(plan.start, plan.end);
  const heading = /^### Parts[ \t]*$/m.exec(body);
  if (heading === null) {
    return null;
  }
  const after = body.slice(heading.index + heading[0].length);
  const next = /^#{1,3} /m.exec(after);
  const end = next === null ? body.length : heading.index + heading[0].length + next.index;
  return { start: plan.start + heading.index, end: plan.start + end };
}

/** Reads the parts of a whole ticket file; empty without the chapter. */
export function parsePlanParts(ticketText: string): ParsedPlanParts {
  const text = ticketText.replace(/\r\n/g, '\n');
  const bounds = partsBounds(text);
  if (bounds === null) {
    return { parts: [], warnings: [] };
  }
  const warnings: string[] = [];
  const parts: MutablePart[] = [];
  const lines = text.slice(bounds.start, bounds.end).split('\n').slice(1);
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const part = PART.exec(line);
    if (part !== null) {
      parts.push({ title: part[2]!.trim(), done: part[1]!.toLowerCase() === 'x', persona: null, reason: null, chain: [] });
      continue;
    }
    const detail = DETAIL.exec(line);
    const current = parts[parts.length - 1];
    if (detail === null || current === undefined) {
      warnings.push(`parts line "${line.trim()}" is not readable — expected "- [ ] <title>"`);
      continue;
    }
    const value = detail[2]!.trim();
    switch (detail[1]) {
      case 'persona':
        if (PERSONA.test(value)) {
          current.persona = value;
        } else {
          warnings.push(`part "${current.title}": persona "${value}" is not a persona id`);
        }
        break;
      case 'reason':
        current.reason = value === '' ? null : value;
        break;
      case 'chain': {
        const entries: string[] = [];
        for (const raw of value.split(';').map((e) => e.trim()).filter((e) => e !== '')) {
          if (parseChainEntry(raw) === null) {
            warnings.push(`part "${current.title}": chain entry "${raw}" is not readable`);
          } else {
            entries.push(raw);
          }
        }
        current.chain = entries;
        break;
      }
      default:
        warnings.push(`part "${current.title}": unknown detail "${detail[1]}"`);
    }
  }
  return { parts, warnings };
}

/** The chapter, heading included, ending in one newline. */
export function renderPlanParts(parts: readonly PlanPart[]): string {
  const lines = [PARTS_HEADING, ''];
  for (const part of parts) {
    lines.push(`- [${part.done ? 'x' : ' '}] ${part.title.replace(/\s+/g, ' ').trim()}`);
    if (part.persona !== null) {
      lines.push(`  persona: ${part.persona}`);
    }
    if (part.reason !== null && part.reason.trim() !== '') {
      lines.push(`  reason: ${part.reason.replace(/\s+/g, ' ').trim()}`);
    }
    if (part.chain.length > 0) {
      lines.push(`  chain: ${part.chain.join('; ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the parts into the Plan: the chapter is replaced, or added at
 * the end of the Plan section. Fewer than two parts removes the chapter
 * ("Keep as one"). Everything else survives; a file without a `## Plan`
 * is returned unchanged.
 */
export function withPlanParts(ticketText: string, parts: readonly PlanPart[]): string {
  const text = ticketText.replace(/\r\n/g, '\n');
  const plan = planBounds(text);
  if (plan === null) {
    return ticketText;
  }
  const block = parts.length < 2 ? '' : renderPlanParts(parts);
  const existing = partsBounds(text);
  if (existing !== null) {
    const before = text.slice(0, existing.start);
    const after = text.slice(existing.end).replace(/^\n+/, '');
    if (block === '') {
      return `${before.replace(/\n+$/, '\n')}${after === '' ? '' : `\n${after}`}`;
    }
    return `${before}${block}${after === '' ? '' : `\n${after}`}`;
  }
  if (block === '') {
    return ticketText;
  }
  const head = text.slice(0, plan.end).replace(/\n+$/, '\n');
  const tail = text.slice(plan.end).replace(/^\n+/, '');
  return `${head}\n${block}${tail === '' ? '' : `\n${tail}`}`;
}

export type PartsEdit = { readonly ok: true; readonly parts: readonly PlanPart[] } | { readonly ok: false; readonly error: string };

/**
 * Moves a part from one index to another. A running part is locked: it
 * cannot move, and no part may be placed ahead of one (the order of work
 * that already started is not rewritten). `running` names the indices
 * whose tickets run.
 */
export function movePlanPart(parts: readonly PlanPart[], from: number, to: number, running: ReadonlySet<number>): PartsEdit {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= parts.length || to >= parts.length) {
    return { ok: false, error: 'no such part position' };
  }
  if (running.has(from)) {
    return { ok: false, error: `"${parts[from]!.title}" is running and cannot be moved` };
  }
  const lastRunning = Math.max(-1, ...running);
  if (to <= lastRunning) {
    return { ok: false, error: 'a part cannot move ahead of one that is running' };
  }
  if (from === to) {
    return { ok: true, parts };
  }
  const next = [...parts];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return { ok: true, parts: next };
}

/** Deletes a part; a running part cannot be deleted. */
export function deletePlanPart(parts: readonly PlanPart[], index: number, running: ReadonlySet<number>): PartsEdit {
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) {
    return { ok: false, error: 'no such part position' };
  }
  if (running.has(index)) {
    return { ok: false, error: `"${parts[index]!.title}" is running and cannot be deleted` };
  }
  return { ok: true, parts: parts.filter((_, i) => i !== index) };
}

/** The part's chain as parsed entries (for the flow row); unreadable entries were dropped on read. */
export function partChainEntries(part: PlanPart): ChainEntry[] {
  return part.chain.flatMap((raw) => parseChainEntry(raw) ?? []);
}
