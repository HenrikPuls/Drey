// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createThreadComments, type ThreadComment } from './thread-comments';

const NOW = Date.parse('2026-11-06T12:00:00Z');

const comment = (text: string, over: Partial<ThreadComment> = {}): ThreadComment => ({
  author: 'owner@desk',
  at: '2026-11-06T11:00:00Z',
  text,
  verb: null,
  key: null,
  ...over,
});

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('the comments in a ticket thread (D-12)', () => {
  it('shows a store ticket\'s comments as written, oldest first, with author and age', async () => {
    const invoke = vi.fn(async () => [comment('First.'), comment('Second\nline.', { author: 'ben@fleet' })]);
    const view = createThreadComments({ ticketId: 'T-0002', invoke, now: () => NOW });
    view.refresh();
    await settle();
    expect(invoke).toHaveBeenCalledWith('ticketComments', { id: 'T-0002' });
    expect(view.element.hidden).toBe(false);
    expect([...view.element.querySelectorAll('.tickets-thread-comment-text')].map((n) => n.textContent)).toEqual(['First.', 'Second\nline.']);
    expect(view.element.querySelectorAll('.tickets-thread-comment-head')[1]?.textContent).toBe('ben@fleet · 1 h');
  });

  it('takes no room on a ticket without comments, and on the files backend', async () => {
    const view = createThreadComments({ ticketId: 'T-0002', invoke: async () => [], now: () => NOW });
    view.refresh();
    await settle();
    expect(view.element.hidden).toBe(true);
    expect(view.element.children).toHaveLength(0);
  });

  it('keeps what it shows when a read fails', async () => {
    const replies: (() => Promise<readonly ThreadComment[]>)[] = [async () => [comment('Kept.')], () => Promise.reject(new Error('gone'))];
    let clock = NOW;
    const view = createThreadComments({ ticketId: 'T-0002', invoke: () => replies.shift()!(), now: () => clock });
    view.refresh();
    await settle();
    clock += 60_000;
    view.refresh();
    await settle();
    expect(view.element.textContent).toContain('Kept.');
  });

  it('asks at most every few seconds however often the thread repaints', async () => {
    const invoke = vi.fn(async () => [] as readonly ThreadComment[]);
    let clock = NOW;
    const view = createThreadComments({ ticketId: 'T-0002', invoke, now: () => clock });
    view.refresh();
    await settle();
    view.refresh();
    view.refresh();
    expect(invoke).toHaveBeenCalledTimes(1);
    clock += 5_000;
    view.refresh();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('does not repaint an unchanged list, so a selection in it survives', async () => {
    let clock = NOW;
    const view = createThreadComments({ ticketId: 'T-0002', invoke: async () => [comment('Same.')], now: () => clock });
    view.refresh();
    await settle();
    const first = view.element.querySelector('.tickets-thread-comment');
    clock += 5_000;
    view.refresh();
    await settle();
    expect(view.element.querySelector('.tickets-thread-comment')).toBe(first);
  });
});
