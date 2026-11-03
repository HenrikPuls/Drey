/**
 * The self-improvement loop's data shapes (E6, concept §4.8): the
 * persona's `friction.md` (one line per finding, written by the worker)
 * and `improvements.md` (the aggregation's proposals, strict writer /
 * tolerant reader, one file per persona next to persona.md). Nothing
 * here writes — the board service owns the files and the one-commit
 * discipline; this module is the format.
 *
 * friction.md line: `- 2026-11-01 · T-0007 · guessed the order.md shape`
 *
 * improvements.md sketch:
 *
 *     # Improvements — paul
 *
 *     - aggregate: '2026-11-02T10:00:00Z'
 *     - imp-1 open prompt.md — Order the context pack by name
 *       - proposed: '2026-11-02T10:00:00Z'
 *       - evidence:
 *         - 2026-11-01 · T-0007 · guessed the order.md shape
 *       - lesson: Keep the pack recipe explicit.
 *       - content:
 *           You build in the ticket's worktree …
 *     - imp-2 dismissed models.default — Try sonnet as default
 *       - proposed: '2026-11-02T10:00:00Z'
 *       - decided: '2026-11-02T11:00:00Z'
 *       - content:
 *           sonnet
 */

/** One friction finding as the worker wrote it. */
export interface FrictionLine {
  /** ISO date as written (`2026-11-01`). */
  readonly at: string;
  readonly ticket: string | null;
  readonly text: string;
}

const FRICTION = /^- (\d{4}-\d{2}-\d{2}) · (T-\d{4,})? ?·? ?(.*)$/;

/** Reads friction.md tolerantly; unparseable lines are skipped, never guessed. */
export function parseFriction(text: string): readonly FrictionLine[] {
  const lines: FrictionLine[] = [];
  for (const raw of text.split('\n')) {
    const match = FRICTION.exec(raw.trim());
    if (match !== null && match[3]!.trim() !== '') {
      lines.push({ at: match[1]!, ticket: match[2] ?? null, text: match[3]!.trim() });
    }
  }
  return lines;
}

export type ImprovementTarget = 'prompt.md' | 'models.default' | 'memory';
export type ImprovementState = 'open' | 'accepted' | 'dismissed';

export const IMPROVEMENTS_THRESHOLD = 3;
export const MAX_IMPROVEMENT_EVIDENCE = 10;
export const MAX_IMPROVEMENT_CONTENT = 8 * 1024;

/** One aggregation proposal — the 1:1's unit of work. */
export interface ImprovementProposal {
  /** `imp-<n>`, minted per persona file. */
  readonly id: string;
  readonly state: ImprovementState;
  readonly target: ImprovementTarget;
  readonly title: string;
  readonly evidence: readonly string[];
  /** The concrete replacement (prompt text, model id, or the lesson line). */
  readonly content: string;
  /** A fitting lesson for memory.md; null when the proposal carries none. */
  readonly lesson: string | null;
  /** ISO stamp of the proposal. */
  readonly at: string;
  /** ISO stamp of the decision; null while open. */
  readonly decidedAt: string | null;
}

export interface ImprovementsFile {
  /** ISO stamp of the last aggregation run; null when never. */
  readonly lastAggregation: string | null;
  readonly proposals: readonly ImprovementProposal[];
}

/** The caps keep the LLM's output phone-reviewable and the file small. */
export interface ImprovementDraft {
  readonly target: ImprovementTarget;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly content: string;
  readonly lesson: string | null;
}

/** Validates an aggregator output; null refuses instead of guessing. */
export function validateDraft(raw: unknown): ImprovementDraft | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const target = obj['target'];
  const title = typeof obj['title'] === 'string' ? obj['title'].trim() : '';
  const content = typeof obj['content'] === 'string' ? obj['content'] : '';
  if (target !== 'prompt.md' && target !== 'models.default' && target !== 'memory') {
    return null;
  }
  if (title === '' || content.trim() === '' || content.length > MAX_IMPROVEMENT_CONTENT) {
    return null;
  }
  const evidence = Array.isArray(obj['evidence'])
    ? (obj['evidence'] as unknown[]).filter((e): e is string => typeof e === 'string').slice(0, MAX_IMPROVEMENT_EVIDENCE)
    : [];
  const lesson = typeof obj['lesson'] === 'string' && obj['lesson'].trim() !== '' ? obj['lesson'].trim() : null;
  return { target, title, evidence, content, lesson };
}

/** The strict canonical serialization (one commit's worth of content). */
export function renderImprovements(personaId: string, file: ImprovementsFile): string {
  const lines: string[] = [`# Improvements — ${personaId}`, ''];
  if (file.lastAggregation !== null) {
    lines.push(`- aggregate: '${file.lastAggregation}'`, '');
  }
  for (const proposal of file.proposals) {
    lines.push(
      `- ${proposal.id} ${proposal.state} ${proposal.target} — ${proposal.title}`,
      `  - proposed: '${proposal.at}'`,
    );
    if (proposal.decidedAt !== null) {
      lines.push(`  - decided: '${proposal.decidedAt}'`);
    }
    if (proposal.evidence.length > 0) {
      lines.push('  - evidence:');
      for (const item of proposal.evidence) {
        lines.push(`    - ${item}`);
      }
    }
    if (proposal.lesson !== null) {
      lines.push(`  - lesson: ${proposal.lesson}`);
    }
    lines.push('  - content:');
    for (const contentLine of proposal.content.replace(/\n+$/, '').split('\n')) {
      lines.push(`      ${contentLine}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '\n')}\n`;
}

/** The tolerant reader; an absent or broken file reads as empty. */
export function parseImprovements(text: string): ImprovementsFile {
  const lastAggregation = /^- aggregate: '([^']+)'/m.exec(text)?.[1] ?? null;
  const proposals: ImprovementProposal[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^- (imp-\d+) (open|accepted|dismissed) (prompt\.md|models\.default|memory) — (.+)$/.exec(lines[i]!.trim());
    if (head === null) {
      continue;
    }
    const [, id, state, target, title] = head;
    let at = '';
    let decidedAt: string | null = null;
    let lesson: string | null = null;
    let content: string | null = null;
    const evidence: string[] = [];
    for (i = i + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trimStart().startsWith('- imp-')) {
        i--;
        break;
      }
      const stamp = /^- proposed: '([^']+)'$/.exec(line.trim());
      if (stamp !== null) {
        at = stamp[1]!;
        continue;
      }
      const decided = /^- decided: '([^']+)'$/.exec(line.trim());
      if (decided !== null) {
        decidedAt = decided[1]!;
        continue;
      }
      const lessonMatch = /^- lesson: (.+)$/.exec(line.trim());
      if (lessonMatch !== null) {
        lesson = lessonMatch[1]!;
        continue;
      }
      const ev = /^- (.+)$/.exec(line.trim());
      if (ev !== null && line.startsWith('    - ')) {
        evidence.push(ev[1]!);
        continue;
      }
      if (line.trim() === '- content:') {
        const block: string[] = [];
        for (i = i + 1; i < lines.length; i++) {
          const inner = lines[i]!;
          if (inner.startsWith('      ')) {
            block.push(inner.slice(6));
          } else {
            i--;
            break;
          }
        }
        content = block.join('\n');
      }
    }
    if (content !== null && content.trim() !== '') {
      proposals.push({
        id: id!,
        state: state as ImprovementState,
        target: target as ImprovementTarget,
        title: title!.trim(),
        evidence,
        content,
        lesson,
        at,
        decidedAt,
      });
    }
  }
  return { lastAggregation, proposals };
}

/** The next free id: max existing + 1 (ids are never reused). */
export function nextImprovementId(text: string): string {
  let max = 0;
  for (const match of text.matchAll(/imp-(\d+) /g)) {
    max = Math.max(max, Number(match[1]));
  }
  return `imp-${max + 1}`;
}
