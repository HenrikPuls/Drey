/**
 * Ticket / Thread / Review (E13-20): the three faces of one ticket and the
 * one segmented control that switches between them — the global `.seg` +
 * `.icon-btn` styling, identical at the top of the ticket document, the
 * thread tab and the Review tab (only the active button differs).
 */
import { rowStatusOf, workGroups, type WorkRow, type WorkStatus } from './work-groups';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot } from '../shared/tickets';

export type TicketFace = 'ticket' | 'thread' | 'review';

export const TICKET_FACES: readonly { readonly face: TicketFace; readonly label: string }[] = [
  { face: 'ticket', label: 'Ticket' },
  { face: 'thread', label: 'Thread' },
  { face: 'review', label: 'Review' },
];

/** The statuses that mean the runner is active or waiting (on a question, a gate, a permission). */
const RUN_STATUSES: readonly WorkStatus[] = ['running', 'waiting', 'failed'];

/** True while the ticket's run is active or waiting; false before any run and once the run is over. */
export function ticketRunActive(snapshot: BoardSnapshot | null, runs: readonly RunInfo[], id: string): boolean {
  if (snapshot === null) {
    return false;
  }
  const groups = workGroups(snapshot, runs);
  const rows: readonly WorkRow[] = [...groups.needs, ...groups.shaping, ...groups.running];
  const row = rows.find((candidate) => candidate.card.id === id);
  return row !== undefined && RUN_STATUSES.includes(rowStatusOf(row));
}

/** What a selection opens on: the run while it is active or waiting, the ticket document otherwise. */
export function defaultFaceOf(runActive: boolean): 'ticket' | 'thread' {
  return runActive ? 'thread' : 'ticket';
}

/** The segmented control; `onPick` is the whole behaviour, the strip keeps no state. */
export function ticketFaceSwitch(active: TicketFace, onPick: (face: TicketFace) => void): HTMLElement {
  const strip = document.createElement('span');
  strip.className = 'seg tickets-faces';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Ticket faces');
  for (const { face, label } of TICKET_FACES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.textContent = label;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(face === active));
    button.addEventListener('click', () => {
      if (face !== active) {
        onPick(face);
      }
    });
    strip.append(button);
  }
  return strip;
}
