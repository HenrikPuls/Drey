/**
 * The ticket as a document (E13-6, roadmap "Mission Control on the
 * desktop, inside Drey"): the pure half. What the header strip, the proof
 * widget, the cost table and the action bar draw is computed here from the
 * ticket's text and the board — no DOM, no CodeMirror, no IPC.
 *
 * Nothing is parsed twice: the sections come from the engine's own readers
 * (`parseVerificationSection`, `parseVerlaufEntries`), the chain from its
 * `mergeChain`, the estimate and its basis from its `RunEstimate`. This
 * file only turns them into the words the desktop shows (the same words
 * the phone's ticket screen uses: `$1.84`, `48k`, `9 min`).
 */
import { maskFenceLines } from '../../../../shared/markdown/fences';
import { mergeChain } from '../../../../packages/tickets-engine/src/core/chain-delta';
import { minutesOf } from '../../../../packages/tickets-engine/src/core/estimate';
import { parseVerificationSection } from '../../../../packages/tickets-engine/src/core/verification';
import { parseVerlaufEntries, type VerlaufEntry } from '../../../../packages/tickets-engine/src/core/verlauf';
import type { RunEstimate } from '../../../../packages/tickets-engine/src/core/estimate';
import type { VerificationReport } from '../../../../packages/tickets-engine/src/contracts/verify';
import type { BoardSnapshot, PipelinePhase, TicketCard } from '../../shared/tickets';
import { ideaPhaseIds, isMachinePhase, needKindLabel, statusLineOf, type WorkRow } from '../work-groups';

export const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** `$1.84` for a usable positive cost; null otherwise (an unknown cost is never `$0.00`). */
export function usdLabel(cost: number | null | undefined): string | null {
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? `$${cost.toFixed(2)}` : null;
}

/** 48000 → `48k`, 3400000 → `3.4M`: the Log's token words. */
export function tokenWords(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

// --- text ranges ------------------------------------------------------------

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The body of the `## <name>` section: from the start of its first line
 * after the heading to the end of its last non-blank line. The section ends
 * at the next heading of level 1–2; headings inside a code fence don't
 * count. Null when the section is absent or empty. Offsets index `text`.
 */
export function sectionBodyRange(text: string, name: string): TextRange | null {
  let offset = 0;
  let inSection = false;
  let from: number | null = null;
  let to: number | null = null;
  const heading = new RegExp(`^##\\s+${name}\\s*$`);
  const rawLines = text.split('\n');
  const scan = maskFenceLines(rawLines);
  for (const [i, rawLine] of rawLines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const probe = scan[i]!.endsWith('\r') ? scan[i]!.slice(0, -1) : scan[i]!;
    const lineEnd = offset + line.length;
    if (/^#{1,2}\s/.test(probe)) {
      if (inSection) {
        break;
      }
      inSection = heading.test(probe);
    } else if (inSection && line.trim() !== '') {
      from ??= offset;
      to = lineEnd;
    }
    offset += rawLine.length + 1;
  }
  return from !== null && to !== null ? { from, to } : null;
}

// --- the proof widget -------------------------------------------------------

export interface ProofCheck {
  readonly label: string;
  readonly passed: boolean;
  /** The judge's or runner's remark; null = none. */
  readonly note: string | null;
  /** The video chapter's offset for this criterion (`0:12`); null = none. */
  readonly at: string | null;
}

export interface ProofShot {
  /** The file name in `tickets/attachments/`. */
  readonly file: string;
  readonly caption: string;
}

export interface ProofVideo {
  /** The file name in `tickets/videos/`; null when the size limit freed it. */
  readonly file: string | null;
  readonly removed: boolean;
  readonly chapters: readonly { readonly atMs: number; readonly at: string; readonly label: string }[];
}

export interface ProofView {
  /** `4/4 green.` — the one line over the checks. */
  readonly summary: string;
  readonly allPassed: boolean;
  /** `Tested on 2026-11-04 by Tessa — Electron 34.2.0 on win32.` */
  readonly stamp: string;
  readonly checks: readonly ProofCheck[];
  readonly shots: readonly ProofShot[];
  readonly video: ProofVideo | null;
  readonly findings: readonly string[];
}

/** `m:ss` from milliseconds — the same chapter words the section writes. */
export function offsetWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The report as the widget draws it. Null criteria and no video still give a view (the stamp alone). */
export function proofViewOf(report: VerificationReport): ProofView {
  const chapters = (report.videoChapters ?? []).map((chapter) => ({
    atMs: chapter.atMs,
    at: offsetWords(chapter.atMs),
    label: chapter.label,
  }));
  const checks: ProofCheck[] = report.criteria.map((criterion) => ({
    label: criterion.command,
    passed: criterion.passed,
    note: criterion.note,
    at: chapters.find((chapter) => chapter.label === criterion.command)?.at ?? null,
  }));
  const shots: ProofShot[] = report.criteria
    .filter((criterion) => criterion.screenshot !== null)
    .map((criterion, index) => ({
      file: criterion.screenshot!,
      caption: `shot ${index + 1} · ${criterion.command}`,
    }));
  const passed = checks.filter((check) => check.passed).length;
  const allPassed = checks.length > 0 && passed === checks.length;
  const summary =
    checks.length === 0
      ? 'No criteria were checked.'
      : allPassed
        ? `${passed}/${checks.length} green.`
        : `${passed}/${checks.length} green, ${checks.length - passed} failing.`;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(report.testedAt)?.[0] ?? report.testedAt;
  const who = report.tester.replace(/^verify@.*$/, 'the verify run');
  const stamp =
    report.testedAt === ''
      ? ''
      : `Tested on ${day} by ${who}${report.environment === '' ? '' : ` — ${report.environment}`}.`;
  const video: ProofVideo | null =
    report.video !== undefined && report.video !== null
      ? { file: report.video, removed: false, chapters }
      : report.videoRemoved === true
        ? { file: null, removed: true, chapters: [] }
        : null;
  return { summary, allPassed, stamp, checks, shots, video, findings: report.findings };
}

/** The ticket text's `## Verification` as a view; null when the ticket has none. */
export function proofOfText(text: string): ProofView | null {
  const report = parseVerificationSection(text);
  return report === null ? null : proofViewOf(report);
}

/** `drey-asset://<vault>/asset/<path>` — the URL the editor's own images use. */
export function assetUrl(vaultId: string | null, relative: string): string {
  const encoded = relative.split('/').map(encodeURIComponent).join('/');
  return vaultId !== null && vaultId !== '' ? `drey-asset://${vaultId}/asset/${encoded}` : `drey-asset://asset/${encoded}`;
}

// --- the cost table ---------------------------------------------------------

export interface CostRow {
  readonly step: string;
  /** `Ben · sonnet`; '' when the line carries neither. */
  readonly who: string;
  /** `48k`; '' when unknown. */
  readonly tokens: string;
  /** `9 min`; '' when unknown. */
  readonly time: string;
  /** `$0.30`, or `—` when the run recorded no cost. */
  readonly cost: string;
  /** `handed over` / `failed` / `stopped`; '' when unreadable. */
  readonly outcome: string;
}

export interface CostTable {
  readonly rows: readonly CostRow[];
  /** The sum of every known cost; null until some run cost something. */
  readonly total: string | null;
  readonly totalTokens: string | null;
  readonly totalTime: string | null;
}

/** One row per settled run of the ticket's `## Verlauf`, oldest first, and the totals under it. An unknown figure never counts as zero. */
export function costTableOf(entries: readonly VerlaufEntry[], phaseTitle: (id: string) => string): CostTable {
  let minutes: number | null = null;
  let cost: number | null = null;
  let tokens: number | null = null;
  const rows: CostRow[] = entries.map((entry) => {
    const mins = minutesOf(entry.dauer);
    if (mins !== null) {
      minutes = (minutes ?? 0) + mins;
    }
    if (typeof entry.cost === 'number' && Number.isFinite(entry.cost) && entry.cost > 0) {
      cost = (cost ?? 0) + entry.cost;
    }
    const count = tokenCountFromWords(entry.tokens);
    if (count !== null) {
      tokens = (tokens ?? 0) + count;
    }
    return {
      step: entry.phase === null ? '—' : phaseTitle(entry.phase),
      who: [entry.persona === null ? '' : titleCase(entry.persona), entry.model ?? ''].filter((p) => p !== '').join(' · '),
      tokens: entry.tokens,
      time: mins === null ? '' : `${mins} min`,
      cost: usdLabel(entry.cost) ?? '—',
      outcome: entry.ausgang === 'handed-over' ? 'handed over' : (entry.ausgang ?? ''),
    };
  });
  return {
    rows,
    total: usdLabel(cost),
    totalTokens: tokens === null ? null : tokenWords(tokens),
    totalTime: minutes === null ? null : `${minutes} min`,
  };
}

function tokenCountFromWords(words: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(words.trim());
  if (match === null) {
    return null;
  }
  return Math.round(Number(match[1]) * (match[2] === 'M' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1));
}

/** The ticket text's `## Verlauf` as a cost table; null when it holds no run. */
export function costTableOfText(text: string, phaseTitle: (id: string) => string): CostTable | null {
  const entries = parseVerlaufEntries(text);
  return entries.length === 0 ? null : costTableOf(entries, phaseTitle);
}

/** `About $0.30 · 9 min · 48k tokens — median of 6 earlier Build runs by Ben on sonnet.` */
export function estimateLine(estimate: RunEstimate, gateTitle: string): string {
  const figures = [
    `About ${usdLabel(estimate.cost) ?? `$${estimate.cost.toFixed(2)}`}`,
    ...(estimate.minutes === null ? [] : [`${estimate.minutes} min`]),
    ...(estimate.tokens === null ? [] : [`${tokenWords(estimate.tokens)} tokens`]),
  ].join(' · ');
  return `${figures} — median of ${estimate.runs} earlier ${gateTitle} runs by ${titleCase(estimate.persona)} on ${estimate.model}.`;
}

// --- the header strip -------------------------------------------------------

export interface PersonaName {
  readonly id: string;
  readonly title: string;
}

export interface ChainItem {
  readonly phase: string;
  readonly title: string;
  readonly state: 'past' | 'current' | 'future';
  /** Who does the step: a persona's name, `you` at a checkpoint, '' when nobody is pinned. */
  readonly who: string;
  /** The persona's id (for the estimate's key); null at a checkpoint or when nobody is pinned. */
  readonly personaId: string | null;
  readonly checkpoint: boolean;
  readonly inserted: boolean;
  readonly skipped: boolean;
  readonly notify: boolean;
}

/**
 * The ticket's chain for the strip: the pipeline from the first working
 * phase to the last before the terminal one, merged with the ticket's
 * `chain:` delta (`mergeChain`). A step names its persona by the delta, else
 * the ticket's pin, else the column's persona; a manual column is the
 * owner's (`you`).
 */
export function chainOf(input: {
  readonly pipeline: readonly PipelinePhase[];
  readonly currentPhaseId: string;
  readonly card: TicketCard;
  readonly personas: readonly PersonaName[];
}): ChainItem[] {
  const { pipeline, card } = input;
  const ideas = new Set(ideaPhaseIds(pipeline));
  const last = pipeline[pipeline.length - 1]?.id ?? null;
  const shown = pipeline.filter((phase) => !ideas.has(phase.id) && phase.id !== last);
  const nameOf = (id: string): string => input.personas.find((p) => p.id === id)?.title ?? titleCase(id);
  return mergeChain(shown.map((p) => ({ id: p.id, title: p.title })), input.currentPhaseId, card.meta.chain ?? []).map((step) => {
    const phase = pipeline.find((p) => p.id === step.phase);
    const checkpoint = phase !== undefined && !isMachinePhase(phase);
    const persona = step.persona ?? card.meta.persona ?? phase?.persona ?? null;
    return {
      phase: step.phase,
      title: step.title,
      state: step.state,
      who: checkpoint ? 'you' : persona === null ? '' : nameOf(persona),
      personaId: checkpoint ? null : persona,
      checkpoint,
      inserted: step.inserted,
      skipped: step.skipped,
      notify: step.notify,
    };
  });
}

export type StatusTone = 'needs' | 'running' | 'blocked' | 'idle';

export interface TicketStatus {
  /** The chip: why the owner is needed, `Running`, `Blocked`, or the phase's title. */
  readonly label: string;
  readonly tone: StatusTone;
  /** The muted line after it (`checks green`, `waits for your review`); '' when none. */
  readonly line: string;
}

/** The status chip of a ticket on the board. */
export function statusOf(row: WorkRow | null, board: BoardSnapshot, phaseTitle: string): TicketStatus {
  if (row === null) {
    return { label: phaseTitle, tone: 'idle', line: '' };
  }
  if (row.need !== null) {
    return { label: needKindLabel(row.need, board), tone: 'needs', line: statusLineOf(row, board) };
  }
  if (row.run !== null) {
    return { label: 'Running', tone: 'running', line: phaseTitle };
  }
  if (row.card.blocked.length > 0) {
    return { label: 'Blocked', tone: 'blocked', line: `by ${row.card.blocked.join(', ')}` };
  }
  return { label: phaseTitle, tone: 'idle', line: '' };
}

export interface CostSummary {
  /** `$1.84 in total` / `$1.20 so far`; null while nothing readable was spent. */
  readonly label: string | null;
  readonly total: string | null;
}

/** The strip's cost slot: `so far` while the ticket is still being worked, `in total` once it waits on the owner. */
export function costSummary(entries: readonly VerlaufEntry[], waiting: boolean): CostSummary {
  const table = costTableOf(entries, (id) => id);
  return { total: table.total, label: table.total === null ? null : `${table.total} ${waiting ? 'in total' : 'so far'}` };
}

/** The persona that does the current step, when the pipeline or the ticket names one. */
export function currentStep(chain: readonly ChainItem[]): ChainItem | null {
  return chain.find((item) => item.state === 'current') ?? null;
}

// --- the action bar ---------------------------------------------------------

export interface ActionBar {
  /** Send back and Accept make sense only while the ticket waits on the owner at a checkpoint. */
  readonly decide: boolean;
  /** The accept button's words: `Accept and move to Commit`, or `Accept` at the end. */
  readonly acceptLabel: string;
}

/**
 * The bar under the ticket. Accept names the column it moves the ticket to
 * (`Accept and move to Commit`); at the last configured column it is plain
 * `Accept` (the archive). Send back and Accept show only for a ticket at an
 * owner checkpoint.
 */
export function actionBarOf(row: WorkRow | null, board: BoardSnapshot): ActionBar {
  const decide = row !== null && row.need !== null && row.need.kind === 'checkpoint';
  const phaseId = row?.phase.id ?? null;
  const configured = board.columns.filter((column) => !column.unknown);
  const index = configured.findIndex((column) => column.phase.id === phaseId);
  const next = index >= 0 ? configured[index + 1] : undefined;
  return { decide, acceptLabel: next === undefined ? 'Accept' : `Accept and move to ${next.phase.title}` };
}
