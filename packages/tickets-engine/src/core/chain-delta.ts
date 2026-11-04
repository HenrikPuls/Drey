/**
 * The `chain:` delta's grammar, canonical rendering and the standard +
 * delta merge (E9, concept §5.7). Strict writer, strict parser, tolerant
 * merger: an entry that does not parse refuses to null at the parser (the
 * ticket reader reports it as an issue, the chat refuses it as a
 * command), and the merger renders whatever valid data it gets — the
 * semantic guard (`validateChain`) runs only where a write is decided.
 *
 * The grammar (one entry per `chain:` list line):
 *
 *     insert security(ralf, notify) after review
 *     skip verify
 *     notify build
 *     move verify after approve
 *     assign review tessa
 *
 * - `insert <phase>[(<persona>[, notify] | notify)] after|before <anchor>`
 *   adds a pipeline phase to this ticket's chain at the anchor — a
 *   front-loaded revisit when the phase already sits in the standard
 *   flow (each phase may be revisited at most once).
 * - `skip <phase>` bypasses a gate for this ticket (rendered struck).
 * - `notify <phase>` is the Bescheid rule: the gate's completion lands a
 *   card in "Needs you".
 * - `move <phase> after|before <anchor>` runs a standard gate somewhere
 *   else in this ticket's chain (E10-5, the flow editor).
 * - `assign <phase> <persona>` pins who works a standard gate (E10-5).
 *
 * Phase ids are lowercase words with dashes, exactly the pipeline's id
 * grammar. Persona names are bare lowercase words.
 */
import type { ChainEntry, ChainStep } from '../contracts/chain';

const PHASE_ID = /^[a-z][a-z0-9-]*$/;
const SKIP_RE = /^skip ([a-z][a-z0-9-]*)$/;
const NOTIFY_RE = /^notify ([a-z][a-z0-9-]*)$/;
const MOVE_RE = /^move ([a-z][a-z0-9-]*) (after|before) ([a-z][a-z0-9-]*)$/;
const ASSIGN_RE = /^assign ([a-z][a-z0-9-]*) ([a-z][a-z0-9-]*)$/;
const INSERT_RE = /^insert ([a-z][a-z0-9-]*)(?:\(([^)]*)\))? (after|before) ([a-z][a-z0-9-]*)$/;

/** Parses one `chain:` entry; null when the text is not the grammar (never a guess). */
export function parseChainEntry(text: string): ChainEntry | null {
  const raw = text.trim();
  const skip = SKIP_RE.exec(raw);
  if (skip !== null) {
    return { kind: 'skip', phase: skip[1]! };
  }
  const notify = NOTIFY_RE.exec(raw);
  if (notify !== null) {
    return { kind: 'notify', phase: notify[1]! };
  }
  const move = MOVE_RE.exec(raw);
  if (move !== null) {
    return { kind: 'move', phase: move[1]!, anchor: move[3]!, position: move[2] === 'before' ? 'before' : 'after' };
  }
  const assign = ASSIGN_RE.exec(raw);
  if (assign !== null) {
    return { kind: 'assign', phase: assign[1]!, persona: assign[2]! };
  }
  const insert = INSERT_RE.exec(raw);
  if (insert !== null) {
    const opts = insert[2] === undefined ? [] : insert[2].split(',').map((o) => o.trim()).filter((o) => o !== '');
    let persona: string | null = null;
    let notifyFlag = false;
    for (const opt of opts) {
      if (opt === 'notify') {
        notifyFlag = true;
      } else if (PERSONA_ID.test(opt) && persona === null) {
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

const PERSONA_ID = /^[a-z][a-z0-9-]*$/;

/**
 * The manual step (E10-6): a gate the owner works by hand. It is not a
 * pipeline directory — the id `manual` (or `manual-<word>` for a second
 * one) is valid in any chain as an INSERT, anchored on a real phase. The
 * ticket parks at the anchor with the `awaiting:` field until the owner
 * accepts or sends it back.
 */
export const MANUAL_PHASE = 'manual';
export const MANUAL_TITLE = 'Manual step';

export function isManualPhase(id: string): boolean {
  return id === MANUAL_PHASE || /^manual-[a-z0-9][a-z0-9-]*$/.test(id);
}

/** Renders one entry in the canonical grammar (the round trip with `parseChainEntry`). */
export function renderChainEntry(entry: ChainEntry): string {
  switch (entry.kind) {
    case 'skip':
      return `skip ${entry.phase}`;
    case 'notify':
      return `notify ${entry.phase}`;
    case 'move':
      return `move ${entry.phase} ${entry.position} ${entry.anchor}`;
    case 'assign':
      return `assign ${entry.phase} ${entry.persona}`;
    case 'insert': {
      const opts: string[] = [];
      if (entry.persona !== null) {
        opts.push(entry.persona);
      }
      if (entry.notify) {
        opts.push('notify');
      }
      const paren = opts.length > 0 ? `(${opts.join(', ')})` : '';
      return `insert ${entry.phase}${paren} ${entry.position} ${entry.anchor}`;
    }
  }
}

/** Renders the whole delta — what the frontmatter's `chain:` list holds. */
export function renderChainEntries(entries: readonly ChainEntry[]): string[] {
  return entries.map((entry) => renderChainEntry(entry));
}

/**
 * Merges the standard flow (the pipeline's ordered phases) with a
 * ticket's delta into the concrete chain the gate bar renders. Tolerant
 * by design: unknown phases render with their id as title, and the
 * state fold simply finds no current step when the ticket sits outside
 * the merged chain. Writes are guarded by `validateChain`, not here.
 */
export function mergeChain(
  phases: readonly { readonly id: string; readonly title: string }[],
  currentPhaseId: string,
  entries: readonly ChainEntry[],
): ChainStep[] {
  const steps: ChainStep[] = phases.map((phase) => ({
    phase: phase.id,
    title: phase.title,
    state: 'future',
    inserted: false,
    skipped: false,
    notify: false,
    persona: null,
    moved: false,
  }));
  const indexOf = (phase: string): number => steps.findIndex((step) => step.phase === phase);
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
    if (entry.kind === 'assign') {
      const at = indexOf(entry.phase);
      if (at >= 0) {
        steps[at] = { ...steps[at]!, persona: entry.persona };
      }
      continue;
    }
    if (entry.kind === 'move') {
      const from = indexOf(entry.phase);
      const anchorAt = indexOf(entry.anchor);
      if (from >= 0 && anchorAt >= 0 && from !== anchorAt) {
        const [step] = steps.splice(from, 1);
        const target = indexOf(entry.anchor);
        steps.splice(entry.position === 'before' ? target : target + 1, 0, { ...step!, moved: true });
      }
      continue;
    }
    // insert: a second occurrence of an existing phase is the one thing
    // validateChain refuses; the merger still renders it (read tolerance).
    const anchorAt = indexOf(entry.anchor);
    const title = phases.find((phase) => phase.id === entry.phase)?.title ?? (isManualPhase(entry.phase) ? MANUAL_TITLE : entry.phase);
    const step: ChainStep = {
      phase: entry.phase,
      title,
      state: 'future',
      inserted: true,
      skipped: false,
      notify: entry.notify,
      persona: entry.persona,
      moved: false,
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

/**
 * The semantic guard for WRITES (chat command, board service): every
 * referenced phase must exist in the pipeline, no phase may occur twice
 * in the merged chain, a skip or insert-anchor must point at the
 * current-or-future flow, and a notify must not ask for news from a
 * gate the ticket already passed. Returns the refusal line, or null
 * when the delta is sound.
 */
export function validateChain(
  phases: readonly { readonly id: string; readonly title: string }[],
  currentPhaseId: string,
  entries: readonly ChainEntry[],
): string | null {
  const known = new Set(phases.map((phase) => phase.id));
  const indexOf = (phase: string): number => phases.findIndex((p) => p.id === phase);
  const currentIndex = indexOf(currentPhaseId);
  const inserts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'insert') {
      inserts.set(entry.phase, (inserts.get(entry.phase) ?? 0) + 1);
    }
  }
  for (const entry of entries) {
    const refs =
      entry.kind === 'insert' || entry.kind === 'move' ? [entry.phase, entry.anchor] : [entry.phase];
    for (const ref of refs) {
      // A manual step is no pipeline directory: it is valid wherever this delta inserts it.
      if (!known.has(ref) && !(isManualPhase(ref) && inserts.has(ref))) {
        return `the pipeline has no phase "${ref}"`;
      }
    }
    if (entry.kind === 'insert') {
      if (entry.anchor === entry.phase) {
        return `${entry.phase} cannot anchor its own insert`;
      }
      if ((inserts.get(entry.phase) ?? 0) > 1) {
        return `${entry.phase} would be inserted twice — a gate revisits a phase at most once`;
      }
      if (entries.some((other) => other.kind === 'skip' && other.phase === entry.phase)) {
        return `${entry.phase} is both skipped and inserted — strike the gate or revisit it, not both`;
      }
    }
    if (entry.kind === 'move') {
      if (entry.anchor === entry.phase) {
        return `${entry.phase} cannot be moved next to itself`;
      }
      if (entries.filter((other) => other.kind === 'move' && other.phase === entry.phase).length > 1) {
        return `${entry.phase} would be moved twice`;
      }
      if (inserts.has(entry.phase)) {
        return `${entry.phase} is inserted by this ticket — move that insert instead`;
      }
      if (entries.some((other) => other.kind === 'skip' && other.phase === entry.phase)) {
        return `${entry.phase} is both skipped and moved — strike the gate or move it, not both`;
      }
      if (currentIndex >= 0 && indexOf(entry.phase) <= currentIndex) {
        return `${entry.phase} is the current or a past gate — a move only reaches future gates`;
      }
      if (currentIndex >= 0 && (indexOf(entry.anchor) < currentIndex || (indexOf(entry.anchor) === currentIndex && entry.position === 'before'))) {
        return `${entry.phase} cannot move ahead of the current gate`;
      }
    }
    if (entry.kind === 'assign') {
      if (!PERSONA_ID.test(entry.persona)) {
        return `"${entry.persona}" is not a persona id`;
      }
      if (inserts.has(entry.phase)) {
        return `${entry.phase} is inserted by this ticket — set its persona in the insert`;
      }
      if (entries.filter((other) => other.kind === 'assign' && other.phase === entry.phase).length > 1) {
        return `${entry.phase} would get two personas`;
      }
      if (currentIndex >= 0 && indexOf(entry.phase) <= currentIndex) {
        return `${entry.phase} is the current or a past gate — a persona only changes on future gates`;
      }
    }
    if (entry.kind === 'skip' && currentIndex >= 0 && indexOf(entry.phase) <= currentIndex) {
      return `${entry.phase} is the current or a past gate — a skip only reaches future gates`;
    }
    if (entry.kind === 'insert' && currentIndex >= 0 && indexOf(entry.anchor) < currentIndex) {
      return `${entry.anchor} is a past gate — the anchor must be the current or a future gate`;
    }
    if (entry.kind === 'notify' && currentIndex >= 0 && indexOf(entry.phase) < currentIndex) {
      return `${entry.phase} already completed — a notify only reaches the current or future gates`;
    }
  }
  return null;
}
