/**
 * The team's pure model (E13-8, roadmap "Board, Team and Capacity"): the
 * persona directory (`PersonaView`, the phone's own wire shape), the
 * fleet's runs and the chain fold into the Team tab's cards and the
 * Capacity band — the same figures the Mission Control client shows
 * (E12-4: state words, run rows, stuck copy, budget share, capacity
 * chips). DOM-free, so the tab, the band and the spec share it.
 */
import type { PersonaView } from '../../shared/remote-protocol';
import type { ChainStatus, RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';

/** The run states that count as live (the fleet's own list). */
const LIVE_STATES: readonly string[] = ['starting', 'running', 'stopping', 'detached'];

/** A provider id as the pool chips name it (the mobile client's labels). */
const POOL_LABEL: Readonly<Record<string, string>> = { opencode: 'Local', 'claude-code': 'Claude Code' };

/** The context fill from which a stuck run's line mentions it. */
const CONTEXT_WARN_PCT = 60;

/** Dollars with two decimals, the way the mobile client writes money. */
export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** A persona's role as a label (`builder` -> `Builder`); '' stays ''. */
export function roleLabel(role: string): string {
  return role === '' ? '' : role[0]!.toUpperCase() + role.slice(1);
}

/** Two initials for an avatar (`Claude Code` -> `CC`, `Ben` -> `B`). */
export function initialsOf(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join('');
}

export function isLiveRun(run: RunInfo): boolean {
  return LIVE_STATES.includes(run.state);
}

/** What a persona is doing, in the order the card weighs it. */
export type PersonaState = 'idle' | 'running' | 'waiting' | 'stuck' | 'paused';

/** One live run under a persona card. */
export interface RunRowModel {
  readonly runId: string;
  readonly ticketId: string;
  /** The ticket's title; '' = unknown (the id stands alone). */
  readonly title: string;
  /** Age of the run in words (`4 min`); '' = unknown. */
  readonly age: string;
  /** What the worker is doing now; '' = nothing reported. */
  readonly activity: string;
  readonly stuck: boolean;
  /** The amber line of a flagged run; '' otherwise. */
  readonly stuckLine: string;
  readonly waiting: boolean;
  readonly provider: string;
}

/** One team card. */
export interface PersonaCardModel {
  readonly id: string;
  readonly title: string;
  readonly initials: string;
  readonly color: string;
  readonly role: string;
  /** Pipeline phases the persona serves, in chain order. */
  readonly phases: readonly string[];
  readonly state: PersonaState;
  /** The state as the card writes it (`idle`, `running`, `2 running`, `waiting`, `stuck`, `paused`). */
  readonly stateWord: string;
  /** Today's settled cost; null = none known (never a fake 0). */
  readonly dailyCost: number | null;
  readonly budget: number | null;
  /** The cost line (`$0.42 of $5.00 today`); '' = nothing known. */
  readonly costLine: string;
  /** Today's cost over the budget, 0 - 100; null = no budget or no cost. */
  readonly budgetPct: number | null;
  readonly overBudget: boolean;
  readonly paused: boolean;
  readonly runs: readonly RunRowModel[];
}

/** One provider pool's load. */
export interface CapacityChip {
  readonly provider: string;
  readonly label: string;
  readonly running: number;
  readonly size: number;
}

export interface TeamModel {
  readonly personas: readonly PersonaCardModel[];
  readonly capacity: readonly CapacityChip[];
  /** `1 running · 2 waiting · 1 stuck`, or `All idle`. */
  readonly summary: string;
  /** Today's cost across the personas; null = none known. */
  readonly todayCost: number | null;
  /** The summed daily budgets; null = no persona has one. */
  readonly todayBudget: number | null;
  /** Live runs in total, against the summed pool sizes (`2 of 5 slots busy`). */
  readonly liveRuns: number;
  readonly slots: number;
  /** The chain master halted (Pause all is on). */
  readonly halted: boolean;
}

/** Minutes since an ISO stamp; null = unparseable. */
export function minutesSince(iso: string | undefined, nowMs: number): number | null {
  if (iso === undefined || iso === '') {
    return null;
  }
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((nowMs - at) / 60_000));
}

/** `4 min`, `2 h`; '' when unknown. */
export function ageOf(iso: string | undefined, nowMs: number): string {
  const minutes = minutesSince(iso, nowMs);
  if (minutes === null) {
    return '';
  }
  if (minutes < 1) {
    return 'now';
  }
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** The context fill of a run in whole percent; null = the provider reported none. */
export function contextPctOf(run: RunInfo): number | null {
  const tokens = run.contextTokens;
  const window = run.contextWindow;
  if (typeof tokens !== 'number' || typeof window !== 'number' || window <= 0) {
    return null;
  }
  return Math.min(100, Math.round((tokens / window) * 100));
}

/** The amber line of a flagged run: `No progress for 9 minutes and the context is filling up (78%).` */
export function stuckLineOf(run: RunInfo, nowMs: number): string {
  const minutes = minutesSince(run.lastActivity, nowMs);
  const quiet = minutes === null ? 'No progress' : `No progress for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const pct = contextPctOf(run);
  return pct !== null && pct >= CONTEXT_WARN_PCT ? `${quiet} and the context is filling up (${pct}%).` : `${quiet}.`;
}

function runRowOf(run: RunInfo, titleOf: (ticketId: string) => string | null, nowMs: number): RunRowModel {
  return {
    runId: run.id,
    ticketId: run.ticketId,
    title: titleOf(run.ticketId) ?? '',
    age: ageOf(run.startedAt, nowMs),
    activity: run.activity ?? '',
    stuck: run.stuck === true,
    stuckLine: run.stuck === true ? stuckLineOf(run, nowMs) : '',
    waiting: run.waiting !== undefined,
    provider: run.provider,
  };
}

/** The state word: a count when a builder carries several runs. */
export function stateWordOf(state: PersonaState, running: number): string {
  if (state === 'running' && running > 1) {
    return `${running} running`;
  }
  return state;
}

/** The cost line: `$0.42 of $5.00 today`, `$0.42 today`, '' without a figure. */
export function costLineOf(dailyCost: number | null, budget: number | null): string {
  if (dailyCost === null) {
    return '';
  }
  return budget === null ? `${usd(dailyCost)} today` : `${usd(dailyCost)} of ${usd(budget)} today`;
}

/** The share of the budget spent, clamped to 0 - 100; null without a budget or a cost. */
export function budgetPctOf(dailyCost: number | null, budget: number | null): number | null {
  if (dailyCost === null || budget === null || budget <= 0) {
    return null;
  }
  return Math.min(100, Math.round((dailyCost / budget) * 100));
}

export function personaCardOf(
  persona: PersonaView,
  runs: readonly RunInfo[],
  pausedIds: readonly string[],
  titleOf: (ticketId: string) => string | null,
  nowMs: number,
): PersonaCardModel {
  const live = runs.filter((run) => isLiveRun(run) && run.persona === persona.id);
  const rows = live.map((run) => runRowOf(run, titleOf, nowMs));
  const paused = persona.paused === true || pausedIds.includes(persona.id);
  const state: PersonaState = paused
    ? 'paused'
    : rows.some((row) => row.stuck)
      ? 'stuck'
      : rows.some((row) => row.waiting)
        ? 'waiting'
        : rows.length > 0
          ? 'running'
          : 'idle';
  const dailyCost = typeof persona.dailyCost === 'number' && Number.isFinite(persona.dailyCost) ? persona.dailyCost : null;
  const budget = typeof persona.budget === 'number' && Number.isFinite(persona.budget) ? persona.budget : null;
  return {
    id: persona.id,
    title: persona.title,
    initials: initialsOf(persona.title),
    color: /^#[0-9a-fA-F]{6}$/.test(persona.color) ? persona.color : '#888888',
    role: roleLabel(persona.role),
    phases: persona.phases ?? [],
    state,
    stateWord: stateWordOf(state, rows.length),
    dailyCost,
    budget,
    costLine: costLineOf(dailyCost, budget),
    budgetPct: budgetPctOf(dailyCost, budget),
    overBudget: dailyCost !== null && budget !== null && dailyCost > budget,
    paused,
    runs: rows,
  };
}

/** The pools' load: running against the effective size, only for a pool the chain reports. */
export function capacityOf(chain: ChainStatus | null, runs: readonly RunInfo[]): readonly CapacityChip[] {
  const sizes = chain?.poolSize;
  if (sizes === undefined) {
    return [];
  }
  const chips: CapacityChip[] = [];
  for (const provider of Object.keys(POOL_LABEL)) {
    const size = sizes[provider];
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      continue;
    }
    chips.push({
      provider,
      label: POOL_LABEL[provider]!,
      running: runs.filter((run) => isLiveRun(run) && run.provider === provider).length,
      size,
    });
  }
  return chips;
}

/** `1 running · 2 waiting · 1 stuck`; the idle and paused personas stay out. */
export function summaryOf(cards: readonly PersonaCardModel[]): string {
  const count = (state: PersonaState): number => cards.filter((card) => card.state === state).length;
  const parts = [
    ...(count('running') > 0 ? [`${count('running')} running`] : []),
    ...(count('waiting') > 0 ? [`${count('waiting')} waiting`] : []),
    ...(count('stuck') > 0 ? [`${count('stuck')} stuck`] : []),
  ];
  return parts.length === 0 ? 'All idle' : parts.join(' · ');
}

export function teamModelOf(
  personas: readonly PersonaView[],
  runs: readonly RunInfo[],
  chain: ChainStatus | null,
  titleOf: (ticketId: string) => string | null,
  nowMs: number,
): TeamModel {
  const paused = chain?.pausedPersonas ?? [];
  const cards = personas.map((persona) => personaCardOf(persona, runs, paused, titleOf, nowMs));
  const costs = cards.map((card) => card.dailyCost).filter((cost): cost is number => cost !== null);
  const budgets = cards.map((card) => card.budget).filter((budget): budget is number => budget !== null);
  const capacity = capacityOf(chain, runs);
  return {
    personas: cards,
    capacity,
    summary: summaryOf(cards),
    todayCost: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
    todayBudget: budgets.length === 0 ? null : budgets.reduce((sum, budget) => sum + budget, 0),
    liveRuns: runs.filter(isLiveRun).length,
    slots: capacity.reduce((sum, chip) => sum + chip.size, 0),
    halted: chain?.master === 'halted',
  };
}

/** The Team tab's header: `4 personas · today $1.59`. */
export function teamHeadOf(model: TeamModel): string {
  const count = `${model.personas.length} ${model.personas.length === 1 ? 'persona' : 'personas'}`;
  return model.todayCost === null ? count : `${count} · today ${usd(model.todayCost)}`;
}

/** The capacity band's head: `2 of 5 slots busy`; '' without pool sizes. */
export function slotsLineOf(model: TeamModel): string {
  return model.slots === 0 ? '' : `${model.liveRuns} of ${model.slots} slots busy`;
}

/** What the band says on one persona's row: `idle · 0/1`, `running · 1/2`. */
export function bandLineOf(card: PersonaCardModel): string {
  return card.runs.length === 0 ? card.stateWord : `${card.stateWord} · ${card.runs.length} live`;
}
