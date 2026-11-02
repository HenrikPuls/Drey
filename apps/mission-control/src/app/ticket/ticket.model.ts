/**
 * The ticket screen's local view models and pure logic (E5c).
 *
 * `app/api` ships the ticket-detail slice in parallel (E5c); instead of
 * importing its types, this screen declares the minimal contract it
 * consumes (the `TicketVm` interface below) and the parent reconciles it
 * against the api layer — the same decoupling the Work tab ships
 * (`work/work.model.ts`). The wire shapes this mirrors:
 * `GET /api/tickets/<id>` (`{ok, card, text, revision}`),
 * `GET|POST …/diff|worktree-changes|save|accept|send-back`.
 *
 * `TicketVm` is the ONE contract both ticket screens read — the view
 * (`view.ts`, this item) and the raw editor (`edit.ts`) — so the parent
 * binds a single object for both. Following the landed api slice and the
 * editor, every member is a callable: data fields are zero-arg functions
 * the parent implements over its signals (so this screen's `computed`s
 * track them), the actions are plain methods closing over the desk
 * client.
 */
import { InjectionToken } from '@angular/core';

// --- action replies ----------------------------------------------------------

/** What Accept and Send-back hand back (the desk's MutationResult slice). */
export interface TicketActionReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly warning?: string;
}

/**
 * What the raw edit's save hands back. The discriminated union lets the
 * editor surface `reply.error` straight into its `string | null` error
 * signal: the false branch always carries the desk's sentence (the
 * conflict wording, the validator's refusal, …).
 */
export type TicketSaveReply =
  | { readonly ok: true; readonly revision?: string }
  | { readonly ok: false; readonly error: string; readonly conflict?: boolean };

// --- the gate bar --------------------------------------------------------------

/** One pipeline phase as the gate bar renders it. */
export interface GatePhase {
  readonly id: string;
  readonly title: string;
  /** Checkpoints (the owner's gates between the machine's columns) wear the diamond. */
  readonly checkpoint: boolean;
}

export type GateStepState = 'past' | 'current' | 'future';

/** One gate-bar step: the phase plus where it sits against the current one. */
export interface GateStep extends GatePhase {
  readonly state: GateStepState;
}

/**
 * The phases as a step strip: everything before the current phase is
 * `past`, the current one `current`, everything after — and everything,
 * when the ticket sits in a phase the pipeline does not know — `future`.
 */
export function gateStepsOf(phases: readonly GatePhase[], currentPhaseId: string): GateStep[] {
  const at = phases.findIndex((phase) => phase.id === currentPhaseId);
  return phases.map((phase, index) => ({
    ...phase,
    state: at < 0 ? 'future' : index < at ? 'past' : index === at ? 'current' : 'future',
  }));
}

/** The current phase's display title; a phase the pipeline does not know shows its own id. */
export function phaseTitleOf(phases: readonly GatePhase[], phaseId: string): string {
  return phases.find((phase) => phase.id === phaseId)?.title ?? phaseId;
}

// --- the proof card ------------------------------------------------------------

/** One acceptance criterion's proof line (`### Criteria`). */
export interface ProofCriterion {
  /** The backticked gate command; a human line without backticks keeps its whole text. */
  readonly command: string;
  readonly passed: boolean;
  /** The screenshot attachment's name (`tickets/attachments/<name>`); null = none captured. */
  readonly screenshot: string | null;
  readonly note: string | null;
}

/** The `## Verification` section as the proof card renders it. */
export interface ProofReport {
  /** The 'Tested on …' line as written ('' when the section carries none). */
  readonly testedOn: string;
  readonly criteria: readonly ProofCriterion[];
  readonly findings: readonly string[];
}

const TESTED_ON = /^Tested on .+$/m;
const CRITERION = /^- \[([ xX])\] `([^`]+)`(?:\s*→\s*!\[\]\(\.\.\/attachments\/([^)]+)\))?(?:\s+—\s+(.+))?$/;
const LOOSE_CRITERION = /^- \[([ xX])\] (?!`)(.+)$/;
const FINDINGS_HEAD = /^###\s+findings\s*$/im;
const FINDINGS_ITEM = /^- (.+)$/;

/**
 * The Verification section's text (heading excluded) as the proof card
 * reads it, tolerantly: the stamp line shows verbatim, criteria parse
 * canonically (backticked command, screenshot arrow, em-dash note) with
 * a checkbox line the strict shape missed still listed, findings collect
 * under their heading. Half-readable input degrades, never throws.
 */
export function proofOf(sectionText: string): ProofReport {
  const testedOn = TESTED_ON.exec(sectionText)?.[0]?.trim() ?? '';
  const criteria: ProofCriterion[] = [];
  const findings: string[] = [];
  let inFindings = false;
  for (const line of sectionText.split('\n')) {
    if (FINDINGS_HEAD.test(line)) {
      inFindings = true;
      continue;
    }
    if (inFindings) {
      const finding = FINDINGS_ITEM.exec(line.trim());
      if (finding !== null) {
        findings.push(finding[1]!);
      }
      continue;
    }
    const canonical = CRITERION.exec(line);
    if (canonical !== null) {
      criteria.push({
        command: canonical[2]!,
        passed: canonical[1]!.toLowerCase() === 'x',
        screenshot: canonical[3] ?? null,
        note: canonical[4] ?? null,
      });
      continue;
    }
    const loose = LOOSE_CRITERION.exec(line);
    if (loose !== null) {
      criteria.push({ command: loose[2]!.trim(), passed: loose[1]!.toLowerCase() === 'x', screenshot: null, note: null });
    }
  }
  return { testedOn, criteria, findings };
}

// --- the section splitter --------------------------------------------------------

/** The section titles the screen treats specially (lowercased, exact). */
const SPECIAL_TITLES = ['verification', 'report', 'changes', 'handover', 'log'] as const;

function isSpecialTitle(title: string): title is (typeof SPECIAL_TITLES)[number] {
  return (SPECIAL_TITLES as readonly string[]).includes(title);
}

/**
 * The ticket body, split for the screen (concept §5.3/§5.5): the generic
 * sections render as Markdown; Verification feeds the proof card; Report
 * feeds the scout report card (E8); Changes/Handover/Log get their
 * special treatment and never render raw.
 */
export interface TicketSections {
  /** The frontmatter-stripped text minus the special sections, for the generic render. */
  readonly body: string;
  /** The `## Verification` section's text (heading excluded); null when absent or empty. */
  readonly verification: string | null;
  /** The `## Report` section's text (heading excluded); null when absent or empty. */
  readonly report: string | null;
  /** The `## Changes` section's text (heading excluded); null when absent or empty. */
  readonly changes: string | null;
  /** The `## Handover` section's text (heading excluded); null when absent or empty. */
  readonly handover: string | null;
  /** The `## Log` section's text (heading excluded); null when absent or empty. */
  readonly log: string | null;
}

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const H2 = /^##[ \t]+(.*?)[ \t]*$/;

/**
 * Splits the file text at its `##` headings. The leading frontmatter
 * fence never reaches the render; headings below H2 (`### …`) stay inside
 * their section (the Verification and Report subheads ride along);
 * section titles match case-insensitively; everything before the first
 * H2 is body.
 */
export function splitTicketSections(text: string): TicketSections {
  const source = text.replace(/\r\n?/g, '\n').replace(FRONTMATTER, '');
  const bodyLines: string[] = [];
  const buckets: Record<(typeof SPECIAL_TITLES)[number], string[]> = {
    verification: [],
    report: [],
    changes: [],
    handover: [],
    log: [],
  };
  let target: 'body' | (typeof SPECIAL_TITLES)[number] = 'body';
  for (const line of source.split('\n')) {
    const heading = H2.exec(line);
    if (heading !== null) {
      const title = heading[1]!.trim().toLowerCase();
      target = isSpecialTitle(title) ? title : 'body';
      if (target === 'body') {
        bodyLines.push(line);
      }
      continue;
    }
    (target === 'body' ? bodyLines : buckets[target]).push(line);
  }
  const sectionOf = (lines: readonly string[]): string | null => {
    const section = lines.join('\n').trim();
    return section === '' ? null : section;
  };
  return {
    body: bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    verification: sectionOf(buckets.verification),
    report: sectionOf(buckets.report),
    changes: sectionOf(buckets.changes),
    handover: sectionOf(buckets.handover),
    log: sectionOf(buckets.log),
  };
}

// --- the scout report card (E8, concept §5.6) -------------------------------------

/** One decision option as the report card renders it. */
export interface ScoutDecision {
  /** The decision's short key (`D1`, `D2`, …); '' when the line carried none. */
  readonly key: string;
  /** The question in the scout's words — what the owner decides. */
  readonly question: string;
  /** The scout's recommendation; null when the line carries none. */
  readonly recommendation: string | null;
  /** The owner's check mark; open decisions stay unchecked. */
  readonly resolved: boolean;
}

/** The `## Report` section as the report card renders it. */
export interface ScoutReport {
  /** The 'Written on … by …' stamp's parts ('' when the section carries none). */
  readonly writtenAt: string;
  readonly by: string;
  /** The `### Summary` block; '' when absent. */
  readonly summary: string;
  readonly decisions: readonly ScoutDecision[];
}

const REPORT_STAMP = /^Written on (\S+) by (.+?)\.?$/m;
const REPORT_DECISION = /^- \[([ xX])\] (\S+?): (.*?)(?: — Recommendation: (.*))?$/;
const SUMMARY_HEAD = /^###\s+summary\s*$/im;
const DECISIONS_HEAD = /^###\s+decisions\s*$/im;

/**
 * The Report section's text (heading excluded) as the report card reads
 * it, tolerantly — the same asymmetric-tolerance rule as `proofOf`: the
 * stamp's parts degrade to '', a decision line the strict shape misses is
 * skipped, half-readable input degrades, never throws. The `### Summary`
 * block ends at the next H3; decisions collect under `### Decisions`.
 */
export function scoutReportOf(sectionText: string): ScoutReport {
  const stamp = REPORT_STAMP.exec(sectionText);
  const decisions: ScoutDecision[] = [];
  const decisionsAt = sectionText.search(DECISIONS_HEAD);
  if (decisionsAt >= 0) {
    for (const line of sectionText.slice(decisionsAt).split('\n')) {
      const decision = REPORT_DECISION.exec(line.trim());
      if (decision !== null) {
        decisions.push({
          key: decision[2]!,
          question: decision[3]!.trim(),
          recommendation: decision[4] !== undefined && decision[4].trim() !== '' ? decision[4].trim() : null,
          resolved: decision[1]!.toLowerCase() === 'x',
        });
      }
    }
  }
  return {
    writtenAt: stamp?.[1] ?? '',
    by: stamp?.[2]?.trim() ?? '',
    summary: summaryBlockOf(sectionText),
    decisions,
  };
}

/** The `### Summary` block's text without the heading; '' when absent. */
function summaryBlockOf(sectionText: string): string {
  const head = SUMMARY_HEAD.exec(sectionText);
  if (head === null) {
    return '';
  }
  const rest = sectionText.slice(head.index + head[0].length);
  const next = /^### /m.exec(rest);
  const block = next === null ? rest : rest.slice(0, next.index);
  return block.trim();
}

// --- the diff card ------------------------------------------------------------

/** One changed file as the diff card renders it (`GET …/diff` + the stat list). */
export interface TicketDiffFile {
  /** The git status letter (A/M/D/R…). */
  readonly status: string;
  readonly path: string;
  /** The unified patch ('' for a binary file). */
  readonly patch: string;
  /** Lines added/removed when the desk reported them; null = unknown/binary. */
  readonly added: number | null;
  readonly removed: number | null;
}

export interface TicketDiff {
  readonly files: readonly TicketDiffFile[];
  /** True when the desk cut content for size — the card says so honestly. */
  readonly truncated: boolean;
}

/** One patch line's kind, for the git look (added/removed/context/meta). */
export type PatchLineKind = 'add' | 'del' | 'meta' | 'context';

export function patchLineKind(line: string): PatchLineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
    return 'meta';
  }
  if (line.startsWith('+')) {
    return 'add';
  }
  if (line.startsWith('-')) {
    return 'del';
  }
  return 'context';
}

/** The patch viewer's font-size steps (px); A- / A+ walk this list, clamped at both ends. */
export const DIFF_FONT_SIZE_STEPS: readonly number[] = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

export const DEFAULT_DIFF_FONT_SIZE = 13;

/** The next size in `direction` from `current`; a size off the list starts at the default. */
export function diffFontSizeStep(current: number, direction: -1 | 1): number {
  const known = DIFF_FONT_SIZE_STEPS.indexOf(current);
  const at = known < 0 ? DIFF_FONT_SIZE_STEPS.indexOf(DEFAULT_DIFF_FONT_SIZE) : known;
  const next = Math.min(Math.max(at + direction, 0), DIFF_FONT_SIZE_STEPS.length - 1);
  return DIFF_FONT_SIZE_STEPS[next]!;
}

// --- the armed two-step ---------------------------------------------------------

/** The Accept button's two-step arm (E5c): the second tap inside the window executes. */
export interface AcceptArmState {
  readonly armed: boolean;
  /** The ms timestamp the arm started at (0 when disarmed). */
  readonly since: number;
}

export const ACCEPT_ARM_WINDOW_MS = 4000;

export const ACCEPT_DISARMED: AcceptArmState = { armed: false, since: 0 };

export interface AcceptArmEvent {
  readonly kind: 'tap' | 'tick';
  readonly now: number;
}

export interface AcceptArmResult {
  readonly state: AcceptArmState;
  /** True when this tap lands inside the window — the caller executes Accept. */
  readonly execute: boolean;
}

/**
 * The arm reducer. A 'tap' arms when disarmed (or the window has lapsed)
 * and reports `execute` when it lands inside the window; a 'tick'
 * disarms an expired arm — the UI's safety timer calls it so an abandoned
 * 'Tap again to accept' never outlives its 4 s.
 */
export function acceptArmReduce(state: AcceptArmState, event: AcceptArmEvent): AcceptArmResult {
  if (event.kind === 'tick') {
    return state.armed && event.now - state.since >= ACCEPT_ARM_WINDOW_MS
      ? { state: ACCEPT_DISARMED, execute: false }
      : { state, execute: false };
  }
  if (state.armed && event.now - state.since < ACCEPT_ARM_WINDOW_MS) {
    return { state: ACCEPT_DISARMED, execute: true };
  }
  return { state: { armed: true, since: event.now }, execute: false };
}

// --- the screens' shared view model ------------------------------------------------

/**
 * The open ticket's loaded document — what `doc()` hands out. The raw
 * edit saves `text` back whole (frontmatter included), so the render
 * side must strip the frontmatter fence itself (see `splitTicketSections`).
 */
export interface TicketDoc {
  readonly id: string;
  readonly title: string;
  /** The full Markdown, exactly as the desk stores it. */
  readonly text: string;
  /** The revision `text` was read at; the base the next save sends. */
  readonly revision: string;
  /** The current phase id; the gate bar accents it. */
  readonly phase: string;
  /** The pipeline's phases in order — the gate bar's steps. */
  readonly phases: readonly GatePhase[];
}

/**
 * The ticket screens' contract: the view (`mc-ticket`) and the raw
 * editor (`mc-ticket-edit`) read the one bound object. The parent binds
 * it over the api layer's ticket slice (`ticketOpen`/`ticketDetail`/
 * `diff`/`ticketError` plus save/accept/send-back/reload); the factory
 * default is the empty state (no doc, no edit mode, every action refuses
 * politely) so the shell works before wiring lands.
 */
export interface TicketVm {
  /**
   * The open ticket's document; null while nothing is open, the first
   * load runs, or the load failed (`loadError()` carries why) — the
   * view renders its empty state then.
   */
  doc(): TicketDoc | null;
  /** The raw-edit mode flag — `mc-ticket-edit` renders the editor when true. */
  editing(): boolean;
  /** The view's Edit toggle entered the raw-edit exception path. */
  enterEdit(): void;
  /** The editor's Cancel/Save left it (a save leaves after `flashSaved`). */
  exitEdit(): void;
  /** The dim confirmation the view shows after a successful save; null otherwise. */
  savedFlash(): string | null;
  /** The editor's save succeeded — show `savedFlash()` and return to view mode. */
  flashSaved(): void;
  /** Why the load failed; null when all is well. */
  loadError(): string | null;
  /** Re-fetches the open ticket (the editor's conflict Reload; the empty state's retry). */
  reload(): Promise<void>;

  /** `#rrggbb` for the phase chip; null = the default chip colour. */
  phaseColor(): string | null;
  /** The proof card's diff; null while the desk has not answered (the card stays hidden). */
  diff(): TicketDiff | null;
  /** Read-only paired devices watch but never act: Accept/Send-back/Edit hide entirely. */
  readOnly(): boolean;
  /** The URL an attachment `<img>` fetches (`GET /api/attachments/<name>`); null until it can serve it. */
  attachmentUrl(name: string): string | null;

  /** The back arrow: the shell closes the screen. */
  onClose(): void;
  /** The raw edit's save; one commit on the desk, the refusal inline. */
  save(text: string): Promise<TicketSaveReply>;
  accept(): Promise<TicketActionReply>;
  /** The note is mandatory — an empty one refuses on the desk and here. */
  sendBack(note: string): Promise<TicketActionReply>;
}

const EMPTY_TICKET: TicketVm = {
  doc: () => null,
  editing: () => false,
  enterEdit: () => undefined,
  exitEdit: () => undefined,
  savedFlash: () => null,
  flashSaved: () => undefined,
  loadError: () => null,
  reload: () => Promise.resolve(),
  phaseColor: () => null,
  diff: () => null,
  readOnly: () => true,
  attachmentUrl: () => null,
  onClose: () => undefined,
  save: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
  accept: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
  sendBack: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
};

export const MC_TICKET = new InjectionToken<TicketVm>('mc-ticket', {
  factory: () => EMPTY_TICKET,
});
