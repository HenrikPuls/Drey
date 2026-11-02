/**
 * Mission Control's view models and the tolerant mappers that build them
 * from the gateway's JSON (E5b). The mappers never import the engine
 * packages — the local readonly interfaces below are the contract the
 * components code against, and every mapper forgives missing or mistyped
 * fields with defaults instead of throwing: a partial desk answer must
 * never white-screen the phone.
 */

// --- Work ------------------------------------------------------------------

export type McPriority = 'urgent' | 'high' | 'normal' | 'low';

const PRIORITIES: readonly McPriority[] = ['urgent', 'high', 'normal', 'low'];

/** One ticket as the Work tab's card renders it (concept §7: one ticket = one card). */
export interface TicketCardView {
  readonly id: string;
  readonly title: string;
  /** The pipeline phase the card currently sits in. */
  readonly phase: string;
  readonly priority: McPriority;
  /** The persona pin (`null` = the ladder decides). */
  readonly personaId: string | null;
  readonly claimedBy: string | null;
  /** The open blocker ids (`[]` = unblocked). */
  readonly blocked: readonly string[];
}

/** One board column as a card group. */
export interface GroupView {
  readonly id: string;
  readonly title: string;
  readonly cards: readonly TicketCardView[];
}

export interface WorkView {
  readonly groups: readonly GroupView[];
}

// --- Needs -----------------------------------------------------------------

/** One scout decision as the report card renders it (E8, concept §5.6). */
export interface ScoutDecisionView {
  /** The decision's short key (`D1`, `D2`, …); '' when the desk mangled it. */
  readonly key: string;
  readonly question: string;
  /** The scout's recommendation; null when the decision carries none. */
  readonly recommendation: string | null;
  readonly resolved: boolean;
}

/** The parsed `## Report` riding on a 'report' need — the card's detail body. */
export interface ScoutReportView {
  /** ISO stamp; '' when the desk omitted it. */
  readonly writtenAt: string;
  /** The persona id; '' when unknown. */
  readonly by: string;
  /** The `### Summary` block; '' when absent. */
  readonly summary: string;
  readonly decisions: readonly ScoutDecisionView[];
}

/** One thing that waits on the owner, as the Needs-you list renders it. */
export interface NeedView {
  readonly kind: string;
  readonly ticketId: string | null;
  readonly title: string;
  readonly summary: string;
  /** E8: the parsed scout report; present exactly on a 'report' need. */
  readonly report?: ScoutReportView;
}

// --- Team ------------------------------------------------------------------

/** A persona's live run, folded in from the fleet snapshot. */
export type RunStateView = 'starting' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed' | 'detached';

export interface PersonaRun {
  readonly ticketId: string;
  readonly state: RunStateView;
}

/** One team card: the persona directory slice plus what it is running now. */
export interface PersonaView {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly worker: string;
  readonly model: string;
  /** The persona's model pool (the assignment ring); `[]` when the desk omits it. */
  readonly pool: readonly string[];
  /** `#rrggbb`; the avatar ring's colour. */
  readonly color: string;
  /** The newest live run this persona dispatched, if any. */
  readonly currentRun: PersonaRun | null;
}

export interface TeamView {
  readonly personas: readonly PersonaView[];
}

// --- Persona improvements (E6) ------------------------------------------------

/**
 * One aggregation proposal as the persona detail (the 1:1, concept §4.8)
 * renders it — the unit the owner applies or dismisses.
 */
export interface ImprovementProposalView {
  readonly id: string;
  readonly state: 'open' | 'accepted' | 'dismissed';
  /** The proposal's target — 'prompt.md', 'models.default' or 'memory'. */
  readonly target: string;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly content: string;
  readonly lesson: string | null;
  /** ISO stamp of the proposal; '' when the desk omits it. */
  readonly at: string;
  /** ISO stamp of the decision; null while open. */
  readonly decidedAt: string | null;
}

/**
 * The `GET /api/personas/<id>/improvements` answer as the 1:1 renders it:
 * the persona's directory facts, its proposals and the two counters the
 * header shows.
 */
export interface PersonaImprovementsView {
  /** The persona directory slice; null when the desk omitted it (the header falls back to the id). */
  readonly persona: PersonaView | null;
  readonly proposals: readonly ImprovementProposalView[];
  readonly openCount: number;
  readonly frictionCount: number;
}

// --- Chat ------------------------------------------------------------------

export interface SessionMeta {
  readonly file: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Pending proposal cards — the sessions list bolds it. */
  readonly pending: number;
}

export interface ChatMessageView {
  readonly role: 'owner' | 'mission';
  readonly text: string;
  /** The mission's thinking trace, folded away after completion. */
  readonly thought: string | null;
  /** ISO stamp. */
  readonly at: string;
}

export interface ChatProposalView {
  readonly id: string;
  readonly state: 'pending' | 'confirmed' | 'dismissed';
  readonly summary: string;
  /** ISO stamp of the proposal; '' when the desk omits it. */
  readonly at: string;
  /** ISO stamp of the decision; null while pending. */
  readonly decidedAt: string | null;
  /** The outcome line the execution reported; null while pending. */
  readonly outcome: string | null;
}

export interface ActiveSession {
  readonly file: string;
  readonly title: string;
  readonly createdAt: string;
  readonly messages: readonly ChatMessageView[];
  readonly proposals: readonly ChatProposalView[];
}

export interface ChatStateView {
  readonly sessions: readonly SessionMeta[];
  readonly active: ActiveSession | null;
}

/** The streaming unit the SSE `chat` events carry (mirrors the desk's ChatStreamEvent). */
export type ChatStreamView =
  | { readonly kind: 'thought'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'proposal'; readonly proposal: ChatProposalView }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string };

/** One `/api/events` frame as a typed union (`unknown` for names the app does not use). */
export type McEvent =
  | { readonly kind: 'board' }
  | { readonly kind: 'needs' }
  | { readonly kind: 'fleet' }
  | { readonly kind: 'remote' }
  | { readonly kind: 'chat'; readonly file: string; readonly event: ChatStreamView }
  | { readonly kind: 'unknown'; readonly name: string };

// --- Ticket screen (E5c) -----------------------------------------------------

/** One acceptance criterion's proof line from `### Criteria`. */
export interface VerificationCriterionView {
  /** The backticked command, exactly as written under the Plan. */
  readonly command: string;
  readonly passed: boolean;
  /** The screenshot file from `→ ![](../attachments/<name>)`; null when the run captured none. */
  readonly screenshot: string | null;
  /** The em-dash note ('— no screenshot: …'); null when the line carries none. */
  readonly note: string | null;
}

/**
 * The `## Verification` section as the proof card renders it (concept
 * §5.3): the Tested-on stamp, the criteria checklist with their screenshot
 * proofs, the findings list. Absent section means "not verified yet".
 */
export interface VerificationView {
  readonly testedAt: string;
  readonly tester: string;
  readonly environment: string;
  readonly criteria: readonly VerificationCriterionView[];
  readonly findings: readonly string[];
}

/** One phase of the current board view; the ticket's own phase is the highlighted one. */
export interface TicketPhaseOption {
  readonly id: string;
  readonly title: string;
}

/** The loaded ticket document plus what the screen's chrome renders around it. */
export interface TicketDetail {
  readonly id: string;
  readonly title: string;
  /** The loaded file's revision — the base revision the next save sends. */
  readonly revision: string;
  /** The full markdown, exactly as the desk stores it. */
  readonly text: string;
  readonly verification: VerificationView | null;
  /** The phases of the current board view. */
  readonly phases: readonly TicketPhaseOption[];
  /** The card's phase (the highlighted entry of `phases`). */
  readonly phase: string;
}

/** One file's git patch off `/api/tickets/<id>/diff`. */
export interface TicketDiffFileView {
  readonly status: string;
  readonly path: string;
  readonly patch: string;
}

/** The worktree-vs-base diff the proof card renders as git (concept §5.3). */
export interface TicketDiffView {
  readonly files: readonly TicketDiffFileView[];
  readonly truncated: boolean;
}

// --- the mappers ------------------------------------------------------------

const rec = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const arr = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const strArray = (value: unknown): readonly string[] => arr(value).filter((item): item is string => typeof item === 'string');

const isoNow = (): string => new Date().toISOString();

function priorityOf(value: unknown): McPriority {
  return PRIORITIES.includes(value as McPriority) ? (value as McPriority) : 'normal';
}

function cardOf(raw: unknown, phaseFallback: string): TicketCardView {
  const card = rec(raw) ?? {};
  const meta = rec(card['meta']) ?? {};
  const phase = str(card['phase'], phaseFallback) || phaseFallback;
  return {
    id: str(card['id'], str(meta['id'])),
    title: str(card['title'], str(meta['title'])) || str(card['id'], 'untitled'),
    phase,
    priority: priorityOf(meta['priority']),
    personaId: strOrNull(meta['persona']),
    claimedBy: strOrNull(meta['claimedBy']),
    blocked: strArray(card['blocked']),
  };
}

/** The board JSON (`{columns, checkpoints}`) as card groups; junk yields no groups. */
export function parseWork(json: unknown): WorkView {
  const board = rec(json);
  if (board === null) {
    return { groups: [] };
  }
  const groups: GroupView[] = [];
  for (const raw of arr(board['columns'])) {
    const column = rec(raw);
    const phase = rec(column?.['phase']) ?? {};
    const id = str(phase['id']);
    if (column === null || id === '') {
      continue;
    }
    const cards = arr(column['tickets'])
      .map((ticket) => cardOf(ticket, id))
      .filter((card) => card.id !== '');
    groups.push({
      id,
      title: str(phase['title'], id),
      cards,
    });
  }
  return { groups };
}

/** One decision's JSON; null when nothing renderable survives (no key and no question). */
function scoutDecisionOf(raw: unknown): ScoutDecisionView | null {
  const decision = rec(raw);
  if (decision === null) {
    return null;
  }
  const key = str(decision['key']);
  const question = str(decision['question']);
  if (key === '' && question === '') {
    return null;
  }
  return {
    key,
    question,
    recommendation: strOrNull(decision['recommendation']),
    resolved: decision['resolved'] === true,
  };
}

/**
 * The `report` field of a 'report' need; undefined when the desk sent
 * nothing usable — the card then shows the headline line alone (the
 * asymmetric-tolerance rule: absence reads as "no detail", never a guess).
 */
function scoutReportOf(raw: unknown): ScoutReportView | undefined {
  const report = rec(raw);
  if (report === null) {
    return undefined;
  }
  return {
    writtenAt: str(report['writtenAt']),
    by: str(report['by']),
    summary: str(report['summary']),
    decisions: arr(report['decisions'])
      .map(scoutDecisionOf)
      .filter((decision): decision is ScoutDecisionView => decision !== null),
  };
}

/** The needs JSON (`[{kind, ticketId?, title, summary}]`); junk yields no needs. */
export function parseNeeds(json: unknown): NeedView[] {
  const NEED_KINDS = [
    'question',
    'permission',
    'red-gate',
    'failed',
    'checkpoint',
    'improvements',
    'needs-decision',
    'blocked',
    'report',
  ];
  const needs: NeedView[] = [];
  for (const raw of arr(json)) {
    const item = rec(raw);
    if (item === null) {
      continue;
    }
    const kind = str(item['kind']);
    const report = kind === 'report' ? scoutReportOf(item['report']) : undefined;
    const need: NeedView = {
      kind: NEED_KINDS.includes(kind) ? kind : 'checkpoint',
      ticketId: strOrNull(item['ticketId']),
      title: str(item['title'], str(item['ticketId'], 'untitled')),
      summary: str(item['summary'], str(item['text'])),
      ...(report !== undefined ? { report } : {}),
    };
    needs.push(need);
  }
  return needs;
}

/** Run states that mean "live on the board" (the rest is history). */
const LIVE_RUN_STATES: readonly RunStateView[] = ['starting', 'running', 'stopping', 'detached'];

const runStateOf = (value: unknown): RunStateView | null =>
  LIVE_RUN_STATES.includes(value as RunStateView) ? (value as RunStateView) : null;

/** One persona directory entry, tolerantly mapped; null when the id is missing. */
function personaOf(raw: unknown): PersonaView | null {
  const persona = rec(raw);
  if (persona === null) {
    return null;
  }
  const id = str(persona['id']);
  if (id === '') {
    return null;
  }
  return {
    id,
    title: str(persona['title'], id),
    role: str(persona['role']),
    worker: str(persona['worker']),
    model: str(persona['model']),
    pool: strArray(persona['pool']),
    color: str(persona['color'], '#7aa2f7'),
    // A lone directory entry carries no fleet context; parseTeam folds the run in.
    currentRun: null,
  };
}

/**
 * The personas list with the fleet's live runs folded in: a persona's
 * `currentRun` is the newest run it dispatched that is still live.
 */
export function parseTeam(personasJson: unknown, fleetJson: unknown): TeamView {
  const runs = arr(rec(fleetJson)?.['runs']);
  const personas: PersonaView[] = [];
  for (const raw of arr(personasJson)) {
    const persona = personaOf(raw);
    if (persona === null) {
      continue;
    }
    const liveRun = runs
      .map((run) => rec(run))
      .find((run) => run !== null && str(run['persona']) === persona.id && runStateOf(run['state']) !== null);
    const state = liveRun === null || liveRun === undefined ? null : runStateOf(liveRun['state']);
    personas.push({
      ...persona,
      currentRun: liveRun === null || liveRun === undefined || state === null ? null : { ticketId: str(liveRun['ticketId']), state },
    });
  }
  return { personas };
}

/** The proposal's state; anything the desk got wrong degrades to open, never a guess. */
function improvementStateOf(value: unknown): 'open' | 'accepted' | 'dismissed' {
  return value === 'accepted' || value === 'dismissed' ? value : 'open';
}

function improvementProposalOf(raw: unknown): ImprovementProposalView | null {
  const proposal = rec(raw);
  if (proposal === null) {
    return null;
  }
  const id = str(proposal['id']);
  if (id === '') {
    return null;
  }
  return {
    id,
    state: improvementStateOf(proposal['state']),
    target: str(proposal['target']),
    title: str(proposal['title'], id),
    evidence: strArray(proposal['evidence']),
    content: str(proposal['content']),
    lesson: strOrNull(proposal['lesson']),
    at: str(proposal['at']),
    decidedAt: strOrNull(proposal['decidedAt']),
  };
}

/** A non-negative integer counter; anything else takes the fallback. */
function countOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

/**
 * The improvements answer (`{persona, proposals, openCount, frictionCount}`)
 * as the 1:1 renders it; null when the desk sent nothing usable. A
 * missing `openCount` falls back to counting the open proposals; a
 * missing `frictionCount` reads as 0; proposals without an id are dropped.
 */
export function parseImprovements(json: unknown): PersonaImprovementsView | null {
  const body = rec(json);
  if (body === null) {
    return null;
  }
  const proposals = arr(body['proposals'])
    .map(improvementProposalOf)
    .filter((proposal): proposal is ImprovementProposalView => proposal !== null);
  return {
    persona: personaOf(body['persona']),
    proposals,
    openCount: countOf(body['openCount'], proposals.filter((proposal) => proposal.state === 'open').length),
    frictionCount: countOf(body['frictionCount'], 0),
  };
}

function sessionMetaOf(raw: unknown): SessionMeta | null {
  const session = rec(raw);
  if (session === null) {
    return null;
  }
  const file = str(session['file']);
  if (file === '') {
    return null;
  }
  const pending = typeof session['pending'] === 'number' && Number.isFinite(session['pending']) ? Math.max(0, Math.trunc(session['pending'])) : 0;
  return {
    file,
    title: str(session['title'], file),
    createdAt: str(session['createdAt']),
    updatedAt: str(session['updatedAt']),
    pending,
  };
}

/** The sessions listing; junk yields no sessions. */
export function parseSessions(json: unknown): SessionMeta[] {
  return arr(json)
    .map(sessionMetaOf)
    .filter((session): session is SessionMeta => session !== null);
}

function messageOf(raw: unknown): ChatMessageView | null {
  const message = rec(raw);
  if (message === null) {
    return null;
  }
  return {
    role: message['role'] === 'owner' ? 'owner' : 'mission',
    text: str(message['text']),
    thought: strOrNull(message['thought']),
    at: str(message['at']),
  };
}

function proposalOf(raw: unknown): ChatProposalView | null {
  const proposal = rec(raw);
  if (proposal === null) {
    return null;
  }
  const id = str(proposal['id']);
  const state = str(proposal['state']);
  return {
    id,
    state: state === 'confirmed' || state === 'dismissed' ? state : 'pending',
    summary: str(proposal['summary']),
    at: str(proposal['at']),
    decidedAt: strOrNull(proposal['decidedAt']),
    outcome: strOrNull(proposal['outcome']),
  };
}

/** One proposal's JSON as the card view renders it; null when unusable. */
export function parseProposal(json: unknown): ChatProposalView | null {
  return proposalOf(json);
}

/** One session's JSON; null when the desk sent nothing usable (e.g. the file is gone). */
export function parseActiveSession(json: unknown): ActiveSession | null {
  const session = rec(json);
  if (session === null) {
    return null;
  }
  const file = str(session['file']);
  if (file === '') {
    return null;
  }
  return {
    file,
    title: str(session['title'], file),
    createdAt: str(session['createdAt']),
    messages: arr(session['messages'])
      .map(messageOf)
      .filter((message): message is ChatMessageView => message !== null),
    proposals: arr(session['proposals'])
      .map(proposalOf)
      .filter((proposal): proposal is ChatProposalView => proposal !== null),
  };
}

function parseStreamEvent(raw: unknown): ChatStreamView | null {
  const event = rec(raw);
  if (event === null) {
    return null;
  }
  switch (str(event['kind'])) {
    case 'thought':
      return { kind: 'thought', text: str(event['text']) };
    case 'text':
      return { kind: 'text', text: str(event['text']) };
    case 'proposal': {
      const proposal = proposalOf(event['proposal']);
      return proposal === null ? null : { kind: 'proposal', proposal };
    }
    case 'done':
      return { kind: 'done' };
    case 'error':
      return { kind: 'error', message: str(event['message'], 'the stream failed') };
    default:
      return null;
  }
}

/**
 * One `/api/events` frame as a typed union. `board`/`fleet`/`remote`
 * carry no payload; `chat` carries the `{file, event}` stream payload;
 * anything else (or a broken payload) lands on `unknown` and is ignored.
 */
export function parseChatEvent(name: string, data: string): McEvent {
  switch (name) {
    case 'board':
      return { kind: 'board' };
    case 'needs':
      return { kind: 'needs' };
    case 'fleet':
      return { kind: 'fleet' };
    case 'remote':
      return { kind: 'remote' };
    case 'chat': {
      let payload: unknown = null;
      try {
        payload = JSON.parse(data);
      } catch {
        payload = null;
      }
      const frame = rec(payload);
      const file = str(frame?.['file']);
      const event = parseStreamEvent(frame?.['event']);
      if (frame === null || file === '' || event === null) {
        return { kind: 'unknown', name };
      }
      return { kind: 'chat', file, event };
    }
    default:
      return { kind: 'unknown', name };
  }
}

// --- ticket screen mappers (E5c) ----------------------------------------------

const VERIFICATION_HEADING = '## Verification';

/** [start, end) of the `## Verification` block — end at the next H2 or EOF. */
function verificationBoundsOf(text: string): { start: number; end: number } | null {
  const heading = /^## Verification$/m.exec(text);
  if (heading === null) {
    return null;
  }
  const rest = text.slice(heading.index);
  const next = /^## /gm.exec(rest.slice(VERIFICATION_HEADING.length));
  const end = next === null ? text.length : heading.index + VERIFICATION_HEADING.length + next.index;
  return { start: heading.index, end };
}

/**
 * Reads the ticket's `## Verification` section tolerantly — the same
 * asymmetric-tolerance rule as the engine's `core/verification.ts`: an
 * absent heading means null ("not verified yet"), a partially unreadable
 * section degrades to defaults instead of throwing. The screenshot link
 * is the schema's `→ ![](../attachments/<name>)` proof reference.
 */
export function parseVerification(text: string): VerificationView | null {
  if (typeof text !== 'string') {
    return null;
  }
  const bounds = verificationBoundsOf(text);
  if (bounds === null) {
    return null;
  }
  const section = text.slice(bounds.start, bounds.end);
  const tested = /^Tested on (\S+) by ([^—]+?)(?: — (.+?))?\.?$/m.exec(section);
  const criteria: VerificationCriterionView[] = [];
  const criterionRe = /^- \[([ xX])\] `([^`]+)`(?: → !\[\]\(\.\.\/attachments\/([^)]+)\))?(?: — (.+))?$/gm;
  for (let match = criterionRe.exec(section); match !== null; match = criterionRe.exec(section)) {
    criteria.push({
      command: match[2]!,
      passed: match[1]!.toLowerCase() === 'x',
      screenshot: match[3] ?? null,
      note: match[4] ?? null,
    });
  }
  const findings: string[] = [];
  const findingsAt = section.indexOf('### Findings');
  if (findingsAt >= 0) {
    for (const line of section.slice(findingsAt).split('\n')) {
      const match = /^- (.+)$/.exec(line.trim());
      if (match !== null) {
        findings.push(match[1]!);
      }
    }
  }
  return {
    testedAt: tested?.[1] ?? '',
    tester: tested?.[2]?.trim() ?? '',
    environment: tested?.[3]?.trim() ?? '',
    criteria,
    findings,
  };
}

/**
 * The `GET /api/tickets/<id>` answer (`{ok, card, text, revision}`) as the
 * ticket screen renders it; null when the desk sent no usable card. The
 * Verification section is parsed out of the full markdown; `phases` rides
 * along from the caller's current board view.
 */
export function parseTicketDetail(json: unknown, phases: readonly TicketPhaseOption[]): TicketDetail | null {
  const body = rec(json);
  if (body === null || body['ok'] === false) {
    return null;
  }
  const card = rec(body['card']);
  if (card === null) {
    return null;
  }
  const meta = rec(card['meta']) ?? {};
  const id = str(card['id'], str(meta['id']));
  if (id === '') {
    return null;
  }
  const text = str(body['text']);
  return {
    id,
    title: str(card['title'], str(meta['title'])) || id,
    revision: str(body['revision']),
    text,
    verification: parseVerification(text),
    phases,
    phase: str(card['phase']),
  };
}

/** The `/api/tickets/<id>/diff` answer as the proof card renders it; junk yields an empty diff. */
export function parseTicketDiff(json: unknown): TicketDiffView {
  const body = rec(json) ?? {};
  return {
    files: arr(body['files'])
      .map((raw) => rec(raw))
      .filter((file): file is Record<string, unknown> => file !== null)
      .map((file) => ({ status: str(file['status']), path: str(file['path']), patch: str(file['patch']) }))
      .filter((file) => file.path !== ''),
    truncated: body['truncated'] === true,
  };
}
