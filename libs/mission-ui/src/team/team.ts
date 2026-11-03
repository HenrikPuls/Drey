import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  InjectionToken,
  signal,
  type Signal,
} from '@angular/core';
import type { PersonaRouterView } from '../api/dto';

/**
 * The wire DTO of `GET /api/personas` — duplicated from the engine's
 * `PersonaView` (packages/tickets-engine/src/contracts/remote-protocol.ts)
 * until `app/api` lands; reconcile the shapes on import, do not guess.
 */
export interface McPersonaView {
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

/** The dollars German-style with two decimals (`1,4 $` reads `1,40 $`). */
function usdOf(value: number): string {
  return `${value.toFixed(2).replace('.', ',')} $`;
}

/** The budget as the prototype writes it — a whole number stays bare (`5 $`), a fraction takes two decimals. */
function budgetWordsOf(value: number): string {
  const dollars = Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',');
  return `${dollars} $`;
}

/**
 * The pcard foot's 'day costs against budget' line (`0,42 $ / 5 $ today`):
 * without a budget just the day's costs (`0,42 $ today`); null when the
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
        : `${usdOf(persona.dailyCost)} / ${budgetWordsOf(budget)} today`,
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
 * The header sub ('4 personas · today 2,41 $'): the count always (once
 * the list is loaded), the day sum only when at least one persona
 * settled a known cost today.
 */
export function headerSubOf(
  personas: readonly Pick<McPersonaView, 'dailyCost'>[] | null,
): string | null {
  if (personas === null) {
    return null;
  }
  const count = personas.length;
  const sum = dailySumOf(personas);
  const noun = count === 1 ? 'persona' : 'personas';
  return sum === null ? `${count} ${noun}` : `${count} ${noun} · today ${usdOf(sum)}`;
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
  styleUrl: './team.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  /** The header sub ('4 personas · today 2,41 $'); null while loading — the slot hides. */
  protected readonly headerSub = computed(() => headerSubOf(this.state.team()));

  /** The master strip's face off the fleet snapshot; unknown reads as the idle face. */
  protected readonly chainStrip = computed(() => chainStripOf(this.state.chainMaster?.() ?? null));

  /** The paused persona ids off the fleet snapshot; absent reads as none. */
  protected readonly pausedPersonas = computed(() => this.state.pausedPersonas?.() ?? []);

  /** True when the bound state can open the 1:1 — the cards become tappable. */
  protected readonly canOpen = computed(() => this.state.openPersona !== undefined);

  /** True when the bound state can open a ticket — the run ghost shows for live runs. */
  protected readonly canOpenTicket = computed(() => this.state.openTicket !== undefined);

  /** True when the bound state can pause a persona — the pause ghost shows. */
  protected readonly canPause = computed(() => this.state.personaPause !== undefined);

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
  protected readonly runStateClass = runStateClass;
  protected readonly dayCostFootOf = dayCostFootOf;
  protected readonly phasesFootOf = phasesFootOf;
}
