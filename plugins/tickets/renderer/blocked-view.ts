/**
 * The blocked-move predicate (T-0050): an owner move of a blocked ticket
 * into an agent phase asks first. The Work panel (req-75 W1) shows a
 * blocked ticket's blockers in its status line; the kanban's badges and
 * hide-blocked filter went with the columns.
 */
import { parseHandover, type TicketCard } from '../shared/tickets';

/** A manual move of a blocked card into an agent column asks first
 *  (the owner is the final authority); every other target never asks. */
export function needsBlockedConfirm(card: TicketCard, targetHandover: string): boolean {
  return card.blocked.length > 0 && parseHandover(targetHandover).mode === 'agent';
}
