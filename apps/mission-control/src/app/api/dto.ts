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

/** One thing that waits on the owner, as the Needs-you list renders it. */
export interface NeedView {
  readonly kind: string;
  readonly ticketId: string | null;
  readonly title: string;
  readonly summary: string;
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

/** The needs JSON (`[{kind, ticketId?, title, summary}]`); junk yields no needs. */
export function parseNeeds(json: unknown): NeedView[] {
  const NEED_KINDS = ['question', 'permission', 'red-gate', 'failed', 'checkpoint'];
  const needs: NeedView[] = [];
  for (const raw of arr(json)) {
    const item = rec(raw);
    if (item === null) {
      continue;
    }
    const kind = str(item['kind']);
    needs.push({
      kind: NEED_KINDS.includes(kind) ? kind : 'checkpoint',
      ticketId: strOrNull(item['ticketId']),
      title: str(item['title'], str(item['ticketId'], 'untitled')),
      summary: str(item['summary'], str(item['text'])),
    });
  }
  return needs;
}

/** Run states that mean "live on the board" (the rest is history). */
const LIVE_RUN_STATES: readonly RunStateView[] = ['starting', 'running', 'stopping', 'detached'];

const runStateOf = (value: unknown): RunStateView | null =>
  LIVE_RUN_STATES.includes(value as RunStateView) ? (value as RunStateView) : null;

/**
 * The personas list with the fleet's live runs folded in: a persona's
 * `currentRun` is the newest run it dispatched that is still live.
 */
export function parseTeam(personasJson: unknown, fleetJson: unknown): TeamView {
  const runs = arr(rec(fleetJson)?.['runs']);
  const personas: PersonaView[] = [];
  for (const raw of arr(personasJson)) {
    const persona = rec(raw);
    if (persona === null) {
      continue;
    }
    const id = str(persona['id']);
    if (id === '') {
      continue;
    }
    const liveRun = runs
      .map((run) => rec(run))
      .find((run) => run !== null && str(run['persona']) === id && runStateOf(run['state']) !== null);
    const state = liveRun === null || liveRun === undefined ? null : runStateOf(liveRun['state']);
    personas.push({
      id,
      title: str(persona['title'], id),
      role: str(persona['role']),
      worker: str(persona['worker']),
      model: str(persona['model']),
      pool: strArray(persona['pool']),
      color: str(persona['color'], '#7aa2f7'),
      currentRun: liveRun === null || liveRun === undefined || state === null ? null : { ticketId: str(liveRun['ticketId']), state },
    });
  }
  return { personas };
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
