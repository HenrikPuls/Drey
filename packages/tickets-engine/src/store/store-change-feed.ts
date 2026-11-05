import { watch as fsWatch } from 'node:fs';

/**
 * Change detection for a store checkout (E14-4, hardened by E14-8). Three
 * sources feed one `onChange`:
 *
 * - the engine's own writes announce at once ({@link StoreChangeFeed.notifyOwnWrite});
 * - a file watcher on the checkout catches foreign writers (another Drey, a
 *   terminal `dk`), debounced (default 200 ms) so one commit's burst of file
 *   events is one announcement; `.git` churn is ignored;
 * - a remote store adds a periodic `dk sync` (default 30 s) — the sync moves
 *   files, the watcher sees them — and {@link StoreChangeFeed.syncNow} for the
 *   on-demand moments (refresh, board open, before a claim).
 *
 * The own write's file events are swallowed by the same debounce: they land
 * inside the window that the direct announcement already opened.
 */

export interface WatchHandle {
  close(): void;
}

/** Injectable for specs; the default is `fs.watch` (recursive — Windows, macOS and Node >= 20 on Linux). */
export type WatchFn = (dir: string, onEvent: (filename: string | null) => void) => WatchHandle;

export const defaultWatch: WatchFn = (dir, onEvent) => {
  const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => onEvent(filename === null ? null : String(filename)));
  watcher.on('error', () => undefined);
  return { close: () => watcher.close() };
};

export interface StoreChangeFeedOptions {
  /** The checkout directory to watch. */
  readonly dir: string;
  readonly onChange: () => void;
  readonly debounceMs?: number;
  readonly watch?: WatchFn;
  /** Periodic sync for a remote store; null = none (a local store shares the ref). */
  readonly syncEveryMs?: number | null;
  readonly sync?: () => Promise<void>;
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export class StoreChangeFeed {
  private handle: WatchHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly options: StoreChangeFeedOptions) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    try {
      this.handle = (this.options.watch ?? defaultWatch)(this.options.dir, (filename) => {
        if (filename !== null && /^\.git(?:[\\/]|$)/.test(filename)) {
          return;
        }
        this.schedule();
      });
    } catch (error) {
      // No watcher is not fatal: own writes and the sync round still announce.
      this.options.log?.(`tickets: cannot watch ${this.options.dir}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
    const every = this.options.syncEveryMs ?? null;
    if (every !== null && every > 0 && this.options.sync !== undefined) {
      this.interval = setInterval(() => void this.syncNow(), every);
      this.interval.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    this.handle?.close();
    this.handle = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** The engine wrote: announce now, and let the watcher's echo of the same write fall into the next window. */
  notifyOwnWrite(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.options.onChange();
    this.timer = setTimeout(() => {
      this.timer = null;
    }, this.options.debounceMs ?? 200);
    this.timer.unref();
  }

  /** One `dk sync` now (no overlap with a running one); never throws. */
  syncNow(): Promise<void> {
    const sync = this.options.sync;
    if (sync === undefined) {
      return Promise.resolve();
    }
    if (this.syncing === null) {
      this.syncing = sync()
        .catch((error: unknown) => {
          this.options.log?.(`tickets: dk sync failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        })
        .finally(() => {
          this.syncing = null;
        });
    }
    return this.syncing;
  }

  private schedule(): void {
    if (this.stopped || this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) {
        this.options.onChange();
      }
    }, this.options.debounceMs ?? 200);
  }
}
