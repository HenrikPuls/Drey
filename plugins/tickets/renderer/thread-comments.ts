import { ageWords } from './work-groups';

/**
 * A store ticket's comments in its thread (E14-6, D-12): what a terminal, a worker or the
 * phone wrote, as written and oldest first. Read-only; a comment composer is a roadmap
 * follow-up of E14-6. The files backend answers none, and then this takes no room.
 */
export interface ThreadComment {
  readonly author: string;
  readonly at: string;
  readonly text: string;
  readonly verb: string | null;
  readonly key: string | null;
}

export interface ThreadCommentsDeps {
  readonly ticketId: string;
  readonly invoke: (method: string, payload: unknown) => Promise<unknown>;
  readonly now: () => number;
}

export interface ThreadComments {
  readonly element: HTMLElement;
  /** Re-reads the comments; the thread calls it on every repaint, so it asks at most every few seconds. */
  refresh(): void;
}

const MIN_GAP_MS = 5_000;

const node = (tag: string, className: string, text?: string): HTMLElement => {
  const out = document.createElement(tag);
  out.className = className;
  if (text !== undefined) {
    out.textContent = text;
  }
  return out;
};

export function createThreadComments(deps: ThreadCommentsDeps): ThreadComments {
  const element = node('div', 'tickets-thread-comments');
  element.hidden = true;
  let askedAt = Number.NEGATIVE_INFINITY;
  let painted = '';

  const paint = (comments: readonly ThreadComment[]): void => {
    const signature = JSON.stringify(comments);
    if (signature === painted) {
      return;
    }
    painted = signature;
    element.replaceChildren(
      ...comments.map((comment) => {
        const row = node('div', 'tickets-thread-comment');
        const age = ageWords(comment.at, deps.now());
        row.append(
          node('div', 'tickets-thread-comment-head', age === '' ? comment.author : `${comment.author} · ${age}`),
          node('div', 'tickets-thread-comment-text', comment.text),
        );
        return row;
      }),
    );
    element.hidden = comments.length === 0;
  };

  return {
    element,
    refresh: () => {
      const now = deps.now();
      if (now - askedAt < MIN_GAP_MS) {
        return;
      }
      askedAt = now;
      void deps
        .invoke('ticketComments', { id: deps.ticketId })
        .then((reply) => paint(Array.isArray(reply) ? (reply as readonly ThreadComment[]) : []))
        .catch(() => undefined); // the thread keeps what it shows
    },
  };
}
