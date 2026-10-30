/**
 * Ticket-file parsing, patching and canonical serialization (ADR-0076).
 *
 * The asymmetric-tolerance engine: machine writers produce the strict
 * canonical form; humans may write any YAML the `yaml` package parses;
 * the reader normalizes for display and REPORTS what it had to forgive
 * (an issue, never a guess). Patching goes through `yaml`'s document
 * mutation — the same discipline as `shared/frontmatter.ts` — so an
 * existing file's layout, comments and unknown keys survive a
 * transition rewrite untouched.
 */
import { Document, isScalar, parseDocument, Scalar } from 'yaml';
import { splitFrontmatter } from '../../../shared/frontmatter';
import {
  DEFAULT_RANK,
  TICKET_ID_PATTERN,
  branchForTicket,
  formatUtcStamp,
  stripPhasePrefix,
  TICKET_PRIORITIES,
  type TicketIssue,
  type TicketMeta,
  type TicketPriority,
  type TicketRun,
} from '../shared/tickets';

/** `entered-<phase>` key grammar (phase ids: lowercase, digits, dashes). */
const ENTERED_KEY = /^entered-([a-z][a-z0-9-]*)$/;

export interface ParsedTicket {
  readonly meta: TicketMeta;
  /** Findings so far; assembly adds board-level ones. */
  readonly issues: TicketIssue[];
}

/**
 * Extracted path facts: which phase directory, which stem. Only
 * ticket-shaped paths qualify (`tickets/<dir>/<T-nnnn>.md`); anything
 * else under `tickets/` is a stray file for the board to badge.
 * `phase` is the prefix-stripped directory id (`10-inbox` → `inbox`,
 * T-0041) — every consumer downstream sees clean ids; `phaseDir` keeps
 * the directory as written.
 */
export function ticketPathParts(
  relPath: string,
): { phaseDir: string; phase: string; stem: string } | null {
  const match = /^tickets\/([^/]+)\/([^/]+)\.md$/.exec(relPath);
  if (match === null) {
    return null;
  }
  return TICKET_ID_PATTERN.test(match[2]!)
    ? { phaseDir: match[1]!, phase: stripPhasePrefix(match[1]!), stem: match[2]! }
    : null;
}

/** Reads one ticket file into normalized meta + the issues found. */
export function parseTicketFile(text: string, relPath: string): ParsedTicket {
  const issues: TicketIssue[] = [];
  const parts = ticketPathParts(relPath);
  if (parts === null) {
    return { meta: emptyMeta(), issues: [{ level: 'error', message: `unexpected ticket path ${relPath}` }] };
  }

  const { yamlText, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return {
      meta: emptyMeta(parts.stem),
      issues: [{ level: 'error', message: 'no frontmatter fence' }],
    };
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return {
      meta: emptyMeta(parts.stem),
      issues: [{ level: 'error', message: `frontmatter does not parse: ${doc.errors[0]!.message}` }],
    };
  }
  const obj = doc.toJS() as Record<string, unknown>;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { meta: emptyMeta(parts.stem), issues: [{ level: 'error', message: 'frontmatter is not a mapping' }] };
  }

  // --- known fields -----------------------------------------------------
  const id = asText(obj['id']);
  if (id === null) {
    issues.push({ level: 'error', message: 'id is missing' });
  } else if (id !== parts.stem) {
    issues.push({ level: 'error', message: `id ${id} does not match file name ${parts.stem}` });
  }

  const title = asText(obj['title']);
  if (title === null) {
    issues.push({ level: 'warning', message: 'title is missing' });
  }

  const repo = asText(obj['repo']);
  const worker = asText(obj['worker']);

  const rawPriority = asText(obj['priority']);
  let priority: TicketPriority = 'normal';
  if (rawPriority === null) {
    issues.push({ level: 'warning', message: 'priority missing — read as normal' });
  } else if ((TICKET_PRIORITIES as readonly string[]).includes(rawPriority)) {
    priority = rawPriority as TicketPriority;
  } else {
    issues.push({ level: 'warning', message: `unknown priority "${rawPriority}" — read as normal` });
  }

  const rawRank = obj['rank'];
  let rank = DEFAULT_RANK;
  if (rawRank !== undefined && rawRank !== null) {
    if (typeof rawRank === 'number' && Number.isInteger(rawRank) && rawRank >= 0) {
      rank = rawRank;
    } else {
      issues.push({ level: 'warning', message: `rank is not a non-negative integer — read as ${DEFAULT_RANK}` });
    }
  }

  const branch = asText(obj['branch']);
  if (branch !== null && branch !== branchForTicket(parts.stem)) {
    issues.push({
      level: 'warning',
      message: `branch "${branch}" violates the rule t/<id> — the rule wins`,
    });
  }
  const claimedBy = asText(obj['claimed-by']);
  const claimedAt = asText(obj['claimed-at']);
  if (claimedBy !== null && claimedAt === null) {
    issues.push({ level: 'warning', message: 'claimed-by without claimed-at' });
  }

  const run = parseRun(obj['run'], issues);
  const references = asStringArray(obj['references']);
  const parkedReason = asText(obj['parked-reason']);
  const parkedAt = asText(obj['parked-at']);

  // --- entered-<phase> stamps --------------------------------------------
  const entered: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const match = ENTERED_KEY.exec(key);
    if (match === null) {
      continue;
    }
    const stamp = asText(value);
    if (stamp !== null) {
      entered[match[1]!] = stamp;
    } else {
      issues.push({ level: 'warning', message: `${key} is not a readable timestamp` });
    }
  }
  if (entered['inbox'] === undefined && parts.phase !== 'inbox') {
    // Not an error — the board still shows the ticket — but worth a badge.
    issues.push({ level: 'noise', message: 'no entered-inbox stamp' });
  }

  return {
    meta: {
      id: parts.stem,
      title,
      repo,
      worker,
      priority,
      rank,
      // The rule wins over whatever the file says (ADR-0076).
      branch: branchForTicket(parts.stem),
      claimedBy,
      claimedAt,
      run,
      references,
      parkedReason,
      parkedAt,
      entered,
    },
    issues,
  };
}

function emptyMeta(stem?: string): TicketMeta {
  return {
    id: stem ?? null,
    title: null,
    repo: null,
    worker: null,
    priority: 'normal',
    rank: DEFAULT_RANK,
    branch: stem === undefined ? null : branchForTicket(stem),
    claimedBy: null,
    claimedAt: null,
    run: null,
    references: [],
    parkedReason: null,
    parkedAt: null,
    entered: {},
  };
}

function parseRun(value: unknown, issues: TicketIssue[]): TicketRun | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ level: 'warning', message: 'run is not a mapping — ignored' });
    return null;
  }
  const map = value as Record<string, unknown>;
  const pid = map['pid'];
  const startedAt = asText(map['started-at']);
  const stream = asText(map['stream']);
  if (typeof pid !== 'number' || startedAt === null || stream === null) {
    issues.push({ level: 'warning', message: 'run needs numeric pid, started-at and stream — ignored' });
    return null;
  }
  return { pid, 'started-at': startedAt, stream };
}

// ---------------------------------------------------------------------------
// The machine gate's input: the ticket's acceptance commands.

/** A ticket body's H2 sections, trimmed (frontmatter and fences off). */
export function ticketSections(text: string): { description: string; plan: string } {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  let current: 'description' | 'plan' | null = null;
  const description: string[] = [];
  const plan: string[] = [];
  for (const line of body.split('\n')) {
    if (/^##\s+Description\s*$/.test(line)) {
      current = 'description';
      continue;
    }
    if (/^##\s+Plan\s*$/.test(line)) {
      current = 'plan';
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null; // Log or a future section
      continue;
    }
    if (current === 'description') {
      description.push(line);
    } else if (current === 'plan') {
      plan.push(line);
    }
  }
  return {
    description: description.join('\n').trim(),
    plan: plan.join('\n').trim(),
  };
}

/**
 * The backticked checkbox commands under `### Acceptance criteria` (the
 * Plan section), in order — exactly what the fleet runner executes in
 * the worker's checkout (ADR-0076: validator, not CI). Human prose
 * around them is ignored; a checkbox without a backticked command is
 * not executable and is skipped.
 */
export function acceptanceCommands(text: string): string[] {
  const commands: string[] = [];
  let inCriteria = false;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) {
      inCriteria = false; // any H2 leaves the Plan section behind
      continue;
    }
    if (/^###\s+Acceptance criteria\s*$/.test(line)) {
      inCriteria = true;
      continue;
    }
    if (/^###\s/.test(line)) {
      inCriteria = false; // another H3 ends the criteria
      continue;
    }
    // The command is the first backtick run; trailing prose ("— exits 0") is allowed.
    const match = /^-\s+\[.]\s+`([^`]+)`/.exec(line);
    if (inCriteria && match !== null) {
      commands.push(match[1]!);
    }
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Patching (transitions, claims) — targeted node mutation, house style.

export interface TransitionPatch {
  /** Phase the ticket moves INTO (stamps `entered-<phase>`). */
  readonly to: string;
  /** Phase it leaves — only for the log line; `null` on claims. */
  readonly from: string | null;
  readonly now: Date;
  /** Who acts — the Log line's author (`owner@host`, `agent@host:session`). */
  readonly actor: string;
  /** Log line text; default `${from} -> ${to}` / `claim`. */
  readonly action?: string;
  /** Stamp claim fields with this identity (a claim or takeover). */
  readonly claimBy?: string;
  /** Clear the claim fields instead (a release). */
  readonly releaseClaim?: boolean;
  /**
   * Stamp the live-run map (ADR-0075 run control, M84): `{pid, started-at,
   * stream}` with the stream field naming the run id — the stream file
   * itself lives under the machine-local fleet root, so the ticket file
   * stays portable across the machines the repo syncs to.
   */
  readonly run?: TicketRun;
  /** Remove the live-run map (the run ended). */
  readonly clearRun?: boolean;
  /** Pin (or with `''` clear) the ticket's worker — a fleet run start records the choice. */
  readonly setWorker?: string;
  /** Park the ticket (`parked-reason` + `parked-at`, M85): circuit breaker, budgets. */
  readonly park?: string;
}

/** Applies a transition/claim patch to a ticket file's text and appends the
 *  Log line. Throws only on unparseable frontmatter (the caller refuses). */
export function patchTicketFile(text: string, patch: TransitionPatch): string {
  const { yamlText, body, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    throw new Error('ticket has no frontmatter fence');
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error('ticket frontmatter does not parse');
  }

  const stamp = formatUtcStamp(patch.now);
  const what =
    patch.action ??
    (patch.from === null ? 'claim' : `${patch.from} -> ${patch.to}`);

  // A transition restamps `entered-<to>`; a claim-only patch never does.
  if (patch.from !== null) {
    setQuoted(doc, `entered-${patch.to}`, stamp);
  }

  if (patch.claimBy !== undefined) {
    setQuoted(doc, 'claimed-by', patch.claimBy);
    setQuoted(doc, 'claimed-at', stamp);
  } else if (patch.releaseClaim === true) {
    removeKey(doc, 'claimed-by');
    removeKey(doc, 'claimed-at');
  }

  if (patch.run !== undefined) {
    doc.set('run', doc.createNode({
      pid: patch.run.pid,
      'started-at': patch.run['started-at'],
      stream: patch.run.stream,
    }));
  } else if (patch.clearRun === true) {
    removeKey(doc, 'run');
  }

  if (patch.setWorker !== undefined) {
    if (patch.setWorker === '') {
      removeKey(doc, 'worker');
    } else {
      setQuoted(doc, 'worker', patch.setWorker);
    }
  }

  if (patch.park !== undefined) {
    setQuoted(doc, 'parked-reason', patch.park);
    setQuoted(doc, 'parked-at', stamp);
  }

  // Leaving the inbox always clears a parked state (schema rule).
  if (patch.from === 'inbox') {
    removeKey(doc, 'parked-reason');
    removeKey(doc, 'parked-at');
  }

  return `---\n${yamlOf(doc)}---\n${appendLogLine(body, stamp, patch.actor, what)}`;
}

function appendLogLine(body: string, stamp: string, who: string, what: string): string {
  const line = `- '${stamp}' ${who} — ${what}`;
  const lines = body.split('\n');
  let logAt = -1;
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Log\s*$/.test(lines[i]!)) {
      logAt = i;
    } else if (logAt >= 0 && /^##\s/.test(lines[i]!)) {
      insertAt = i;
      break;
    }
  }
  if (logAt < 0) {
    const head = body.endsWith('\n') || body === '' ? '' : '\n';
    return `${body}${head}\n## Log\n\n${line}\n`;
  }
  if (insertAt < 0) {
    insertAt = lines.length;
    // Insert before trailing empties so the section keeps its blank line end.
    while (insertAt > logAt + 1 && lines[insertAt - 1]!.trim() === '') {
      insertAt--;
    }
  }
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The ticket header's edits (req-62): the editor hands over the frontmatter
// block it shows — both fences, no trailing newline — and puts the result
// back as one buffer change, so save, undo and the conflict merge stay the
// editor's.

/** What the ticket header may change. An empty `repo` / `worker` clears the key. */
export interface HeaderPatch {
  readonly title?: string;
  readonly priority?: TicketPriority;
  readonly repo?: string;
  readonly worker?: string;
}

/** Rewrites the header's keys in a frontmatter block; every other key, comment and style survives. */
export function patchHeaderFields(block: string, patch: HeaderPatch): string {
  const { yamlText, hadFence } = splitFrontmatter(`${block}\n`);
  if (!hadFence || yamlText === null) {
    throw new Error('ticket has no frontmatter fence');
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error('ticket frontmatter does not parse');
  }
  if (patch.title !== undefined) {
    const title = patch.title.replace(/\s+/g, ' ').trim();
    if (title === '') {
      throw new Error('the title is empty');
    }
    // The creation writer's style (double quotes) unless the owner chose
    // single quotes; never plain, so a `:` in the title cannot break the line.
    const existing = doc.get('title', true);
    const style =
      isScalar(existing) && existing.type === Scalar.QUOTE_SINGLE
        ? Scalar.QUOTE_SINGLE
        : Scalar.QUOTE_DOUBLE;
    const scalar = doc.createNode(title) as Scalar;
    scalar.type = style;
    doc.set('title', scalar);
  }
  if (patch.priority !== undefined) {
    if (!TICKET_PRIORITIES.includes(patch.priority)) {
      throw new Error(`unknown priority "${String(patch.priority)}"`);
    }
    doc.set('priority', patch.priority);
  }
  if (patch.repo !== undefined) {
    // `repo:` stays present and empty when cleared — the creation shape.
    const repo = patch.repo.trim();
    if (repo === '') {
      const empty = new Scalar(null);
      empty.source = ''; // `repo:`, not `repo: null`
      doc.set('repo', empty);
    } else {
      doc.set('repo', repo);
    }
  }
  if (patch.worker !== undefined) {
    if (patch.worker.trim() === '') {
      removeKey(doc, 'worker');
    } else {
      setQuoted(doc, 'worker', patch.worker.trim());
    }
  }
  return `---\n${yamlOf(doc)}---`;
}

// ---------------------------------------------------------------------------
// Canonical creation write (the strict writer's shape).

export interface NewTicketInput {
  readonly id: string;
  readonly title: string;
  readonly repo: string | null;
  readonly priority: TicketPriority;
  readonly rank: number;
  readonly firstPhase: string;
  readonly now: Date;
  readonly actor: string;
  readonly description: string;
}

/** The strict canonical ticket file — exactly the shapes of the spec. */
export function newTicketFileText(input: NewTicketInput): string {
  const stamp = formatUtcStamp(input.now);
  const title = yamlQuote(input.title);
  const repo = input.repo ?? '';
  const description = input.description.trim();
  const descBlock = description === '' ? '' : `${description}\n`;
  return [
    '---',
    `id: ${input.id}`,
    `title: ${title}`,
    `repo: ${repo}`,
    `priority: ${input.priority}`,
    `rank: ${input.rank}`,
    `branch: ${branchForTicket(input.id)}`,
    `entered-${input.firstPhase}: '${stamp}'`,
    '---',
    '',
    '## Description',
    '',
    descBlock,
    '## Plan',
    '',
    'To be filled in the plan phase.',
    '',
    '### Acceptance criteria',
    '',
    'Executable checks as backticked checkbox lines; the machine gate runs them.',
    '',
    '## Log',
    '',
    `- '${stamp}' ${input.actor} — created in ${input.firstPhase}`,
    '',
  ].join('\n');
}

// --- yaml helpers -----------------------------------------------------------

function yamlOf(doc: Document): string {
  let out = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  if (!out.endsWith('\n')) {
    out += '\n';
  }
  return out;
}

/** Sets (or adds) a single-quoted scalar key — timestamps, claim ids
 *  (matching the canonical creation write's quote style). */
function setQuoted(doc: Document, key: string, value: string): void {
  const existing = doc.get(key, true);
  if (isScalar(existing)) {
    existing.value = value;
    existing.type = Scalar.QUOTE_SINGLE;
    return;
  }
  const scalar = doc.createNode(value) as Scalar;
  scalar.type = Scalar.QUOTE_SINGLE;
  doc.set(key, scalar);
}

function removeKey(doc: Document, key: string): void {
  if (doc.has(key)) {
    doc.delete(key);
  }
}

/** A YAML double-quoted scalar with `"` and `\` escaped. */
function yamlQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}
