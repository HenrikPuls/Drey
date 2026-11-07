/**
 * What the Review tab tells the Mission Control decision card (board 7d, row 4.8):
 * the line comments are the tab's, "Send back with 2 comments" is an option of the
 * card. Two document events, the same way the card already takes the focus
 * (`GO_TO_DECISION_CARD`), so neither side imports the other.
 */

/** Fired whenever a ticket's comment count changes; `detail` is {@link ReviewCommentsDetail}. */
export const REVIEW_COMMENTS = 'drey:tickets-review-comments';

export interface ReviewCommentsDetail {
  readonly id: string;
  readonly count: number;
}

/** Asks the open Review tab of `detail.id` to send the ticket back with its comments. */
export const REVIEW_SEND_BACK = 'drey:tickets-review-send-back';

export interface ReviewSendBackDetail {
  readonly id: string;
  /** The tab that took it sets it; still false after dispatch = no Review tab of that ticket is open. */
  handled: boolean;
}

export function announceReviewComments(id: string, count: number): void {
  document.dispatchEvent(new CustomEvent<ReviewCommentsDetail>(REVIEW_COMMENTS, { detail: { id, count } }));
}

/** For the card's option: true when an open tab took the send-back. */
export function requestReviewSendBack(id: string): boolean {
  const detail: ReviewSendBackDetail = { id, handled: false };
  document.dispatchEvent(new CustomEvent<ReviewSendBackDetail>(REVIEW_SEND_BACK, { detail }));
  return detail.handled;
}

/** Asks the open Review tab of `detail.id` to accept the ticket (the card's second option, board 7d). */
export const REVIEW_ACCEPT = 'drey:tickets-review-accept';

export interface ReviewAcceptDetail {
  readonly id: string;
  /** The tab that took it sets it; still false after dispatch = no Review tab of that ticket is open. */
  handled: boolean;
}

/** For the card's Accept: true when an open tab took it. The tab runs the Ready card's own `acceptTicket`. */
export function requestReviewAccept(id: string): boolean {
  const detail: ReviewAcceptDetail = { id, handled: false };
  document.dispatchEvent(new CustomEvent<ReviewAcceptDetail>(REVIEW_ACCEPT, { detail }));
  return detail.handled;
}
