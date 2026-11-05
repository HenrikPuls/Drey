import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StoreChangeFeed, type WatchFn } from './store-change-feed';

describe('StoreChangeFeed', () => {
  let emit: (filename: string | null) => void = () => undefined;
  let closed = false;
  const watch: WatchFn = (_dir, onEvent) => {
    emit = onEvent;
    return { close: () => { closed = true; } };
  };
  const file = 'tickets/t/0000/t-1/ticket.md';

  beforeEach(() => {
    vi.useFakeTimers();
    closed = false;
  });
  afterEach(() => vi.useRealTimers());

  it('turns a burst of file events into one announcement after the quiet period', () => {
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

  it('waits for the burst to go quiet, but not longer than the ceiling', () => {
    const onChange = vi.fn();
    const feed = new StoreChangeFeed({ dir: '/c', onChange, watch, debounceMs: 200, maxWaitMs: 1000 });
    feed.start();
    // events every 100 ms keep postponing the announcement ...
    for (let i = 0; i < 6; i++) {
      emit(file);
      vi.advanceTimersByTime(100);
    }
    expect(onChange).not.toHaveBeenCalled();
    // ... until the ceiling (1 s after the burst began) forces it
    for (let i = 0; i < 6; i++) {
      emit(file);
      vi.advanceTimersByTime(100);
    }
    expect(onChange).toHaveBeenCalledTimes(1);
    // the burst's remainder announces after its own quiet period
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(feed.stats().watcherEvents).toBe(12);
    feed.stop();
  });

  it('ignores .git churn', () => {
    const onChange = vi.fn();
    new StoreChangeFeed({ dir: '/c', onChange, watch }).start();
    emit('.git/index.lock');
    emit('.git');
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  describe('own writes', () => {
    it('announces at once; without a fingerprint the echo announces one more time (never swallowed blind)', async () => {
      const onChange = vi.fn();
      const feed = new StoreChangeFeed({ dir: '/c', onChange, watch });
      feed.start();
      feed.notifyOwnWrite();
      expect(onChange).toHaveBeenCalledTimes(1);
      emit(file);
      await vi.advanceTimersByTimeAsync(300);
      expect(onChange).toHaveBeenCalledTimes(2);
      // no event in the window, no second announcement
      feed.notifyOwnWrite();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).toHaveBeenCalledTimes(3);
      feed.stop();
    });

    it('drops the echo when HEAD is still the own write\'s commit', async () => {
      const onChange = vi.fn();
      const feed = new StoreChangeFeed({ dir: '/c', onChange, watch, fingerprint: () => Promise.resolve('aaa'), refCheckEveryMs: null });
      feed.start();
      feed.notifyOwnWrite();
      emit(file);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(feed.stats().echoesDropped).toBe(1);
      feed.stop();
    });

    it('announces a foreign write that landed inside the echo window (HEAD moved)', async () => {
      const onChange = vi.fn();
      let head = 'aaa';
      const feed = new StoreChangeFeed({ dir: '/c', onChange, watch, fingerprint: () => Promise.resolve(head), refCheckEveryMs: null });
      feed.start();
      await vi.advanceTimersByTimeAsync(0);
      feed.notifyOwnWrite();
      await vi.advanceTimersByTimeAsync(10); // the own write's HEAD is read: aaa
      head = 'bbb'; // a terminal `dk put` commits 50 ms later
      emit(file);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(feed.stats().echoesDropped).toBe(0);
      feed.stop();
    });
  });

  describe('ref check (the watcher safety net)', () => {
    it('announces a HEAD move the watcher never reported, and counts the miss', async () => {
      const onChange = vi.fn();
      const log = vi.fn();
      let head = 'aaa';
      const feed = new StoreChangeFeed({ dir: '/c', onChange, watch, fingerprint: () => Promise.resolve(head), refCheckEveryMs: 5000, log });
      feed.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(onChange).not.toHaveBeenCalled();
      head = 'bbb';
      await vi.advanceTimersByTimeAsync(5000);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(feed.stats().refMisses).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('without a watcher event'), 'warn');
      // the same HEAD is not announced again
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onChange).toHaveBeenCalledTimes(1);
      feed.stop();
    });

    it('is not a miss while the watcher is on it', async () => {
      const onChange = vi.fn();
      let head = 'aaa';
      const feed = new StoreChangeFeed({ dir: '/c', onChange, watch, fingerprint: () => Promise.resolve(head), refCheckEveryMs: 5000 });
      feed.start();
      await vi.advanceTimersByTimeAsync(4900);
      head = 'bbb';
      emit(file); // 100 ms before the tick: the debounce is running
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(onChange).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(feed.stats().refMisses).toBe(0);
      feed.stop();
    });

    it('does nothing when git cannot say', async () => {
      const onChange = vi.fn();
      const feed = new StoreChangeFeed({ dir: '/c', onChange, watch, fingerprint: () => Promise.resolve(null), refCheckEveryMs: 1000 });
      feed.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onChange).not.toHaveBeenCalled();
      feed.stop();
    });
  });

  describe('remote sync', () => {
    it('syncs on the interval, never overlapping, and survives a failure', async () => {
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

    it('skips the periodic sync while the remote has not moved; an on-demand sync always runs', async () => {
      const sync = vi.fn(() => Promise.resolve());
      let moved = false;
      const remoteMoved = vi.fn(() => Promise.resolve(moved));
      const feed = new StoreChangeFeed({ dir: '/c', onChange: vi.fn(), watch, sync, remoteMoved, syncEveryMs: 30_000 });
      feed.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sync).not.toHaveBeenCalled();
      expect(feed.stats().syncsSkipped).toBe(2);
      moved = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(1);
      moved = false;
      await feed.syncNow();
      expect(sync).toHaveBeenCalledTimes(2);
      feed.stop();
    });

    it('syncs when the probe itself fails', async () => {
      const sync = vi.fn(() => Promise.resolve());
      const feed = new StoreChangeFeed({ dir: '/c', onChange: vi.fn(), watch, sync, remoteMoved: () => Promise.reject(new Error('x')), syncEveryMs: 30_000 });
      feed.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(1);
      feed.stop();
    });

    it('does not sync a local store (no interval)', () => {
      const sync = vi.fn(() => Promise.resolve());
      new StoreChangeFeed({ dir: '/c', onChange: vi.fn(), watch, sync, syncEveryMs: null }).start();
      vi.advanceTimersByTime(120_000);
      expect(sync).not.toHaveBeenCalled();
    });
  });

  it('keeps working without a watcher', () => {
    const log = vi.fn();
    const feed = new StoreChangeFeed({ dir: '/c', onChange: vi.fn(), watch: () => { throw new Error('ENOSPC'); }, log });
    feed.start();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'), 'warn');
    feed.stop();
  });
});
