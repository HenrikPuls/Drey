import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  InjectionToken,
  signal,
  type Signal,
} from '@angular/core';

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
}

/** The fleet run states (packages/tickets-engine/src/fleet/protocol.ts), duplicated locally. */
export type McRunState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'done'
  | 'stopped'
  | 'failed'
  | 'detached';

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
 */
export interface McTeamState {
  readonly team: Signal<readonly McTeamPersona[] | null>;
  /**
   * Opens the persona's 1:1 detail (E6, concept §4.8); absent = the
   * cards stay read-only, as they did before the detail existed.
   */
  openPersona?(id: string): void;
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
 * The pcard foot's 'Tageskosten gegen Budget' line (`0,42 $ / 5 $ heute`):
 * without a budget just the day's costs (`0,42 $ heute`); null when the
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
        ? `${usdOf(persona.dailyCost)} heute`
        : `${usdOf(persona.dailyCost)} / ${budgetWordsOf(budget)} heute`,
    over: budget !== null && persona.dailyCost > budget,
  };
}

/**
 * The team (concept §4.3): one card per persona from `McState.team`,
 * never tickets — avatar, role, worker/model line, the live run chip and
 * the foot's day-cost line against the budget (danger once the day's
 * costs pass it; hidden while the desk carries neither figure). The card
 * tap opens the persona's 1:1 (E6) when the bound state offers
 * `openPersona`; the run chip stays informational.
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

  /** True when the bound state can open the 1:1 — the cards become tappable. */
  protected readonly canOpen = computed(() => this.state.openPersona !== undefined);

  protected open(persona: McTeamPersona): void {
    this.state.openPersona?.(persona.id);
  }

  protected readonly initialsOf = initialsOf;
  protected readonly runStateClass = runStateClass;
  protected readonly dayCostFootOf = dayCostFootOf;
}
