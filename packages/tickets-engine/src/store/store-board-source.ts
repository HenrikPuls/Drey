import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { BoardSnapshot } from '../contracts/tickets';
import type { TicketDetail, TicketStore } from '../ports/ticket-store';
import { diffBoards, renderBoardDiff, type BoardDiff } from './board-diff';
import { assembleBoardFromRecords, type RecordsBoardInput } from './store-board';
import type { PutOptions } from '../ports/ticket-store';
import type { DricketTicketStore } from './dricket-ticket-store';
import { DricketFileStore, type WriteOutcome } from './dricket-file-store';
import { FileStoreReader } from './file-store-reader';
import { StoreChangeFeed, type WatchFn } from './store-change-feed';
import { StoreReader } from './store-reader';
import { checkoutOf, createDricketStore, type StoreSettings } from './store-settings';

/** The seams of the file path (E14-4); specs replace them, the engine leaves them out. */
export interface StoreBoardSourceOptions {
  /** The store's change feed fired: the board is stale. */
  readonly onChange?: () => void;
  /** Debounce of the watcher; default 200 ms. */
  readonly debounceMs?: number;
  readonly watch?: WatchFn;
  /** The `dk` store of the file path (reads of tickets never use it; writes, claims and syncs do). */
  readonly dkFactory?: (settings: StoreSettings) => DricketTicketStore;
}

interface Source {
  readonly key: string;
  /** The legacy read path: one `dk show` per ticket. Used only without a checkout. */
  readonly reader: StoreReader;
  /** The file read + `dk` write path; null without a checkout. */
  readonly files: DricketFileStore | null;
  readonly feed: StoreChangeFeed | null;
  readonly remote: boolean;
  synced: boolean;
}

/**
 * The glue between the board service and the dricket store: builds the store
 * (once per settings) and reads its tickets (E14-2) — from the files of the
 * store's checkout when there is one (E14-4: 18 ms for 91 tickets, no process),
 * else through the caching {@link StoreReader} — runs the `shadow` comparison
 * off the request path, and is the one door for writes (`dk put`, the engine the
 * single writer) and for change detection (own writes, watcher, `dk sync`).
 */
export class StoreBoardSource {
  private current: Source | null = null;
  private shadowRunning = false;
  private shadowAt = 0;
  private lastDiff: BoardDiff | null = null;

  constructor(
    /** Where the shadow report lands (`<userRoot>/shadow`). */
    private readonly reportDir: string,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void,
    /** Minimum gap between two shadow runs (every snapshot would otherwise cost a `dk` pass). */
    private readonly shadowIntervalMs = 30_000,
    /** Test seam: a store instead of the real `dk`. */
    private readonly storeFactory: (settings: StoreSettings) => TicketStore = createDricketStore,
    private readonly options: StoreBoardSourceOptions = {},
  ) {}

  private sourceFor(settings: StoreSettings): Source {
    const key = JSON.stringify([settings.dkPath, settings.dkStore, settings.dkDataDir, settings.dkCheckout, settings.dkSyncSeconds]);
    if (this.current !== null && this.current.key === key) {
      return this.current;
    }
    this.current?.feed?.stop();
    const checkout = checkoutOf(settings);
    const reader = new StoreReader(this.storeFactory(settings));
    let source: Source;
    if (checkout === null) {
      source = { key, reader, files: null, feed: null, remote: false, synced: false };
    } else {
      const dk = (this.options.dkFactory ?? createDricketStore)(settings);
      const files = new DricketFileStore(new FileStoreReader({ root: checkout }), dk, checkout);
      const remote = settings.dkCheckout !== '' && settings.dkCheckout !== settings.dkStore;
      const feed = this.options.onChange === undefined
        ? null
        : new StoreChangeFeed({
          dir: checkout,
          onChange: this.options.onChange,
          ...(this.options.debounceMs === undefined ? {} : { debounceMs: this.options.debounceMs }),
          ...(this.options.watch === undefined ? {} : { watch: this.options.watch }),
          syncEveryMs: remote && settings.dkSyncSeconds > 0 ? settings.dkSyncSeconds * 1000 : null,
          sync: () => files.sync(),
          log: this.log,
        });
      feed?.start();
      source = { key, reader, files, feed, remote, synced: false };
    }
    this.current = source;
    return source;
  }

  /** Stops the watcher and the sync round (the service is shutting down, or the settings changed). */
  dispose(): void {
    this.current?.feed?.stop();
    this.current = null;
  }

  /** The file store of the configured checkout, or null when reads go through `dk`. */
  fileStore(settings: StoreSettings): DricketFileStore | null {
    return this.sourceFor(settings).files;
  }

  /**
   * Replaces a ticket through `dk put --claim --if-version`; a conflict (exit 12)
   * comes back with the ticket as it is now, so the caller can ask. Announces the
   * change at once. Needs a checkout (the write path is the file store's).
   */
  async write(settings: StoreSettings, id: string, text: string, options: PutOptions): Promise<WriteOutcome> {
    const source = this.sourceFor(settings);
    if (source.files === null) {
      throw new Error('no ticket checkout configured (tickets.dk.checkout, or a local tickets.dk.store)');
    }
    const outcome = await source.files.write(id, text, options);
    if (outcome.ok) {
      source.feed?.notifyOwnWrite();
    }
    return outcome;
  }

  /** `dk sync` of a remote store now (refresh, board open, before a claim); a local store shares the ref and needs none. */
  async syncNow(settings: StoreSettings): Promise<void> {
    const source = this.sourceFor(settings);
    if (source.remote && source.feed !== null) {
      await source.feed.syncNow();
    }
  }

  /** The store's tickets; throws a readable error when `dk` or the store is not usable. */
  async records(settings: StoreSettings): Promise<readonly TicketDetail[]> {
    if (settings.dkStore === '') {
      throw new Error('no dricket store configured (tickets.dk.store)');
    }
    const source = this.sourceFor(settings);
    if (source.files === null) {
      return source.reader.readAll();
    }
    if (source.remote && !source.synced) {
      // Board open on a remote store: bring the checkout up to date once (best effort).
      source.synced = true;
      await source.feed?.syncNow();
    }
    return source.files.readAll();
  }

  /** The board from the store; a store that cannot be read gives an empty board with one error issue. */
  async board(settings: StoreSettings, input: Omit<RecordsBoardInput, 'records'>): Promise<BoardSnapshot> {
    try {
      return assembleBoardFromRecords({ ...input, records: await this.records(settings) });
    } catch (error) {
      const message = `dricket store: ${error instanceof Error ? error.message : String(error)}`;
      const empty = assembleBoardFromRecords({ ...input, records: [] });
      return { ...empty, issues: [{ level: 'error', message }, ...empty.issues] };
    }
  }

  /** The last comparison, or null before the first shadow run finished. */
  get lastShadowDiff(): BoardDiff | null {
    return this.lastDiff;
  }

  /**
   * Shadow mode: builds the board from the store, compares it with the board
   * the UI shows and writes `board-diff.md` / `board-diff.json`. Fire and
   * forget (never throws, never delays the snapshot), one run at a time, at
   * most one per interval.
   */
  scheduleShadow(settings: StoreSettings, input: Omit<RecordsBoardInput, 'records'>, shown: BoardSnapshot): void {
    const now = Date.now();
    if (this.shadowRunning || now - this.shadowAt < this.shadowIntervalMs) {
      return;
    }
    this.shadowRunning = true;
    this.shadowAt = now;
    void this.runShadow(settings, input, shown).finally(() => {
      this.shadowRunning = false;
    });
  }

  /** The awaitable core of {@link scheduleShadow} (specs call it directly). */
  async runShadow(settings: StoreSettings, input: Omit<RecordsBoardInput, 'records'>, shown: BoardSnapshot): Promise<BoardDiff | null> {
    const info = { generatedAt: new Date().toISOString(), leftName: 'files', rightName: 'dricket' };
    let diff: BoardDiff | null = null;
    let error: string | undefined;
    try {
      const candidate = assembleBoardFromRecords({ ...input, records: await this.records(settings) });
      diff = diffBoards(shown, candidate);
      this.lastDiff = diff;
      if (!diff.equal) {
        this.log(`tickets shadow: boards differ (${diff.differing.length} tickets differ, ${diff.onlyLeft.length} only in files, ${diff.onlyRight.length} only in dricket) - see ${path.join(this.reportDir, 'board-diff.md')}`, 'warn');
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.log(`tickets shadow: the dricket board could not be built: ${error}`, 'warn');
    }
    try {
      await fsp.mkdir(this.reportDir, { recursive: true });
      await fsp.writeFile(path.join(this.reportDir, 'board-diff.md'), renderBoardDiff(diff, { ...info, ...(error === undefined ? {} : { error }) }), 'utf8');
      await fsp.writeFile(path.join(this.reportDir, 'board-diff.json'), JSON.stringify({ ...info, error: error ?? null, diff }, null, 2) + '\n', 'utf8');
    } catch (e) {
      this.log(`tickets shadow: the report could not be written: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
    return diff;
  }
}
