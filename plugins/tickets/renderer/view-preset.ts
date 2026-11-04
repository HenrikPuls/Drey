import type { DreyPluginApi, HomeViewRuleContrib, ViewPresetContrib } from '../../../shared/plugin-api/renderer';
import { isTicketPath } from './ticket-header';

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

export function createWorkPreset(): ViewPresetContrib {
  return {
    id: WORK_VIEW_ID,
    label: WORK_VIEW_LABEL,
    layout: {
      left: [...WORK_PANELS.left],
      right: [...WORK_PANELS.right],
      bottom: [...WORK_PANELS.bottom],
    },
  };
}

/**
 * Ticket files -- any phase folder of the tickets repository -- open in the
 * Work view from anywhere: the Files panel, a `[[T-0121]]` link in a note
 * (E13-4), the quick switcher. `boardVaultId` is the board's vault, null
 * while no tickets repository is set up (nothing matches then).
 */
export function createTicketHomeRule(boardVaultId: () => string | null): HomeViewRuleContrib {
  return {
    homeView: WORK_VIEW_ID,
    matches: (path, vaultId) => {
      const board = boardVaultId();
      return board !== null && vaultId === board && isTicketPath(path);
    },
  };
}

/** Registers the preset and the ticket home rule; the returned function undoes both. */
export function registerWorkView(api: DreyPluginApi, boardVaultId: () => string | null): () => void {
  const offPreset = api.ui.registerViewPreset(createWorkPreset());
  const offRule = api.documents.registerHomeViewRule(createTicketHomeRule(boardVaultId));
  return () => {
    offPreset();
    offRule();
  };
}
