import { watch as fsWatch } from 'node:fs';

/**
 * Change detection for a store checkout (E14-4, hardened by E14-8). Sources
 * feed one `onChange`:
 *
 * - the engine's own writes announce at once ({@link StoreChangeFeed.notifyOwnWrite});
 * - a file watcher on the checkout catches foreign writers (another Drey, a
 *   terminal `dk`, a git operation), debounced: an announcement fires after a
 *   quiet period (default 200 ms) or, in a burst that never goes quiet, after
 *   `maxWaitMs` (default 1 s) — so a commit that rewrites many files is one
 *   announcement of the finished state, not a read of a half-written tree.
 *   `.git` churn is ignored;
 * - the own write's echo on the watcher is not announced a second time — but not
 *   swallowed blind either: when events landed in the echo window, the HEAD
 *   commit is compared with the one right after the own write, and a different
 *   one is a foreign write that announces;
 * - a safety net for a watcher that lost events (Windows' change buffer
 *   overflows when the process is busy for seconds, a network drive or a
 *   crashed watcher reports nothing): every few seconds the HEAD commit is
 *   compared with the last announced one, and a move nobody reported announces
 *   and is counted as a miss;
 * - a remote store adds a periodic `dk sync` (default 30 s; skipped while the
 *   remote branch has not moved) — the sync moves files, the watcher sees
 *   them — and {@link StoreChangeFeed.syncNow} for the on-demand moments
 *   (refresh, board open, before a claim), which always syncs.
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

export const DEFAULT_DEBOUNCE_MS = 200;
export const DEFAULT_MAX_WAIT_MS = 1000;
export const DEFAULT_REF_CHECK_MS = 10_000;
/** A watcher event this recent means the watcher is on it: the ref check does not call that a miss. */
const WATCHER_GRACE_MS = 1500;

export interface StoreChangeFeedOptions {
  /** The checkout directory to watch. */
  readonly dir: string;
  readonly onChange: () => void;
  /** Quiet period of the watcher debounce. */
  readonly debounceMs?: number;
  /** Longest an announcement waits behind a burst that never goes quiet. */
  readonly maxWaitMs?: number;
  readonly watch?: WatchFn;
  /** Periodic sync for a remote store; null = none (a local store shares the ref). */
  readonly syncEveryMs?: number | null;
  readonly sync?: () => Promise<void>;
  /** The periodic round skips its sync while this says the remote has not moved; a failure counts as moved. */
  readonly remoteMoved?: () => Promise<boolean>;
  /** The checkout's HEAD commit (null = unknown); enables the echo comparison and the ref check. */
  readonly fingerprint?: () => Promise<string | null>;
  /** Ref check period; null = off. Default {@link DEFAULT_REF_CHECK_MS} when a fingerprint is given. */
  readonly refCheckEveryMs?: number | null;
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/** Counters for diagnosis ("did the watcher miss?"); read with {@link StoreChangeFeed.stats}. */
export interface StoreChangeFeedStats {
  readonly announcements: number;
  readonly ownWrites: number;
  readonly watcherEvents: number;
  /** Own-write echoes that were recognised as echoes and not announced. */
  readonly echoesDropped: number;
  /** HEAD moves the ref check found that no watcher event had reported. */
  readonly refMisses: number;
  readonly syncs: number;
  readonly syncsSkipped: number;
}

export class StoreChangeFeed {
  private handle: WatchHandle | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private burstStart = 0;
  private lastEventAt = 0;
  private echoTimer: ReturnType<typeof setTimeout> | null = null;
  private echoUntil = 0;
  private echoPending = false;
  private ownFingerprint: Promise<string | null> = Promise.resolve(null);
  private known: string | null = null;
  private knownBusy = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private refInterval: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private stopped = true;
  private warnedMiss = false;
  private counters = { announcements: 0, ownWrites: 0, watcherEvents: 0, echoesDropped: 0, refMisses: 0, syncs: 0, syncsSkipped: 0 };

  constructor(private readonly options: StoreChangeFeedOptions) {}

  stats(): StoreChangeFeedStats {
    return { ...this.counters };
  }

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
        this.onWatcherEvent();
      });
    } catch (error) {
      // No watcher is not fatal: own writes, the ref check and the sync round still announce.
      this.options.log?.(`tickets: cannot watch ${this.options.dir}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
    const every = this.options.syncEveryMs ?? null;
    if (every !== null && every > 0 && this.options.sync !== undefined) {
      this.interval = setInterval(() => void this.periodicSync(), every);
      this.interval.unref();
    }
    if (this.options.fingerprint !== undefined) {
      void this.rememberHead();
      const refEvery = this.options.refCheckEveryMs === undefined ? DEFAULT_REF_CHECK_MS : this.options.refCheckEveryMs;
      if (refEvery !== null && refEvery > 0) {
        this.refInterval = setInterval(() => void this.refCheck(), refEvery);
        this.refInterval.unref();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.handle?.close();
    this.handle = null;
    for (const timer of [this.quietTimer, this.echoTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    this.quietTimer = null;
    this.echoTimer = null;
    this.echoPending = false;
    for (const timer of [this.interval, this.refInterval]) {
      if (timer !== null) {
        clearInterval(timer);
      }
    }
    this.interval = null;
    this.refInterval = null;
  }

  /** The engine wrote: announce now; the watcher's echo of the same write is recognised afterwards, not announced twice. */
  notifyOwnWrite(): void {
    this.counters.ownWrites += 1;
    this.clearQuiet();
    this.echoPending = false;
    this.announce();
    const window = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.echoUntil = Date.now() + window;
    if (this.options.fingerprint !== undefined) {
      this.ownFingerprint = this.rememberHead();
    }
    if (this.echoTimer !== null) {
      clearTimeout(this.echoTimer);
    }
    this.echoTimer = setTimeout(() => {
      this.echoTimer = null;
      void this.endEchoWindow();
    }, window);
    this.echoTimer.unref();
  }

  /** One `dk sync` now (no overlap with a running one); never throws. */
  syncNow(): Promise<void> {
    const sync = this.options.sync;
    if (sync === undefined) {
      return Promise.resolve();
    }
    if (this.syncing === null) {
      this.counters.syncs += 1;
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

  private async periodicSync(): Promise<void> {
    if (this.options.remoteMoved !== undefined && this.syncing === null) {
      const moved = await this.options.remoteMoved().catch(() => true);
      if (!moved) {
        this.counters.syncsSkipped += 1;
        return;
      }
    }
    await this.syncNow();
  }

  private announce(): void {
    this.counters.announcements += 1;
    this.options.onChange();
    if (this.options.fingerprint !== undefined) {
      void this.rememberHead();
    }
  }

  /** Reads HEAD and makes it the one the last announcement stands for. */
  private async rememberHead(): Promise<string | null> {
    const fingerprint = this.options.fingerprint;
    if (fingerprint === undefined) {
      return null;
    }
    this.knownBusy = true;
    try {
      const head = await fingerprint();
      if (head !== null && !this.stopped) {
        this.known = head;
      }
      return head;
    } finally {
      this.knownBusy = false;
    }
  }

  private onWatcherEvent(): void {
    if (this.stopped) {
      return;
    }
    this.counters.watcherEvents += 1;
    const now = Date.now();
    this.lastEventAt = now;
    if (now < this.echoUntil) {
      this.echoPending = true;
      return;
    }
    this.schedule(now);
  }

  /** Trailing debounce with a ceiling: fire after a quiet period, but never later than `maxWaitMs` after the burst began. */
  private schedule(now: number): void {
    const quiet = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const maxWait = Math.max(this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS, quiet);
    if (this.quietTimer === null) {
      this.burstStart = now;
    } else {
      clearTimeout(this.quietTimer);
    }
    const delay = Math.max(0, Math.min(quiet, this.burstStart + maxWait - now));
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (!this.stopped) {
        this.announce();
      }
    }, delay);
  }

  private clearQuiet(): void {
    if (this.quietTimer !== null) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }

  private async endEchoWindow(): Promise<void> {
    if (this.stopped || !this.echoPending) {
      return;
    }
    this.echoPending = false;
    const fingerprint = this.options.fingerprint;
    if (fingerprint === undefined) {
      this.announce();
      return;
    }
    const [own, now] = await Promise.all([this.ownFingerprint, fingerprint()]);
    if (this.stopped) {
      return;
    }
    if (own !== null && now !== null && own === now) {
      this.counters.echoesDropped += 1;
      return;
    }
    this.announce();
  }

  private async refCheck(): Promise<void> {
    const fingerprint = this.options.fingerprint;
    if (fingerprint === undefined || this.stopped || this.knownBusy) {
      return;
    }
    const head = await fingerprint();
    if (head === null || this.stopped) {
      return;
    }
    if (this.known === null) {
      this.known = head;
      return;
    }
    if (head === this.known) {
      return;
    }
    // Moved. A watcher that is already on it (a pending announcement, a fresh event, an echo window) is not a miss.
    if (this.quietTimer !== null || this.echoTimer !== null || Date.now() - this.lastEventAt < WATCHER_GRACE_MS) {
      return;
    }
    this.counters.refMisses += 1;
    if (!this.warnedMiss) {
      this.warnedMiss = true;
      this.options.log?.(`tickets: the store moved (${head.slice(0, 8)}) without a watcher event - announced by the ref check`, 'warn');
    }
    this.known = head;
    this.counters.announcements += 1;
    this.options.onChange();
  }
}
