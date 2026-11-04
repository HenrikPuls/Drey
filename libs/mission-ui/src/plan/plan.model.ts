/**
 * The shared plan's view models and pure helpers (E10-3, concept v2 §5.8):
 * the Plan chapter of a shaped ticket, read out of the ticket file as
 * chapters (Goal, Architecture, Parts, Acceptance criteria, Open
 * questions), its parts as a list, and the write-back of an edited plan.
 * The app never imports engine code — `replacePlanSection` is the same
 * rule as the engine's `withPlanSection`: everything outside the chapter
 * stays as it is.
 */
import { InjectionToken, type Signal } from '@angular/core';
import { fencedLineFlags, maskFenceLines, maskFences } from '../../../../shared/markdown/fences';
import type { McPlanStatus } from '../api/dto';

/** What the pane edits: the ticket's file, its revision (the save's base). */
export interface McPlanDoc {
  readonly id: string;
  readonly text: string;
  readonly revision: string;
}

/** Paul's open split proposal — N counted from the plan's Parts. */
export interface McSplitProposal {
  readonly parts: number;
  readonly reason: string;
}

export type McPlanReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Exactly what the plan pane consumes of the app state. */
export interface McPlanState {
  /** The shaped ticket; null = nothing is being shaped. */
  ticket(): string | null;
  /** The ticket's file as the desk holds it; null while it loads. */
  doc(): McPlanDoc | null;
  /** The version, the owner's edits since and the marked lines. */
  status(): McPlanStatus | null;
  /** Paul's open split proposal; null = none (or already decided). */
  proposal(): McSplitProposal | null;
  /** The owner's tap on the proposal. */
  decide(choice: 'keep' | 'split'): Promise<McPlanReply>;
  /** Saves the whole ticket text (one commit on the desk). */
  save(ticketText: string): Promise<McPlanReply>;
  /** Re-reads the ticket (after Paul's turn, after a conflict). */
  reload(): Promise<void>;
  /**
   * The pane registers what the next message must wait for: an edit still
   * in the textarea is saved first, so the model reads the same text.
   */
  setFlush(flush: (() => Promise<boolean>) | null): void;
  /** True while a shape turn runs — the pane dims its own editing. */
  busy?: Signal<boolean>;
}

export const MC_PLAN_STATE = new InjectionToken<McPlanState>('mc-plan-state');

// --- reading the plan -----------------------------------------------------

/** The `## Plan` section of a ticket file (heading excluded), `\n` newlines, edges trimmed; '' without one. */
export function planSectionOf(ticketText: string): string {
  const text = ticketText.replace(/\r\n/g, '\n');
  const scan = maskFences(text);
  const heading = /^## Plan[ \t]*$/m.exec(scan);
  if (heading === null) {
    return '';
  }
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(scan.slice(heading.index + heading[0].length));
  return (next === null ? rest : rest.slice(0, next.index)).replace(/^\n+/, '').replace(/\s+$/, '');
}

/** One `### ` chapter of the plan; text before the first heading is a chapter without a title. */
export interface McPlanChapter {
  readonly title: string;
  readonly body: string;
}

export function planChaptersOf(plan: string): McPlanChapter[] {
  const chapters: McPlanChapter[] = [];
  let title = '';
  let lines: string[] = [];
  const flush = (): void => {
    const body = lines.join('\n').trim();
    if (title !== '' || body !== '') {
      chapters.push({ title, body });
    }
  };
  const planLines = plan.replace(/\r\n/g, '\n').split('\n');
  const scan = maskFenceLines(planLines);
  for (const [i, line] of planLines.entries()) {
    const heading = /^#{3}[ \t]+(.*?)[ \t]*$/.exec(scan[i]!);
    if (heading !== null) {
      flush();
      title = heading[1]!;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return chapters;
}

/** One part of the plan for the collapsed list. */
export interface McPlanPartView {
  readonly title: string;
  readonly persona: string | null;
  readonly reason: string | null;
}

/** The `### Parts` list: titles with the persona and reason lines under each; empty without the chapter. */
export function planPartsOf(plan: string): McPlanPartView[] {
  const chapter = planChaptersOf(plan).find((c) => c.title.toLowerCase() === 'parts');
  if (chapter === undefined) {
    return [];
  }
  const parts: { title: string; persona: string | null; reason: string | null }[] = [];
  for (const line of maskFences(chapter.body).split('\n')) {
    const part = /^- \[[ xX]\] (.+)$/.exec(line);
    if (part !== null) {
      parts.push({ title: part[1]!.trim(), persona: null, reason: null });
      continue;
    }
    const detail = /^\s{2,}(persona|reason):[ \t]*(.*)$/.exec(line);
    const current = parts[parts.length - 1];
    if (detail !== null && current !== undefined && detail[2]!.trim() !== '') {
      if (detail[1] === 'persona') {
        current.persona = detail[2]!.trim();
      } else {
        current.reason = detail[2]!.trim();
      }
    }
  }
  return parts;
}

/** How many open questions the plan lists (items under "Open questions"). */
export function openQuestionCountOf(plan: string): number {
  const chapter = planChaptersOf(plan).find((c) => c.title.toLowerCase() === 'open questions');
  return chapter === undefined ? 0 : chapter.body.split('\n').filter((line) => /^\s*(?:[-*+]|\d+\.)[ \t]+\S/.test(line)).length;
}

/** The thread row's subtitle on the phone: `3 parts · 1 open question`; null when the plan says nothing yet. */
export function planRowSubtitleOf(plan: string): string | null {
  const parts = planPartsOf(plan).length;
  const questions = openQuestionCountOf(plan);
  const bits: string[] = [];
  if (parts > 0) {
    bits.push(`${parts} ${parts === 1 ? 'part' : 'parts'}`);
  }
  if (questions > 0) {
    bits.push(`${questions} open ${questions === 1 ? 'question' : 'questions'}`);
  }
  return bits.length === 0 ? null : bits.join(' · ');
}

/** The split buttons' wording: "Split into 3 tickets"; "Keep as one ticket" is fixed. */
export function splitLabelOf(parts: number): string {
  return `Split into ${parts} tickets`;
}

/**
 * Which plan lines carry a mark (1-based numbers of the Plan section as
 * the desk numbered them) — `you` wins over `model` on one line.
 */
export function markedLinesOf(status: McPlanStatus | null): ReadonlyMap<number, 'you' | 'model'> {
  const marks = new Map<number, 'you' | 'model'>();
  for (const mark of status?.marks ?? []) {
    if (marks.get(mark.no) !== 'you') {
      marks.set(mark.no, mark.by);
    }
  }
  return marks;
}

// --- writing the plan -----------------------------------------------------

/**
 * The ticket text with its Plan chapter set to `body` — the same rule as
 * the engine's: a `## ` line inside the body is demoted so the chapter
 * can never swallow the next one; a ticket without a Plan gets one
 * before its Log (or at the end).
 */
export function replacePlanSection(ticketText: string, rawBody: string): string {
  const bodyLines = rawBody.replace(/\r\n/g, '\n').trim().split('\n');
  const fenced = fencedLineFlags(bodyLines);
  const body = bodyLines.map((line, i) => (!fenced[i] && /^## /.test(line) ? `#${line}` : line)).join('\n');
  const text = ticketText.replace(/\r\n/g, '\n');
  const scan = maskFences(text);
  const heading = /^## Plan[ \t]*$/m.exec(scan);
  if (heading !== null) {
    const start = heading.index + heading[0].length;
    const next = /^## /m.exec(scan.slice(start));
    const tail = text.slice(next === null ? text.length : start + next.index);
    return `${text.slice(0, start)}\n\n${body}\n${tail === '' ? '' : `\n${tail}`}`;
  }
  const log = /^## Log[ \t]*$/m.exec(scan);
  const block = `## Plan\n\n${body}\n`;
  return log === null ? `${text.replace(/\n*$/, '\n')}\n${block}` : `${text.slice(0, log.index)}${block}\n${text.slice(log.index)}`;
}
