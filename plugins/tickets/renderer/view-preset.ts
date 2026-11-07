import type { DreyPluginApi, ViewPresetContrib } from '../../../shared/plugin-api/renderer';

/**
 * The Work view (E13-13, ADR-0089): the tickets plugin's saved layout next
 * to Notes. First cut -- the Tickets panel left, the tabs in the centre
 * (ticket documents, the Board, the Team), the Assistant right, the Capacity
 * band below. The Review, Shape, Parts and Flow tabs arrive with their own
 * milestones; the Assistant's Mission Control target with E13-5 (the preset
 * carries no `assistantTarget` until the Assistant knows one).
 */
export const WORK_VIEW_ID = 'tickets.work';

export const WORK_VIEW_LABEL = 'Work';

/** The dock panel ids the preset arranges (`tickets` and `tickets-capacity` are this plugin's, `assistant` the Assistant plugin's). */
export const WORK_PANELS = {
  left: ['tickets'],
  right: ['assistant'],
  bottom: ['tickets-capacity'],
} as const;

/** Board 7e: the Capacity band's first height. */
export const WORK_CAPACITY_HEIGHT = 103;

/** The Crew view (boards 9a, 7h: Notes · Work · Crew): the tickets panel and the Assistant, the Board's and Crew's tabs are opened from the panel. */
export const CREW_VIEW_ID = 'tickets.crew';

export const CREW_VIEW_LABEL = 'Crew';

/** The Board and Crew tabs (E13-8): doc kind + the one key each has. */
export const BOARD_KIND = 'tickets-board';
export const BOARD_KEY = 'board://all';
export const TEAM_KIND = 'tickets-team';
export const TEAM_KEY = 'team://all';

export function createCrewPreset(): ViewPresetContrib {
  return {
    id: CREW_VIEW_ID,
    label: CREW_VIEW_LABEL,
    layout: {
      left: [...WORK_PANELS.left],
      right: [...WORK_PANELS.right],
      bottom: [],
      folded: ['right'],
      // Board 7h: the Crew view owns its tab -- it comes back on every visit (SDK 1.50).
      openTabs: [{ kind: TEAM_KIND, path: TEAM_KEY }],
    },
  };
}

export function createWorkPreset(): ViewPresetContrib {
  return {
    id: WORK_VIEW_ID,
    label: WORK_VIEW_LABEL,
    layout: {
      left: [...WORK_PANELS.left],
      right: [...WORK_PANELS.right],
      bottom: [...WORK_PANELS.bottom],
      bottomH: WORK_CAPACITY_HEIGHT,
    },
  };
}

/**
 * Registers the preset; the returned function undoes it. Opening a ticket
 * never switches the view (D-6): the document opens in the current view's
 * own layout, so a user's saved views stay theirs. There is no home rule
 * for ticket files and the Work view is reached on purpose (the switcher,
 * Ctrl+N, "Go to the Work view").
 */
export function registerWorkView(api: DreyPluginApi): () => void {
  const work = api.ui.registerViewPreset(createWorkPreset());
  const crew = api.ui.registerViewPreset(createCrewPreset());
  return () => {
    work();
    crew();
  };
}
