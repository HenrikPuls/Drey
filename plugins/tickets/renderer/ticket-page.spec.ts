import { describe, expect, it } from 'vitest';
import { THREAD_KEY, ticketPagePlan } from './ticket-page';

/**
 * The ticket page's pure landing matrix (req-75): the pair anchors on
 * itself, never on whatever pane happens to be focused.
 */
describe('ticketPagePlan', () => {
  it('both closed: the file opens plainly -- it becomes the anchor -- and the thread adds beside it', () => {
    expect(ticketPagePlan({ fileOpen: false, threadOpen: false })).toEqual({
      fileOpts: {},
      threadCall: 'add-beside-file',
      refocusFile: true,
    });
  });

  it('file open, thread closed: the thread adds beside the file, never beside the focused pane', () => {
    expect(ticketPagePlan({ fileOpen: true, threadOpen: false })).toEqual({
      fileOpts: {},
      threadCall: 'add-beside-file',
      refocusFile: true,
    });
  });

  it('file closed, thread open: the file lands beside the thread, not in the focused pane', () => {
    expect(ticketPagePlan({ fileOpen: false, threadOpen: true })).toEqual({
      fileOpts: { beside: THREAD_KEY, split: 'right' },
      threadCall: 'reactivate',
      refocusFile: true,
    });
  });

  it('both open: both reveal -- the thread re-activates in its pane, not just a rename', () => {
    expect(ticketPagePlan({ fileOpen: true, threadOpen: true })).toEqual({
      fileOpts: {},
      threadCall: 'reactivate',
      refocusFile: true,
    });
  });

  it('every branch hands the focus back to the file (W1: the next ticket opens there)', () => {
    for (const open of [
      { fileOpen: false, threadOpen: false },
      { fileOpen: true, threadOpen: false },
      { fileOpen: false, threadOpen: true },
      { fileOpen: true, threadOpen: true },
    ]) {
      expect(ticketPagePlan(open).refocusFile).toBe(true);
    }
  });
});
