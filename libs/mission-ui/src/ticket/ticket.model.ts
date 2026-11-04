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
import { maskFenceLines, maskFences } from '../../../../shared/markdown/fences';
import type { McEstimate, McPlanStatus, McTicketUsage, McVerlaufEntry } from '../api/dto';

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

/**
 * One gate-bar step: the phase plus where it sits against the current
 * one. The chain-delta flags (E9, concept §5.7) mark what the ticket's
 * `chain:` delta does to this gate: an inserted revisit, a skipped
 * bypass, the Bescheid rule standing on it, the pinned persona.
 */
export interface GateStep extends GatePhase {
  readonly state: GateStepState;
  /** A delta-inserted gate (rendered as an addition). */
  readonly inserted: boolean;
  /** A delta-skipped gate (rendered struck; the ticket bypasses it). */
  readonly skipped: boolean;
  /** The Bescheid rule stands on this gate — its completion lands in "Needs you". */
  readonly notify: boolean;
  /** The persona pinned to this gate; null = the ladder decides. */
  readonly persona: string | null;
  /**
   * The gate's run cost — the `## Verlauf` entries' sum for this phase
   * (matched by id, then title); null = the phase's runs cost nothing
   * readable — the pill renders no cost slot.
   */
  readonly cost: string | null;
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
    inserted: false,
    skipped: false,
    notify: false,
    persona: null,
    cost: null,
  }));
}

// --- the chain delta (E9, concept §5.7) -----------------------------------------

/**
 * One declarative `chain:` entry as this screen renders it — the local
 * mirror of the engine's ChainEntry (contracts/chain.ts). The app never
 * imports engine code; the grammar below is the same strict writer the
 * desk parses (`insert security(ralf, notify) after review`, `skip verify`,
 * `notify build`) and the merge mirrors core/chain-delta.ts, tolerant by
 * design: unknown phases render with their id as title, an unknown
 * anchor appends.
 */
export interface ChainEntryView {
  readonly kind: 'insert' | 'skip' | 'notify';
  /** The pipeline phase the entry concerns. */
  readonly phase: string;
  /** The anchor phase an insert hangs on; null on skip/notify. */
  readonly anchor: string | null;
  /** The insert's position against its anchor; null on skip/notify. */
  readonly position: 'after' | 'before' | null;
  /** The persona pinned to an inserted gate; null = the ladder decides. */
  readonly persona: string | null;
  /** The Bescheid rule on an inserted gate. */
  readonly notify: boolean;
}

const CHAIN_PHASE_ID = /^[a-z][a-z0-9-]*$/;
const CHAIN_SKIP = /^skip ([a-z][a-z0-9-]*)$/;
const CHAIN_NOTIFY = /^notify ([a-z][a-z0-9-]*)$/;
const CHAIN_INSERT = /^insert ([a-z][a-z0-9-]*)(?:\(([^)]*)\))? (after|before) ([a-z][a-z0-9-]*)$/;

/**
 * Parses one `chain:` entry; null when the text is not the grammar —
 * never a guess (the desk refuses the same text at execution, so the
 * screen only offers parses it can render).
 */
export function parseChainEntryView(text: string): ChainEntryView | null {
  const raw = text.trim();
  const skip = CHAIN_SKIP.exec(raw);
  if (skip !== null) {
    return { kind: 'skip', phase: skip[1]!, anchor: null, position: null, persona: null, notify: false };
  }
  const notify = CHAIN_NOTIFY.exec(raw);
  if (notify !== null) {
    return { kind: 'notify', phase: notify[1]!, anchor: null, position: null, persona: null, notify: false };
  }
  const insert = CHAIN_INSERT.exec(raw);
  if (insert !== null) {
    const opts = insert[2] === undefined ? [] : insert[2].split(',').map((o) => o.trim()).filter((o) => o !== '');
    let persona: string | null = null;
    let notifyFlag = false;
    for (const opt of opts) {
      if (opt === 'notify') {
        notifyFlag = true;
      } else if (CHAIN_PHASE_ID.test(opt) && persona === null) {
        persona = opt;
      } else {
        return null; // an unreadable option poisons the whole entry
      }
    }
    return {
      kind: 'insert',
      phase: insert[1]!,
      anchor: insert[4]!,
      position: insert[3] === 'before' ? 'before' : 'after',
      persona,
      notify: notifyFlag,
    };
  }
  return null;
}

/** Renders one entry in the canonical grammar — the round trip with `parseChainEntryView`. */
export function renderChainEntryView(entry: ChainEntryView): string {
  switch (entry.kind) {
    case 'skip':
      return `skip ${entry.phase}`;
    case 'notify':
      return `notify ${entry.phase}`;
    case 'insert': {
      const opts: string[] = [];
      if (entry.persona !== null) {
        opts.push(entry.persona);
      }
      if (entry.notify) {
        opts.push('notify');
      }
      const paren = opts.length > 0 ? `(${opts.join(', ')})` : '';
      return `insert ${entry.phase}${paren} ${entry.position ?? 'after'} ${entry.anchor ?? ''}`.trim();
    }
  }
}

/** The canonical strings of a whole delta — what the sheet prefills into the chat command. */
export function renderChainEntryViews(entries: readonly ChainEntryView[]): string[] {
  return entries.map((entry) => renderChainEntryView(entry));
}

/**
 * The gate sheet's chat prefill (E9, concept §5.7): the one mutation
 * path's "word" — a sentence the owner reviews and sends, the mission
 * answers with the setChain proposal card. An empty delta is the
 * standard-flow return, worded like the card's own summary sentence.
 */
export function chainPrefillOf(id: string, entries: readonly string[]): string {
  return entries.length === 0 ? `Return ${id} to the standard flow` : `Set ${id} chain: ${entries.join('; ')}`;
}

/**
 * Merges the standard flow with a ticket's delta into the concrete chain
 * the gate bar renders (mirrors the engine's mergeChain, same tolerance):
 * `skip` strikes its gate, `notify` raises the Bescheid flag, `insert`
 * splices a revisit at its anchor — or appends when the anchor is not in
 * the pipeline. The state fold marks the current gate; a ticket outside
 * the merged chain renders everything `future`.
 */
export function chainStepsOf(
  phases: readonly GatePhase[],
  currentPhaseId: string,
  entries: readonly ChainEntryView[],
): GateStep[] {
  const steps: GateStep[] = phases.map((phase) => ({
    ...phase,
    state: 'future',
    inserted: false,
    skipped: false,
    notify: false,
    persona: null,
    cost: null,
  }));
  const indexOf = (phase: string): number => steps.findIndex((step) => step.id === phase);
  for (const entry of entries) {
    if (entry.kind === 'skip') {
      const at = indexOf(entry.phase);
      if (at >= 0) {
        steps[at] = { ...steps[at]!, skipped: true };
      }
      continue;
    }
    if (entry.kind === 'notify') {
      const at = indexOf(entry.phase);
      if (at >= 0) {
        steps[at] = { ...steps[at]!, notify: true };
      }
      continue;
    }
    const anchorAt = indexOf(entry.anchor ?? '');
    const known = phases.find((phase) => phase.id === entry.phase);
    const step: GateStep = {
      id: entry.phase,
      title: known?.title ?? entry.phase,
      checkpoint: known?.checkpoint ?? false,
      state: 'future',
      inserted: true,
      skipped: false,
      notify: entry.notify,
      persona: entry.persona,
      cost: null,
    };
    if (anchorAt >= 0) {
      steps.splice(entry.position === 'before' ? anchorAt : anchorAt + 1, 0, step);
    } else {
      steps.push(step);
    }
  }
  const at = indexOf(currentPhaseId);
  return steps.map((step, index) => ({
    ...step,
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
  /** The stamp's tester (`by <persona>`); '' when the line carries none. */
  readonly tester: string;
  readonly criteria: readonly ProofCriterion[];
  readonly findings: readonly string[];
  /** The walkthrough video's file name (`tickets/videos/<name>`); null = none (a `tests` proof, or removed). */
  readonly video: string | null;
  /** The size limit freed the video: the card says so instead of showing a player. */
  readonly videoRemoved: boolean;
  /** The video's chapters, one per criterion shot: seconds from the start and the label. */
  readonly chapters: readonly ProofChapter[];
}

export interface ProofChapter {
  readonly atSec: number;
  readonly label: string;
}

const VIDEO_HEAD = /^###\s+video\s*$/i;
const VIDEO_PLAYER = /!\[\]\(\.\.\/videos\/([^)]+)\)/;
const VIDEO_CHAPTER = /^- (\d+):(\d{2}) (.+)$/;
const VIDEO_REMOVED = /^Video removed \(size limit\)\.$/;
const OTHER_HEAD = /^###\s+/;

const TESTED_ON = /^Tested on .+$/m;
const TESTED_BY = /^Tested on \S+ by (\S+)/m;
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
export function proofOf(rawSection: string): ProofReport {
  const sectionText = maskFences(rawSection);
  const testedOn = TESTED_ON.exec(sectionText)?.[0]?.trim() ?? '';
  const criteria: ProofCriterion[] = [];
  const findings: string[] = [];
  let inFindings = false;
  let inVideo = false;
  let video: string | null = null;
  let videoRemoved = false;
  const chapters: ProofChapter[] = [];
  for (const line of sectionText.split('\n')) {
    if (FINDINGS_HEAD.test(line)) {
      inFindings = true;
      inVideo = false;
      continue;
    }
    if (VIDEO_HEAD.test(line)) {
      inVideo = true;
      continue;
    }
    if (inVideo) {
      if (OTHER_HEAD.test(line)) {
        inVideo = false;
      } else {
        const player = VIDEO_PLAYER.exec(line);
        const chapter = VIDEO_CHAPTER.exec(line.trim());
        if (player !== null) {
          video = player[1]!;
        } else if (chapter !== null) {
          chapters.push({ atSec: Number(chapter[1]) * 60 + Number(chapter[2]), label: chapter[3]! });
        } else if (VIDEO_REMOVED.test(line.trim())) {
          videoRemoved = true;
        }
        continue;
      }
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
  return {
    testedOn,
    tester: TESTED_BY.exec(sectionText)?.[1]?.trim() ?? '',
    criteria,
    findings,
    video,
    videoRemoved,
    chapters,
  };
}

/**
 * The proof verdict's recommendation sentence: `<Tester> empfiehlt die
 * Annahme.` — the tester the stamp names, its first letter raised; null
 * when the stamp names none (the verdict box then shows the count
 * alone). Tolerant by construction: it exists exactly when a tester is
 * readable, never guessed.
 */
export function proofRecommendationOf(report: ProofReport): string | null {
  const tester = report.tester.trim();
  return tester === '' ? null : `${tester.charAt(0).toUpperCase()}${tester.slice(1)} recommends accepting.`;
}

// --- the thread (prototype screen 04) ---------------------------------------------

/**
 * One chat message as the ticket's thread renders it — the active chat
 * session's message slice, mirrored here so this screen stays decoupled
 * from the chat tab's DTO (the parent binds the same objects).
 */
export interface ThreadMessage {
  readonly role: 'owner' | 'mission';
  readonly text: string;
  /** The mission's thinking trace, folded away after completion. */
  readonly thought: string | null;
  /** ISO stamp; '' when the desk omitted it. */
  readonly at: string;
}

/** One proposal the thread renders as its card line (the readable slice). */
export interface ThreadProposal {
  readonly id: string;
  readonly state: 'pending' | 'confirmed' | 'dismissed';
  readonly summary: string;
  /** ISO stamp of the proposal; '' when the desk omitted it. */
  readonly at: string;
}

/** One entry the thread list renders: a message bubble or a proposal card. */
export type ThreadItem =
  | { readonly kind: 'message'; readonly at: string; readonly message: ThreadMessage }
  | { readonly kind: 'proposal'; readonly at: string; readonly proposal: ThreadProposal };

/** One session proposal JSON as the card line reads it; null when unusable. */
function threadProposalOf(raw: unknown): ThreadProposal | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const id = typeof body['id'] === 'string' ? body['id'] : '';
  if (id === '') {
    return null;
  }
  const state = body['state'] === 'confirmed' || body['state'] === 'dismissed' ? body['state'] : 'pending';
  return {
    id,
    state,
    summary: typeof body['summary'] === 'string' ? body['summary'] : '',
    at: typeof body['at'] === 'string' ? body['at'] : '',
  };
}

/**
 * The thread's filtered view of the ACTIVE chat session (concept: the
 * gefilterte Sicht): the messages whose text names the ticket plus the
 * proposal cards whose command does (the whole session JSON serialized —
 * tolerant, the id rides different fields per command kind). Stamped
 * items interleave by their ISO stamps (equal stamps keep the session's
 * message-before-proposal order), unstamped ones degrade to file order
 * — messages first, then proposals. An empty result renders the
 * 'No messages about' line; an empty id never matches.
 */
export function threadItemsOf(
  id: string,
  messages: readonly ThreadMessage[],
  proposals: readonly unknown[],
): ThreadItem[] {
  if (id === '') {
    return [];
  }
  const items: ThreadItem[] = [];
  for (const message of messages) {
    if (message.text.includes(id)) {
      items.push({ kind: 'message', at: message.at, message });
    }
  }
  for (const raw of proposals) {
    const proposal = threadProposalOf(raw);
    if (proposal !== null && JSON.stringify(raw).includes(id)) {
      items.push({ kind: 'proposal', at: proposal.at, proposal });
    }
  }
  const stamped = items.every((item) => item.at !== '');
  if (!stamped) {
    const rank = (item: ThreadItem): number => (item.kind === 'message' ? 0 : 1);
    return items.sort((a, b) => rank(a) - rank(b));
  }
  const rank = (item: ThreadItem): number => (item.kind === 'message' ? 0 : 1);
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank(a) - rank(b)));
}

// --- the section splitter --------------------------------------------------------

/** The section titles the screen treats specially (lowercased, exact). */
const SPECIAL_TITLES = ['verification', 'report', 'changes', 'handover', 'log', 'verlauf'] as const;

function isSpecialTitle(title: string): title is (typeof SPECIAL_TITLES)[number] {
  return (SPECIAL_TITLES as readonly string[]).includes(title);
}

/**
 * The ticket body, split for the screen (concept §5.3/§5.5): the generic
 * sections render as Markdown; Verification feeds the proof card; Report
 * feeds the scout report card (E8); Verlauf feeds its yaml box; Log gets
 * its special treatment and never renders raw.
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
  /**
   * The `## Verlauf` section's text (heading excluded); null when absent —
   * the chapter never reaches the generic render; the yaml box renders
   * the doc's parsed entries instead.
   */
  readonly verlauf: string | null;
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
    verlauf: [],
  };
  let target: 'body' | (typeof SPECIAL_TITLES)[number] = 'body';
  const sourceLines = source.split('\n');
  const scan = maskFenceLines(sourceLines);
  for (const [i, line] of sourceLines.entries()) {
    const heading = H2.exec(scan[i]!);
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
    verlauf: sectionOf(buckets.verlauf),
  };
}

/**
 * The Verlauf chapter's pieces (concept §5.4) — the parsed entries ride
 * on the doc (`TicketDoc.verlauf`, parsed off the text by the api layer's
 * tolerant mirror of the engine's parser); these helpers dress them for
 * the screen: the canonical yaml line, the gate pills' per-phase cost,
 * the bar's total, the head card's dollars.
 */

/** The dollars as the cost slots write them (`$1.87`); null unless a usable positive number — never a 0-fake. */
export function usdLabelOf(cost: number | null | undefined): string | null {
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0
    ? `$${cost.toFixed(2)}`
    : null;
}

/**
 * One entry as its canonical yaml line (the engine's renderVerlaufLine
 * grammar, mirrored): `- { phase: plan, persona: paul, … }` — null and
 * empty fields (a torn line's leavings) write `null`, so every line
 * carries all seven keys, well-formed, always.
 */
export function verlaufLineOf(entry: McVerlaufEntry): string {
  const part = (key: string, value: string | number | null): string =>
    ` ${key}: ${value === null || value === '' ? 'null' : value}`;
  return (
    `- {${part('phase', entry.phase)},${part('persona', entry.persona)},${part('model', entry.model)},` +
    `${part('tokens', entry.tokens)},${part('cost', entry.cost)},${part('dauer', entry.dauer)},` +
    `${part('ausgang', entry.ausgang)} }`
  );
}

/**
 * The chapter as its yaml box renders it: one canonical line per entry —
 * null when nothing parseable remains (a chapter of prose alone or a
 * torn line-less body renders no box, never prose).
 */
export function verlaufBoxOf(entries: readonly McVerlaufEntry[]): string | null {
  return entries.length === 0 ? null : entries.map(verlaufLineOf).join('\n');
}

/**
 * The Verlauf entries' costs per phase, summed (lowercased phase key →
 * dollars): a phase's gate pill reads its figure here. Entries without a
 * phase or without a known cost skip — an unknown cost never counts as 0.
 */
export function verlaufCostsOf(entries: readonly McVerlaufEntry[]): ReadonlyMap<string, number> {
  const costs = new Map<string, number>();
  for (const entry of entries) {
    const phase = entry.phase?.trim().toLowerCase();
    if (phase === undefined || phase === '') {
      continue;
    }
    if (typeof entry.cost !== 'number' || !Number.isFinite(entry.cost) || entry.cost <= 0) {
      continue;
    }
    costs.set(phase, (costs.get(phase) ?? 0) + entry.cost);
  }
  return costs;
}

/**
 * The gate pill's cost figure for one step (`0.24`, no sign,
 * the prototype's pill): the Verlauf sum of the step's phase, matched by
 * id first, its title as the fallback (a hand-written chapter may carry
 * `Verlauf`-style titles); null when the phase's runs cost nothing.
 */
export function gateCostOf(
  costs: ReadonlyMap<string, number>,
  step: { readonly id: string; readonly title: string },
): string | null {
  const sum = costs.get(step.id.trim().toLowerCase()) ?? costs.get(step.title.trim().toLowerCase());
  return sum !== undefined && sum > 0 ? sum.toFixed(2) : null;
}

/** The bar's end slot: every Verlauf cost summed (`$1.87`); null until the runs cost something. */
export function verlaufTotalOf(entries: readonly McVerlaufEntry[]): string | null {
  let sum = 0;
  for (const entry of entries) {
    if (typeof entry.cost === 'number' && Number.isFinite(entry.cost) && entry.cost > 0) {
      sum += entry.cost;
    }
  }
  return usdLabelOf(sum);
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
export function scoutReportOf(rawSection: string): ScoutReport {
  const sectionText = maskFences(rawSection);
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

/** One patch row as the git table renders it: the two line numbers, the sign, the code. */
export interface PatchRow {
  readonly kind: PatchLineKind | 'hunk';
  /** The old file's line number; null when the row carries none. */
  readonly oldNo: number | null;
  /** The new file's line number; null when the row carries none. */
  readonly newNo: number | null;
  /** '+' added, '−' removed, '' context/meta/hunk — the `.sg` column. */
  readonly sign: string;
  readonly text: string;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The unified patch as numbered rows (the proof's `.ln`/`.sg` table):
 * hunk headers seed the counters, `+`/`-`/context rows spend them, the
 * fence lines (`diff`, `index`, `---`, `+++`, `\ No newline`) ride as
 * meta without numbers. Tolerant of any order — a patch that skips the
 * hunk header still renders, the numbers just start at 1.
 */
export function patchRowsOf(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  if (patch === '') {
    return rows; // a binary file's empty patch — no rows
  }
  let oldNo = 1;
  let newNo = 1;
  const lines = patch.split('\n');
  // A '\n'-terminated patch ends in an empty string — an artifact, not a row.
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  for (const line of lines) {
    const hunk = HUNK_HEAD.exec(line);
    if (hunk !== null) {
      oldNo = parseInt(hunk[1]!, 10);
      newNo = parseInt(hunk[2]!, 10);
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, sign: '', text: line });
      continue;
    }
    if (patchLineKind(line) === 'meta' || line.startsWith('\\')) {
      rows.push({ kind: 'meta', oldNo: null, newNo: null, sign: '', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo: newNo++, sign: '+', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, sign: '−', text: line.slice(1) });
      continue;
    }
    rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, sign: '', text: line.slice(1) });
  }
  return rows;
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
  /**
   * The ticket's chain delta (E9, concept §5.7) — the parsed `chain:`
   * frontmatter entries; empty = the standard flow applies silently.
   */
  readonly chain: readonly ChainEntryView[];
  /**
   * The ticket's priority id as the vault configures it — the id IS the
   * chip's label (no fixed four); null when the card carries none.
   */
  readonly priority: string | null;
  /** The vault's priority vocabulary in weight order (first = highest). */
  readonly priorities: readonly string[];
  /** The OPEN blockers, derived on the desk; `[]` = unblocked (or omitted). */
  readonly blocked: readonly string[];
  /** The `blocked-by:` ids as written (T-0050); `[]` when the frontmatter has none. */
  readonly blockedBy: readonly string[];
  /** The settled-run usage off the card (the head cost slot's figure); absent when the desk has none. */
  readonly usage?: McTicketUsage;
  /**
   * The `## Verlauf` chapter's entries parsed off `text` (the api layer's
   * tolerant mirror of the engine's parser); empty = the file carries no
   * chapter — the yaml box and the gate pills' costs stay hidden then.
   */
  readonly verlauf: readonly McVerlaufEntry[];
}

// --- the priority chip and the blocker line ---------------------------------------

/**
 * The one compact line under the header: open blockers warn ('Blocked
 * by …'), declared-but-open `blocked-by:` ids read neutral ('Depends on
 * …'); null = nothing to show. The derived list wins — it is what the
 * desk computed; the raw list is the fallback a desk that does not
 * derive blockers yet still owes the screen.
 */
export interface TicketBlockerNote {
  readonly kind: 'blocked' | 'depends';
  readonly ids: readonly string[];
}

export function blockerNoteOf(blocked: readonly string[], blockedBy: readonly string[]): TicketBlockerNote | null {
  if (blocked.length > 0) {
    return { kind: 'blocked', ids: blocked };
  }
  if (blockedBy.length > 0) {
    return { kind: 'depends', ids: blockedBy };
  }
  return null;
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
  /**
   * One file as it stands on the ticket branch, for the diff's "Whole
   * file" view (`GET /api/tickets/<id>/file/<path>`); null until it is
   * fetched or when the desk has none. Optional: an adapter without it
   * offers no whole-file view.
   */
  wholeFile?(path: string): WholeFile | null;
  /**
   * The ticket's shared plan state (E10-2): the version the model saw, the
   * owner's edits since and the marked lines; null until the desk answers.
   * Optional.
   */
  plan?(): McPlanStatus | null;
  /**
   * The run estimate for a gate by a persona, from the owner's own
   * history; null while it loads, when the persona's model is unknown or
   * when fewer than three similar runs exist (E11-4). Optional.
   */
  estimate?(gate: string, persona: string): McEstimate | null;
  /** The URL a walkthrough `<video>` plays (`GET /api/videos/<name>`); null until it can serve it. Optional: an adapter without it shows no player. */
  videoUrl?(name: string): string | null;

  /** The back arrow: the shell closes the screen. */
  onClose(): void;
  /**
   * The gate sheet's interventions (E9, concept §5.7): prefill the chat
   * composer with the setChain command the sheet built — one mutation
   * path, the owner reviews and sends, the proposal card confirms.
   */
  proposeChain(text: string): void;
  /**
   * The ticket view's 'Change by chat' CTA: prefill the composer with a
   * free command (`<id>: …`). Optional while the parent wires the name —
   * the view falls back to `proposeChain`, the same one prefill path.
   */
  prefillChat?(text: string): void;
  /**
   * The ticket face's 'Shape with Paul' (E10-3): opens the chat on this
   * ticket's shape session. Optional — an adapter without shape sessions
   * leaves it off and the button hides.
   */
  shape?(ticketId: string): void;
  /**
   * The ticket face's 'Plan to approve' (E10-4): opens the approval of
   * the plan's parts. Optional — an adapter without it hides the button.
   */
  approvePlan?(ticketId: string): void;
  /**
   * The gate sheet's way into the flow editor (E10-5). Optional — an
   * adapter without it hides the row.
   */
  openFlow?(ticketId: string): void;
  /** The raw edit's save; one commit on the desk, the refusal inline. */
  save(text: string): Promise<TicketSaveReply>;
  accept(): Promise<TicketActionReply>;
  /** The note is mandatory — an empty one refuses on the desk and here. */
  sendBack(note: string, comments?: readonly ReviewComment[]): Promise<TicketActionReply>;
  /**
   * The work tab's card back-swipe parked a send-back on this ticket
   * (`McState.sendBackPending`): true names the OPEN ticket — the view
   * lands on its Send-back panel and consumes the flag through
   * `dismissSendBack`. Optional: an adapter without it never auto-opens
   * the panel.
   */
  sendBackOpen?(): boolean;
  /** The view consumed the parked send-back (panel opened, or the owner dismissed). */
  dismissSendBack?(): void;
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
  proposeChain: () => undefined,
  prefillChat: () => undefined,
  save: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
  accept: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
  sendBack: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
};

export const MC_TICKET = new InjectionToken<TicketVm>('mc-ticket', {
  factory: () => EMPTY_TICKET,
});

// --- diff review (E11-2) ----------------------------------------------------------

/** A file's full text on the ticket branch; `truncated` when the desk cut a very large one. */
export interface WholeFile {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The patch laid over the whole file: every line of the new file in
 * order, the patch's added/removed rows in place, the lines between and
 * around the hunks as context. Hunk headers drop out (the file is
 * continuous); a patch that skips its hunk header just lays over the
 * start. A shorter file than the patch claims ends the fill early.
 */
export function wholeFileRowsOf(patch: string, content: string): PatchRow[] {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const out: PatchRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  const fillTo = (until: number): void => {
    while (newNo < until && newNo <= lines.length) {
      out.push({ kind: 'context', oldNo: oldNo++, newNo, sign: '', text: lines[newNo - 1]! });
      newNo++;
    }
  };
  for (const row of patchRowsOf(patch)) {
    if (row.kind === 'hunk') {
      const head = HUNK_HEAD.exec(row.text);
      if (head !== null) {
        const newStart = parseInt(head[2]!, 10);
        fillTo(newStart);
        oldNo = Math.max(parseInt(head[1]!, 10), 1);
        newNo = Math.max(newStart, 1);
      }
      continue;
    }
    if (row.kind === 'meta') {
      continue;
    }
    out.push(row);
    if (row.oldNo !== null) {
      oldNo = row.oldNo + 1;
    }
    if (row.newNo !== null) {
      newNo = row.newNo + 1;
    }
  }
  fillTo(lines.length + 1);
  return out;
}

/** A row with the change group it belongs to (null for unchanged rows). */
export interface ChangeRow {
  readonly row: PatchRow;
  /** 0-based index of the contiguous run of added/removed rows; null = unchanged. */
  readonly change: number | null;
  /** True on the first row of a run — the row "Previous/Next change" scrolls to. */
  readonly first: boolean;
}

/** Marks the contiguous runs of added/removed rows, numbering them from 0. */
export function changeRowsOf(rows: readonly PatchRow[]): ChangeRow[] {
  const out: ChangeRow[] = [];
  let group = -1;
  let inRun = false;
  for (const row of rows) {
    const changed = row.kind === 'add' || row.kind === 'del';
    if (changed && !inRun) {
      group++;
    }
    out.push({ row, change: changed ? group : null, first: changed && !inRun });
    inRun = changed;
  }
  return out;
}

/** How many change runs the rows hold. */
export function changeCountOf(rows: readonly ChangeRow[]): number {
  return rows.reduce((max, r) => (r.change !== null && r.change + 1 > max ? r.change + 1 : max), 0);
}

/**
 * The key a "viewed" mark is stored under: the path plus a short hash of
 * its patch, so a file that changed after the owner looked at it reads
 * as not viewed again.
 */
export function viewedKeyOf(path: string, patch: string): string {
  let hash = 5381;
  for (let i = 0; i < patch.length; i++) {
    hash = ((hash << 5) + hash + patch.charCodeAt(i)) | 0;
  }
  return `${path}#${(hash >>> 0).toString(36)}`;
}

// --- line comments (E11-3) ----------------------------------------------------------

/** One review comment on the diff; the line numbers are the NEW file's. */
export interface ReviewComment {
  readonly file: string;
  readonly line: number;
  /** The range's last line; null = a single line. */
  readonly endLine: number | null;
  readonly text: string;
}

/** `Line 27` or `Lines 30–33`, as the cards and the composer say it. */
export function commentLabelOf(comment: { line: number; endLine: number | null }): string {
  return comment.endLine === null ? `Line ${comment.line}` : `Lines ${comment.line}–${comment.endLine}`;
}

/** The send-back button's wording: with comments it names how many. */
export function sendBackLabelOf(count: number): string {
  return count === 0 ? 'Send back…' : `Send back with ${count} ${count === 1 ? 'comment' : 'comments'}…`;
}

// --- the cost table and the estimate (E11-4) ----------------------------------------

/** One run of the cost table. */
export interface CostRow {
  /** The gate, by its pipeline title when the pipeline knows it. */
  readonly step: string;
  /** `Ben · sonnet`; '' when the line carries neither. */
  readonly who: string;
  /** `9 min`; '' when unknown. */
  readonly time: string;
  /** The Log's short token words (`48k`); '' when unknown. */
  readonly tokens: string;
  /** `$0.30`, or `—` when the run recorded no cost. */
  readonly cost: string;
  /** `handed over` / `failed` / `stopped`; '' when unreadable. */
  readonly outcome: string;
}

export interface CostTable {
  readonly rows: readonly CostRow[];
  /** The sum of every known cost; null until some run cost something. */
  readonly total: string | null;
  /** Whole minutes over the runs that recorded one; null when none did. */
  readonly totalTime: string | null;
}

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The ticket's `## Verlauf` as the cost table at its end: one row per
 * settled run, oldest first as written, and the total under it. An
 * unknown cost reads `—` and never counts as zero.
 */
export function costTableOf(entries: readonly McVerlaufEntry[], phaseTitle: (id: string) => string): CostTable {
  let minutes: number | null = null;
  const rows: CostRow[] = entries.map((entry) => {
    const mins = /^(\d+)m$/.exec(entry.dauer.trim());
    if (mins !== null) {
      minutes = (minutes ?? 0) + Number(mins[1]);
    }
    const who = [entry.persona === null ? '' : titleCase(entry.persona), entry.model ?? ''].filter((p) => p !== '').join(' · ');
    return {
      step: entry.phase === null ? '—' : phaseTitle(entry.phase),
      who,
      time: mins === null ? '' : `${mins[1]} min`,
      tokens: entry.tokens,
      cost: usdLabelOf(entry.cost) ?? '—',
      outcome: entry.ausgang === 'handed-over' ? 'handed over' : (entry.ausgang ?? ''),
    };
  });
  return { rows, total: verlaufTotalOf(entries), totalTime: minutes === null ? null : `${minutes} min` };
}

/** 48000 → `48k`, 3400000 → `3.4M`: the Log's token words. */
export function tokenWordsOf(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

/**
 * The estimate sentence with its basis stated:
 * `About $0.30 · 9 min · 48k tokens — median of 6 earlier Build runs by Ben on sonnet.`
 */
export function estimateLineOf(estimate: McEstimate, gateTitle: string): string {
  const figures = [
    `About ${usdLabelOf(estimate.cost) ?? `$${estimate.cost.toFixed(2)}`}`,
    ...(estimate.minutes === null ? [] : [`${estimate.minutes} min`]),
    ...(estimate.tokens === null ? [] : [`${tokenWordsOf(estimate.tokens)} tokens`]),
  ].join(' · ');
  return `${figures} — median of ${estimate.runs} earlier ${gateTitle} runs by ${titleCase(estimate.persona)} on ${estimate.model}.`;
}

// --- the shared plan (E10-2) ---------------------------------------------------------

/**
 * The status line over the plan: `The model saw plan v7 · 1 edit of yours
 * since`; null when the model has not worked on the plan (nothing to
 * compare against).
 */
export function planStatusLineOf(plan: McPlanStatus): string | null {
  if (plan.version === null) {
    return null;
  }
  const since = plan.edits === 0 ? 'no edits of yours since' : `${plan.edits} ${plan.edits === 1 ? 'edit' : 'edits'} of yours since`;
  return `The model saw plan v${plan.version} · ${since}`;
}

/** The chip over the composer: `1 new edit of yours goes along`; null when there is nothing to send. */
export function planChipOf(plan: McPlanStatus | null): string | null {
  if (plan === null || plan.edits === 0) {
    return null;
  }
  return `${plan.edits} new ${plan.edits === 1 ? 'edit' : 'edits'} of yours ${plan.edits === 1 ? 'goes' : 'go'} along`;
}
