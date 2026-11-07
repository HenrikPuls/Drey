import { NgTemplateOutlet } from '@angular/common';
import { AppBar } from '../app-bar/app-bar';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { PhoneAvatar } from '../phone/avatar';
import { PhoneIcon } from '../phone/icon';
import { padSignal, touchFaceSignal } from '../phone/phone';
import { todayOfPersonas } from '../work/phone-rows';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  InjectionToken,
  signal,
  type Signal,
} from '@angular/core';
import type { CapacityView, LiveRunView, PersonaRouterView } from '../api/dto';

/**
 * The wire DTO of `GET /api/personas` — duplicated from the engine's
 * `PersonaView` (packages/tickets-engine/src/contracts/remote-protocol.ts)
 * until `app/api` lands; reconcile the shapes on import, do not guess.
 */
export interface McPersonaView {
  /** `human` = the owner as a team member (E10-6); absent = an agent. */
  readonly kind?: 'agent' | 'human';
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly worker: string;
  /** The default model (`models.default`). */
  readonly model: string;
  readonly pool: readonly string[];
  /** `#rrggbb`; drives the avatar background. */
  readonly color: string;
  /**
   * The persona's daily budget in dollars (frontmatter `budget:`,
   * concept §4.3); null = none set (or junk on the wire — never a guess).
   */
  readonly budget: number | null;
  /**
   * What the persona's runs settled for TODAY, summed off the ledger;
   * absent when no known cost exists — never a fake 0.
   */
  readonly dailyCost?: number;
  /** The chain phases the persona serves; absent when the desk omits them. */
  readonly phases?: readonly string[];
  /** True while the owner paused the persona; absent when the desk does not report it. */
  readonly paused?: boolean;
  /** The skill files the persona carries; absent when the desk omits them. */
  readonly skills?: readonly string[];
  /** The routing policy inside the pool; absent when the desk omits it. */
  readonly router?: PersonaRouterView;
}

/** The fleet run states (packages/tickets-engine/src/fleet/protocol.ts), duplicated locally. */
export type McRunState =
  'starting' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed' | 'detached';

/** The one live run a persona drives, matched from `GET /api/fleet` by persona id. */
export interface McPersonaRun {
  readonly ticketId: string;
  readonly state: McRunState;
}

/** One team card: the persona wire view plus its live run (null while idle). */
export interface McTeamPersona extends McPersonaView {
  readonly currentRun: McPersonaRun | null;
  /** Every live run the persona carries (E12-4); absent = none known. */
  readonly liveRuns?: readonly LiveRunView[];
}

/**
 * The slice of the app-wide state the team view renders — this is
 * `McState.team` once `app/api` lands. Null until the first fetch settles.
 * Every member past `team` is tolerant: an adapter that lacks it keeps the
 * view whole (the strip renders its idle face, the ghosts hide, taps stay
 * silent).
 */
export interface McTeamState {
  readonly team: Signal<readonly McTeamPersona[] | null>;
  /**
   * The chain master switch off the fleet snapshot: `run` dispatches,
   * `halted` lets running work finish, null = unknown. Absent = the strip
   * renders its idle face and the toggle stays silent.
   */
  readonly chainMaster?: Signal<'run' | 'halted' | null>;
  /** The persona ids the owner paused in the chain; absent = none known. */
  readonly pausedPersonas?: Signal<readonly string[]>;
  /**
   * Opens the persona's 1:1 detail (E6, concept §4.8); absent = the
   * cards stay read-only, as they did before the detail existed.
   */
  openPersona?(id: string): void;
  /** The persona whose 1:1 is open right now (the iPad marks its card); absent or null = none. */
  readonly openPersonaId?: Signal<string | null>;
  /** Opens the ticket screen (E5c) for the card's live run; absent = the ghost hides. */
  openTicket?(ticketId: string): void;
  /**
   * The master strip's toggle: POST `/api/chain/master` with the new
   * mode, then the desk's fresh fleet snapshot and the toast; absent =
   * the toggle renders but stays silent.
   */
  toggleChainMaster?(paused: boolean): void | Promise<unknown>;
  /**
   * A card's pause/resume: POST `/api/chain/persona-pause`, then the
   * fresh snapshot and the toast; absent = the ghost hides.
   */
  personaPause?(id: string, paused: boolean): void | Promise<unknown>;
  /** Per provider pool: running against effective size (the capacity chips); absent = none. */
  readonly capacity?: Signal<readonly CapacityView[]>;
  /** The title of a ticket for the run rows; absent or null = the id stands alone. */
  ticketTitleOf?(ticketId: string): string | null;
  /** A stuck run's Nudge: steers the worker with a short prompt to change course. */
  nudgeRun?(runId: string): void | Promise<unknown>;
  /** A stuck run's Hand to Claude Code: stop it and start the ticket on Claude Code. */
  handToClaude?(runId: string): void | Promise<unknown>;
  /** A run's Stop. */
  stopRun?(runId: string): void | Promise<unknown>;
  /** "Stop all": aborts every live run and halts the chain. */
  stopAll?(): void | Promise<unknown>;
  /** A transient status note (the prototype's toast pill); absent = silent. */
  toast?(message: string, kind?: 'ok' | 'warn' | 'error'): void;
}

/**
 * The team view's state source. The api module provides the real one app
 * wide; the factory default renders the still-loading state so the shell
 * works before wiring lands.
 */
export const MC_TEAM_STATE = new InjectionToken<McTeamState>('mc-team-state', {
  factory: () => ({ team: signal<readonly McTeamPersona[] | null>(null) }),
});

/** Avatar initials: the first letters of the first two words ('Claude Code' → 'CC'). */
export function initialsOf(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join('');
}

/**
 * The run chip's colour class: a live run (starting/running) takes the
 * accent, a failed run the danger colour, every other state is dim —
 * the run is waiting, not working.
 */
export function runStateClass(state: McRunState): 'run-live' | 'run-failed' | 'run-dim' {
  if (state === 'starting' || state === 'running') return 'run-live';
  if (state === 'failed') return 'run-failed';
  return 'run-dim';
}

/** The pcard foot's day-cost line: the text and whether the budget is blown. */
export interface PersonaDayCost {
  readonly text: string;
  /** True when today's costs passed the daily budget — the line wears the danger colour. */
  readonly over: boolean;
}

/** Dollars with two decimals (`$1.40`). */
export function usdOf(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The pcard foot's 'day costs against budget' line (`$0.42 / $5.00 today`):
 * without a budget just the day's costs (`$0.42 today`); null when the
 * desk carries neither figure — the slot drops out, never a 0-fake. The
 * `over` flag fires only against a budget that exists.
 */
export function dayCostFootOf(
  persona: Pick<McPersonaView, 'budget' | 'dailyCost'>,
): PersonaDayCost | null {
  if (typeof persona.dailyCost !== 'number' || !Number.isFinite(persona.dailyCost)) {
    return null;
  }
  const budget =
    typeof persona.budget === 'number' && Number.isFinite(persona.budget) ? persona.budget : null;
  return {
    text:
      budget === null
        ? `${usdOf(persona.dailyCost)} today`
        : `${usdOf(persona.dailyCost)} of ${usdOf(budget)} today`,
    over: budget !== null && persona.dailyCost > budget,
  };
}

// --- the chain strip and the header sub (prototype convergence) -----------------

/** The master strip's render slice: the label, the mono word, the switch face. */
export interface ChainStripVm {
  /** The strip's label: 'Chain running', 'Chain halted' — bare 'Chain' while unknown. */
  readonly label: string;
  /** The mono status word (`master: run` / `master: off`); null while unknown — the slot hides. */
  readonly mono: string | null;
  /** The switch face and its LED: true = running (the green face), false = halted or unknown. */
  readonly on: boolean;
  /** aria-checked for the switch role; false while unknown. */
  readonly checked: boolean;
}

/**
 * The master strip's face off the fleet snapshot's chain master (tolerant:
 * unknown renders the idle LED, the bare 'Chain' label and no mono word —
 * never a guessed position).
 */
export function chainStripOf(master: 'run' | 'halted' | null | undefined): ChainStripVm {
  if (master === 'run') {
    return { label: 'Chain running', mono: 'master: run', on: true, checked: true };
  }
  if (master === 'halted') {
    return { label: 'Chain halted', mono: 'master: off', on: false, checked: false };
  }
  return { label: 'Chain', mono: null, on: false, checked: false };
}

/**
 * Whether the owner paused the persona: the persona's own `paused` flag
 * wins when the desk sent one; otherwise the fleet's `pausedPersonas`
 * list decides (tolerant: a missing list reads as none).
 */
export function isPersonaPaused(
  persona: Pick<McPersonaView, 'id' | 'paused'>,
  pausedPersonas: readonly string[] | null | undefined,
): boolean {
  if (persona.paused === true) {
    return true;
  }
  if (persona.paused === false) {
    return false;
  }
  return (pausedPersonas ?? []).includes(persona.id);
}

/** The foot's phases words ('Plan · Shape'); null when the desk sent none — the slot hides. */
export function phasesFootOf(persona: Pick<McPersonaView, 'phases'>): string | null {
  const phases = (persona.phases ?? []).filter((phase) => phase.trim() !== '');
  return phases.length > 0 ? phases.join(' · ') : null;
}

/**
 * The header sub's day sum off every persona's `dailyCost` (the same
 * ledger figure the cards show); null when no persona carries one —
 * the 'today …' part drops out, never a fake 0.
 */
export function dailySumOf(personas: readonly Pick<McPersonaView, 'dailyCost'>[]): number | null {
  let sum = 0;
  let known = false;
  for (const persona of personas) {
    if (typeof persona.dailyCost === 'number' && Number.isFinite(persona.dailyCost)) {
      sum += persona.dailyCost;
      known = true;
    }
  }
  return known ? sum : null;
}

/**
 * The header sub ('4 personas · today $2.41'): the count always (once
 * the list is loaded), the day sum only when at least one persona
 * settled a known cost today.
 */
export function headerSubOf(
  personas: readonly Pick<McPersonaView, 'dailyCost'>[] | null,
): string | null {
  if (personas === null) {
    return null;
  }
  // The human persona is the owner, not a worker: it does not count (E10-6).
  const count = personas.filter((p) => (p as { kind?: string }).kind !== 'human').length;
  const sum = dailySumOf(personas);
  const noun = count === 1 ? 'persona' : 'personas';
  return sum === null ? `${count} ${noun}` : `${count} ${noun} · today ${usdOf(sum)}`;
}

/** The default steer a Nudge sends to a stuck worker. */
export const NUDGE_TEXT =
  'You seem stuck. Say in one line what you have tried, then take a different approach.';

/** A run is "stuck" for the card once the watchdog flagged it. */
export interface RunRowVm {
  readonly runId: string;
  readonly ticketId: string;
  readonly title: string;
  readonly age: string;
  readonly line: string;
  readonly stuck: boolean;
  /** The warning under a stuck row; '' otherwise. */
  readonly stuckText: string;
  /** What the worker does, without the `looks stuck` lead (the phone's mono line). */
  readonly activity: string;
  /** Whole minutes without output; null while unknown. */
  readonly silentMinutes: number | null;
  /** The context fill when it is worth saying; null otherwise. */
  readonly contextPct: number | null;
}

/** Minutes between two instants, whole and non-negative. */
function minutesBetween(fromIso: string, nowMs: number): number | null {
  const at = Date.parse(fromIso);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((nowMs - at) / 60_000));
}

/** `12 min`, `1 h 05 min`; '' while the start is unknown. */
export function ageWordsOf(startedAt: string, nowMs: number): string {
  const min = minutesBetween(startedAt, nowMs);
  if (min === null) {
    return '';
  }
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** How many live runs the watchdog flagged, over the whole crew (the phone menu's Crew row). */
export function stuckCountOf(personas: readonly Pick<McTeamPersona, 'liveRuns'>[] | null): number {
  return (personas ?? []).reduce((sum, persona) => sum + (persona.liveRuns ?? []).filter((run) => run.stuck).length, 0);
}

/** The context fill from which the stuck warning mentions it. */
const CONTEXT_WARN_PCT = 60;

/**
 * The run row of a persona's card: title (or the id), age, the worker's
 * activity line (`looks stuck` leads the line of a flagged run) and the
 * stuck warning — minutes of silence, plus the context fill when it is
 * getting full.
 */
export function runRowOf(run: LiveRunView, title: string | null, nowMs: number): RunRowVm {
  const silent = minutesBetween(run.lastActivity, nowMs);
  const activity = run.activity ?? run.state;
  let stuckText = '';
  if (run.stuck) {
    const minutes = silent === null ? '' : ` for ${silent} minute${silent === 1 ? '' : 's'}`;
    const context =
      run.contextPct !== null && run.contextPct >= CONTEXT_WARN_PCT
        ? ` and the context is filling up (${run.contextPct}%)`
        : '';
    stuckText = `No progress${minutes}${context}.`;
  }
  return {
    runId: run.runId,
    ticketId: run.ticketId,
    title: title ?? run.ticketId,
    age: ageWordsOf(run.startedAt, nowMs),
    line: run.stuck ? `looks stuck · ${activity}` : activity,
    stuck: run.stuck,
    stuckText,
    activity,
    silentMinutes: silent,
    contextPct: run.contextPct !== null && run.contextPct >= CONTEXT_WARN_PCT ? run.contextPct : null,
  };
}

/** The card's state words: `2 running`, `paused`, `idle`. */
export function stateWordsOf(liveRuns: number, paused: boolean): string {
  if (paused) {
    return 'paused';
  }
  return liveRuns === 0 ? 'idle' : liveRuns === 1 ? 'running' : `${liveRuns} running`;
}

/** The share of the day's budget spent, 0 – 100 (capped); null without both figures. */
export function budgetPctOf(persona: Pick<McPersonaView, 'budget' | 'dailyCost'>): number | null {
  if (typeof persona.budget !== 'number' || persona.budget <= 0 || typeof persona.dailyCost !== 'number') {
    return null;
  }
  return Math.min(100, Math.round((persona.dailyCost / persona.budget) * 100));
}

/**
 * The team (concept §4.3): the header with the persona count and the
 * day's summed costs, the chain master strip above the cards, one pcard
 * per persona from `McState.team`, never tickets — avatar, role,
 * worker/model line, the live run chip, the foot's phases and day-cost
 * line against the budget (danger once the day's costs pass it; hidden
 * while the desk carries neither figure), then the card actions: the
 * ghost to the run's ticket (only when a run is live) and pause/resume.
 * The card tap opens the persona's 1:1 (E6) when the bound state offers
 * `openPersona`; the strip and the run chip stay informational — the
 * strip's switch toggles the chain master through the bound state.
 */
@Component({
  selector: 'mc-team',
  templateUrl: './team.html',
  styleUrls: ['../phone/kit.css', './team.css', './pad.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, AppBar, McI18nPipe, PhoneAvatar, PhoneIcon],
})
export class Team {
  private readonly state = inject(MC_TEAM_STATE);

  /** Null while the first fetch is still in flight. */
  protected readonly personas = computed(() => this.state.team());

  /** The personas exist but the pool is empty — the settings hint shows. */
  protected readonly poolEmpty = computed(() => {
    const team = this.state.team();
    return team !== null && team.length === 0;
  });

  /** The header sub ('4 personas · today $2.41'); null while loading — the slot hides. */
  protected readonly headerSub = computed(() => headerSubOf(this.state.team()));

  /** The master strip's face off the fleet snapshot; unknown reads as the idle face. */
  protected readonly chainStrip = computed(() => chainStripOf(this.state.chainMaster?.() ?? null));

  /** The paused persona ids off the fleet snapshot; absent reads as none. */
  protected readonly pausedPersonas = computed(() => this.state.pausedPersonas?.() ?? []);

  /** True when the bound state can open the 1:1 — the cards become tappable. */
  protected readonly canOpen = computed(() => this.state.openPersona !== undefined);

  /** True when the bound state can open a ticket — the run ghost shows for live runs. */
  protected readonly canOpenTicket = computed(() => this.state.openTicket !== undefined);

  // --- the phone's Crew (board 10i) ---------------------------------------------

  protected readonly phone = touchFaceSignal();
  protected readonly pad = padSignal();

  /** The persona whose 1:1 is open in the right part (the iPad's selected card). */
  protected readonly selectedId = computed(() => this.state.openPersonaId?.() ?? null);

  /** The iPad bar's summary: personas, running, stuck and what today cost against the budget. */
  protected readonly padSummary = computed(() => {
    const parts = [this.summaryLine()];
    const today = todayOfPersonas((this.personas() ?? []) as readonly { dailyCost?: number; budget?: number | null }[]);
    if (today !== null && today.cost !== null) {
      const cost = `$${today.cost.toFixed(2)}`;
      parts.push(
        today.budget === null
          ? this.teamI18n.t('crew.pad.today_only', { cost })
          : this.teamI18n.t('crew.pad.today_of', { cost, budget: Number.isInteger(today.budget) ? `$${today.budget}` : `$${today.budget.toFixed(2)}` }),
      );
    }
    return parts.join(' · ');
  });

  /** A stuck run's warning as the iPad board words it. */
  protected padStuckWords(row: RunRowVm): string {
    const n = row.silentMinutes ?? 0;
    return row.contextPct === null
      ? this.teamI18n.t('crew.phone.stuck_text', { n })
      : this.teamI18n.t('crew.pad.stuck_context', { n, pct: row.contextPct });
  }

  /** The card tap on the iPad: the persona's 1:1 opens in the right part. */
  protected pick(persona: McTeamPersona): void {
    this.state.openPersona?.(persona.id);
  }
  private readonly teamI18n = inject(McI18n);
  /** The stuck run whose Stop was pressed: the question under its tiles. */
  protected readonly stopAsk = signal<string | null>(null);
  private readonly setupId = signal<string | null>(null);

  /** The persona the Setup block below the cards shows: the tapped one, else the first with work. */
  protected readonly setupOf = computed<McTeamPersona | null>(() => {
    const list = (this.personas() ?? []).filter((persona) => persona.kind !== 'human');
    const picked = this.setupId();
    return (
      list.find((persona) => persona.id === picked) ??
      list.find((persona) => (persona.phases ?? []).includes('build') && (persona.liveRuns?.length ?? 0) > 0) ??
      list.find((persona) => (persona.liveRuns?.length ?? 0) > 0) ??
      list[0] ??
      null
    );
  });

  protected selectSetup(persona: McTeamPersona): void {
    this.setupId.set(persona.id);
  }

  protected readonly summaryLine = computed(() => {
    const list = this.personas() ?? [];
    const runs = list.flatMap((persona) => persona.liveRuns ?? []);
    const t = this.teamI18n;
    return [
      t.t('crew.phone.n_personas', { n: list.length }),
      t.t('crew.phone.n_running', { n: runs.filter((run) => !run.stuck).length }),
      t.t('crew.phone.n_stuck', { n: runs.filter((run) => run.stuck).length }),
    ].join(' · ');
  });

  protected readonly todayLine = computed<string | null>(() => {
    const today = todayOfPersonas((this.personas() ?? []) as readonly { dailyCost?: number; budget?: number | null }[]);
    if (today === null || today.cost === null) {
      return null;
    }
    const cost = `$${today.cost.toFixed(2)}`;
    return today.budget === null
      ? this.teamI18n.t('crew.phone.today_only', { cost })
      : this.teamI18n.t('crew.phone.today_of', { cost, budget: Number.isInteger(today.budget) ? `$${today.budget}` : `$${today.budget.toFixed(2)}` });
  });

  /** A local pool names the model it serves (`Local · qwen3-coder`); a hosted pool its name alone. */
  protected capLabel(cap: { readonly provider: string; readonly label: string }): string {
    if (cap.provider !== 'opencode') {
      return cap.label;
    }
    const model = (this.personas() ?? []).find((persona) => persona.pool[0] === cap.provider)?.model ?? '';
    return model === '' ? cap.label : `${cap.label} · ${model}`;
  }

  /** A stuck run's warning as the board words it. */
  protected stuckWords(row: RunRowVm): string {
    const n = row.silentMinutes ?? 0;
    return row.contextPct === null
      ? this.teamI18n.t('crew.phone.stuck_text', { n })
      : this.teamI18n.t('crew.phone.stuck_text_context', { n, pct: row.contextPct });
  }

  protected roleLineOf(persona: McTeamPersona): string {
    const phases = (persona.phases ?? []).join(', ');
    return [persona.role, phases].filter((bit) => bit !== '').join(' · ');
  }

  /** The card's state: running, waiting, stuck, paused. */
  protected phoneStateOf(persona: McTeamPersona): string {
    return (persona.liveRuns ?? []).some((run) => run.stuck) ? this.teamI18n.t('crew.phone.stuck') : this.stateWords(persona);
  }

  protected stateToneOf(persona: McTeamPersona): string {
    if ((persona.liveRuns ?? []).some((run) => run.stuck)) {
      return 'attention';
    }
    return (persona.liveRuns?.length ?? 0) > 0 ? 'running' : 'idle';
  }

  /** The Setup block's model pool in order; the first entry carries the persona's model. */
  protected poolOf(persona: McTeamPersona): readonly { readonly key: string; readonly label: string; readonly model: string }[] {
    const pool = persona.pool.length > 0 ? persona.pool : persona.worker === '' ? [] : [persona.worker];
    const capacity = this.capacity();
    return pool.map((provider, index) => ({
      key: `${index}:${provider}`,
      label: capacity.find((cap) => cap.provider === provider)?.label ?? provider,
      model: index === 0 ? persona.model : '',
    }));
  }

  protected readonly canPauseAll = computed(() => this.state.toggleChainMaster !== undefined);
  protected readonly canNudge = computed(() => this.state.nudgeRun !== undefined);
  protected readonly canHand = computed(() => this.state.handToClaude !== undefined);
  protected readonly canStopRun = computed(() => this.state.stopRun !== undefined);

  /** True when the bound state can pause a persona — the pause ghost shows. */
  protected readonly canPause = computed(() => this.state.personaPause !== undefined);

  /** The capacity chips (`Local 2/2`); absent or empty hides the row. */
  protected readonly capacity = computed(() => this.state.capacity?.() ?? []);

  /** The master is halted: the pause button offers to resume instead. */
  protected readonly halted = computed(() => this.state.chainMaster?.() === 'halted');

  /** The first press of Stop all arms it; the second aborts. */
  protected readonly stopAllArmed = signal(false);

  /** The run whose action is in flight — its buttons stand still. */
  protected readonly busyRun = signal<string | null>(null);

  protected pauseAll(): void {
    void this.state.toggleChainMaster?.(!this.halted());
  }

  protected stopAll(): void {
    if (!this.stopAllArmed()) {
      this.stopAllArmed.set(true);
      return;
    }
    this.stopAllArmed.set(false);
    void this.state.stopAll?.();
  }

  protected rowsOf(persona: McTeamPersona): readonly RunRowVm[] {
    const now = Date.now();
    return (persona.liveRuns ?? []).map((run) =>
      runRowOf(run, this.state.ticketTitleOf?.(run.ticketId) ?? null, now),
    );
  }

  protected liveCountOf(persona: McTeamPersona): number {
    return persona.liveRuns?.length ?? (persona.currentRun === null ? 0 : 1);
  }

  protected stateWords(persona: McTeamPersona): string {
    if (persona.kind === 'human') {
      return 'Manual steps';
    }
    return stateWordsOf(this.liveCountOf(persona), this.isPaused(persona));
  }

  protected dotClass(persona: McTeamPersona): string {
    if (persona.kind === 'human') {
      return 'run-dim';
    }
    if (this.isPaused(persona)) {
      return 'run-dim';
    }
    return persona.currentRun === null ? 'run-dim' : runStateClass(persona.currentRun.state);
  }

  protected openRow(row: RunRowVm): void {
    this.state.openTicket?.(row.ticketId);
  }

  protected async act(runId: string, action: 'nudgeRun' | 'handToClaude' | 'stopRun'): Promise<void> {
    if (this.busyRun() !== null) {
      return;
    }
    this.busyRun.set(runId);
    try {
      await this.state[action]?.(runId);
    } finally {
      this.busyRun.set(null);
    }
  }

  protected open(persona: McTeamPersona): void {
    this.state.openPersona?.(persona.id);
  }

  protected openRunTicket(persona: McTeamPersona): void {
    const run = persona.currentRun;
    if (run !== null) {
      this.state.openTicket?.(run.ticketId);
    }
  }

  protected isPaused(persona: McTeamPersona): boolean {
    return isPersonaPaused(persona, this.pausedPersonas());
  }

  protected toggleMaster(): void {
    void this.state.toggleChainMaster?.(this.chainStrip().checked);
  }

  protected togglePause(persona: McTeamPersona): void {
    void this.state.personaPause?.(persona.id, !this.isPaused(persona));
  }

  protected readonly initialsOf = initialsOf;
  protected readonly budgetPctOfPersona = budgetPctOf;
  protected readonly runStateClass = runStateClass;
  protected readonly dayCostFootOf = dayCostFootOf;
  protected readonly phasesFootOf = phasesFootOf;
  protected readonly budgetPctOf = budgetPctOf;
  protected readonly usdOf = usdOf;
}
