/**
 * The plan delta (E10-2, concept v2 §5.8, owner decision D6-family): the
 * plan is a document the owner and the model both edit. Per shaped
 * ticket the engine keeps a *shadow copy* — the plan at the end of the
 * model's last turn. When the owner sends a message, only the change
 * shadow → current rides along (a short summary and a diff); the model's
 * own edits are never mirrored back to it. This module is the pure
 * half: the Plan section of a ticket file, a line diff, the delta, and
 * the line marks ("you" / "model") the screen draws.
 */

/** The text of the `## Plan` section (heading excluded), `\n` newlines, edges trimmed; '' without one. */
export function planSectionOf(ticketText: string): string {
  const text = ticketText.replace(/\r\n/g, '\n');
  const heading = /^## Plan[ \t]*$/m.exec(text);
  if (heading === null) {
    return '';
  }
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(rest);
  return (next === null ? rest : rest.slice(0, next.index)).replace(/^\n+/, '').replace(/\s+$/, '');
}

export interface DiffOp {
  readonly kind: 'same' | 'add' | 'del';
  readonly text: string;
  /** 1-based line number in the old text; null for an added line. */
  readonly oldNo: number | null;
  /** 1-based line number in the new text; null for a removed line. */
  readonly newNo: number | null;
}

/** Plans longer than this many lines on both sides diff as one replacement (the LCS table stays small). */
const MAX_DIFF_LINES = 1_500;

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** A line diff by longest common subsequence; old and new are `\n`-joined texts. */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  const ops: DiffOp[] = [];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    a.forEach((text, i) => ops.push({ kind: 'del', text, oldNo: i + 1, newNo: null }));
    b.forEach((text, i) => ops.push({ kind: 'add', text, oldNo: null, newNo: i + 1 }));
    return ops;
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      ops.push({ kind: 'add', text: b[j]!, oldNo: null, newNo: j + 1 });
      j++;
    } else {
      ops.push({ kind: 'del', text: a[i]!, oldNo: i + 1, newNo: null });
      i++;
    }
  }
  return ops;
}

export interface PlanDelta {
  /** Contiguous groups of changed lines. */
  readonly edits: number;
  readonly added: number;
  readonly removed: number;
  /** 1-based line numbers in the CURRENT plan that were added or rewritten. */
  readonly lines: readonly number[];
  /** `2 edits · +3 −1`. */
  readonly summary: string;
  /** The diff as the model reads it: `@@ line N` per group, `- old` / `+ new` lines. */
  readonly diff: string;
}

export function editsSummary(edits: number, added: number, removed: number): string {
  return `${edits} ${edits === 1 ? 'edit' : 'edits'} · +${added} −${removed}`;
}

/** The change from `shadow` to `current`; null when the texts are the same. */
export function planDelta(shadow: string, current: string): PlanDelta | null {
  const ops = diffLines(shadow, current);
  if (ops.every((op) => op.kind === 'same')) {
    return null;
  }
  let edits = 0;
  let added = 0;
  let removed = 0;
  const lines: number[] = [];
  const out: string[] = [];
  let inGroup = false;
  for (const [index, op] of ops.entries()) {
    if (op.kind === 'same') {
      inGroup = false;
      continue;
    }
    if (!inGroup) {
      edits++;
      inGroup = true;
      const at = ops.slice(index).find((o) => o.newNo !== null)?.newNo ?? linesOf(current).length + 1;
      out.push(`@@ line ${at}`);
    }
    if (op.kind === 'add') {
      added++;
      lines.push(op.newNo!);
      out.push(`+ ${op.text}`);
    } else {
      removed++;
      out.push(`- ${op.text}`);
    }
  }
  return { edits, added, removed, lines, summary: editsSummary(edits, added, removed), diff: out.join('\n') };
}

/** The current plan's lines the model changed between two texts (its own turn): 1-based, in `after`. */
export function changedLinesOf(before: string, after: string): number[] {
  return planDelta(before, after)?.lines.slice() ?? [];
}

/**
 * The model-facing block for the next turn: what the owner changed in
 * the plan since the model last saw it. Plain text the bridge puts
 * ahead of the owner's message.
 */
export function planDeltaForModel(delta: PlanDelta): string {
  return `The owner edited the plan since your last turn (${delta.summary}). Only their changes are shown; your own edits are not mirrored back.\n${delta.diff}`;
}
