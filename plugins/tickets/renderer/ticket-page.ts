import type { DocSplit } from '../../../shared/plugin-api/renderer';

/**
 * The ticket page's pair anchor (ADR-0087 decision 3): ONE thread tab
 * beside the ticket file; it follows the ticket opened last. Owned here
 * because which tabs form a pair is board knowledge, not the base's
 * (SDK `beside` stays feature-free).
 */
export const THREAD_KEY = 'thread://ticket';

/** The landing opts the SDK's `documents.open` / `documents.addDoc` take. */
export interface LandingOpts {
  readonly split?: DocSplit;
  readonly beside?: string;
}

/**
 * How the thread tab joins the page once the ticket file is open.
 */
export type ThreadCall =
  /**
   * The thread is closed: `addDoc` beside the just-opened file -- a
   * fresh pane off the file's pane, whatever pane happens to be focused.
   */
  | 'add-beside-file'
  /**
   * The thread is open: `addDoc` on the open key reveals it, which
   * re-activates the tab in its pane (a plain `rename` would leave it
   * backgrounded) -- the caller renames it to the new ticket first.
   */
  | 'reactivate';

/** What `openTicketPage` does, decided pure (req-75): the pair anchors on itself. */
export interface TicketPagePlan {
  /** The file open's opts -- anchored on the thread when only it is open. */
  readonly fileOpts: LandingOpts;
  /** How the thread lands or re-activates after the file. */
  readonly threadCall: ThreadCall;
  /**
   * Open the file again at the end: the thread's landing (or its
   * re-activation) took the focus, and W1's deliberate rule hands it
   * back -- the next ticket opens beside the file, not the thread.
   */
  readonly refocusFile: boolean;
}

/**
 * The landing matrix of the ticket page (req-75): whatever pane is
 * focused and whatever else is open, the pair -- the ticket file and
 * its thread -- ends up side by side and both tabs re-activate on every
 * ticket switch; a third pane never appears beside them.
 *
 * - both closed: the file opens plainly where focus is -- it BECOMES
 *   the pair's own anchor, and the thread adds beside it.
 * - file open, thread closed: the file reveals, the thread adds beside
 *   it (not beside whatever pane is focused).
 * - file closed, thread open: the file lands beside the thread's pane.
 * - both open: both reveal; the thread via `addDoc` on the open key.
 */
export function ticketPagePlan(open: { fileOpen: boolean; threadOpen: boolean }): TicketPagePlan {
  return {
    fileOpts: open.threadOpen && !open.fileOpen ? { beside: THREAD_KEY, split: 'right' } : {},
    threadCall: open.threadOpen ? 'reactivate' : 'add-beside-file',
    refocusFile: true,
  };
}
