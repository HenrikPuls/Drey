import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StoreChangeFeed, type WatchFn } from './store-change-feed';

describe('StoreChangeFeed', () => {
  let emit: (filename: string | null) => void = () => undefined;
  let closed = false;
  const watch: WatchFn = (_dir, onEvent) => {
    emit = onEvent;
    return { close: () => { closed = true; } };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    closed = false;
  });
  afterEach(() => vi.useRealTimers());

  it('turns a burst of file events into one announcement after the debounce', () => {
    const onChange = vi.fn();
    const feed = new StoreChangeFeed({ dir: '/c', onChange, watch });
    feed.start();
    emit('tickets/t/0000/t-1/ticket.md');
    emit('tickets/t/0000/t-2/ticket.md');
    vi.advanceTimersByTime(199);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    feed.stop();
    expect(closed).toBe(true);
  });

  it('ignores .git churn', () => {
    const onChange = vi.fn();
    new StoreChangeFeed({ dir: '/c', onChange, watch }).start();
    emit('.git/index.lock');
    emit('.git');
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('announces an own write at once and swallows its file echo', () => {
    const onChange = vi.fn();
    const feed = new StoreChangeFeed({ dir: '/c', onChange, watch });
    feed.start();
    feed.notifyOwnWrite();
    expect(onChange).toHaveBeenCalledTimes(1);
    emit('tickets/t/0000/t-1/ticket.md');
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    emit('tickets/t/0000/t-1/ticket.md');
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('syncs a remote store on the interval, never overlapping, and survives a failure', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const sync = vi.fn(() => {
      calls += 1;
      return calls === 1 ? new Promise<void>((r) => { release = r; }) : Promise.reject(new Error('offline'));
    });
    const log = vi.fn();
    const feed = new StoreChangeFeed({ dir: '/c', onChange: vi.fn(), watch, sync, syncEveryMs: 30_000, log });
    feed.start();
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    expect(sync).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'), 'warn');
    feed.stop();
  });

  it('does not sync a local store (no interval)', () => {
    const sync = vi.fn(() => Promise.resolve());
    new StoreChangeFeed({ dir: '/c', onChange: vi.fn(), watch, sync, syncEveryMs: null }).start();
    vi.advanceTimersByTime(120_000);
    expect(sync).not.toHaveBeenCalled();
  });

  it('keeps working without a watcher', () => {
    const log = vi.fn();
    const feed = new StoreChangeFeed({ dir: '/c', onChange: vi.fn(), watch: () => { throw new Error('ENOSPC'); }, log });
    feed.start();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'), 'warn');
    feed.stop();
  });
});
