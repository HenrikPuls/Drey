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

/**
 * The team (concept §4.3): one card per persona from `McState.team`,
 * never tickets — avatar, role, worker/model line and the live run chip.
 * Cards are read-only in E5b; the run chip links nowhere yet (E5c opens
 * the ticket screen).
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

  protected readonly initialsOf = initialsOf;
  protected readonly runStateClass = runStateClass;
}
