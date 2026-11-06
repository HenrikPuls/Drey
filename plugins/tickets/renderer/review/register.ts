/**
 * The Review tab's doc kind (E13-7): one tab per ticket, keyed
 * `review://<ticket id>`, titled `Review · T-0121`. The session snapshot
 * stores the ticket id; the proof and the diff are read again on restore.
 */
import type { DreyPluginApi, Unsubscribe } from '../../../../shared/plugin-api/renderer';
import type { TicketCard } from '../../shared/tickets';
import { mountReview, type ReviewDeps } from './view';

export const REVIEW_KIND = 'tickets-review';
const REVIEW_SCHEME = 'review://';

export const reviewKeyOf = (ticketId: string): string => `${REVIEW_SCHEME}${ticketId}`;
export const reviewTitleOf = (ticketId: string): string => `Review · ${ticketId}`;

/** The ticket id a review key names; null for any other key. */
export function ticketIdOfKey(key: string): string | null {
  const id = key.startsWith(REVIEW_SCHEME) ? key.slice(REVIEW_SCHEME.length) : '';
  return /^T-\d{4,}$/.test(id) ? id : null;
}

/** Opens (or reveals) the ticket's Review tab. */
export function openReviewTab(api: DreyPluginApi, card: TicketCard): void {
  api.documents.addDoc(REVIEW_KIND, reviewKeyOf(card.id), reviewTitleOf(card.id));
}

export function registerReviewKind(
  api: DreyPluginApi,
  deps: ReviewDeps,
  /** The Ticket | Thread | Review control on top of the tab (E13-20). */
  faces?: (ticketId: string) => HTMLElement,
): Unsubscribe {
  return api.ui.registerDocKind({
    kind: REVIEW_KIND,
    icon: 'git-merge',
    serialize: (path) => {
      const ticketId = ticketIdOfKey(path);
      return ticketId === null ? null : { ticketId };
    },
    restore: (path) => {
      const ticketId = ticketIdOfKey(path);
      if (ticketId !== null) {
        api.documents.addDoc(REVIEW_KIND, path, reviewTitleOf(ticketId));
      }
    },
    mount: (host, path) => {
      const ticketId = ticketIdOfKey(path);
      if (ticketId === null) {
        host.textContent = 'This tab shows no ticket.';
        return () => undefined;
      }
      const body = document.createElement('div');
      body.className = 'tickets-review-body';
      host.classList.add('tickets-faces-host');
      host.replaceChildren(...(faces === undefined ? [] : [faces(ticketId)]), body);
      return mountReview(deps, body, ticketId);
    },
    statusText: (path) => {
      const ticketId = ticketIdOfKey(path);
      return ticketId === null ? null : ticketId;
    },
  });
}
