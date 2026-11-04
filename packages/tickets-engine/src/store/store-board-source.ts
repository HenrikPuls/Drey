import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { BoardSnapshot } from '../contracts/tickets';
import type { TicketDetail, TicketStore } from '../ports/ticket-store';
import { diffBoards, renderBoardDiff, type BoardDiff } from './board-diff';
import { assembleBoardFromRecords, type RecordsBoardInput } from './store-board';
import { StoreReader } from './store-reader';
import { createDricketStore, type StoreSettings } from './store-settings';

/**
 * The glue between the board service and the dricket store (E14-2): builds the
 * store (once per settings), reads its tickets through the caching
 * {@link StoreReader}, and runs the `shadow` comparison off the request path.
 * Read-only — nothing here writes to a store.
 */
export class StoreBoardSource {
  private current: { key: string; store: TicketStore; reader: StoreReader } | null = null;
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
  ) {}

  private readerFor(settings: StoreSettings): StoreReader {
    const key = JSON.stringify([settings.dkPath, settings.dkStore, settings.dkDataDir]);
    if (this.current === null || this.current.key !== key) {
      const store = this.storeFactory(settings);
      this.current = { key, store, reader: new StoreReader(store) };
    }
    return this.current.reader;
  }

  /** The store's tickets; throws a readable error when `dk` or the store is not usable. */
  async records(settings: StoreSettings): Promise<readonly TicketDetail[]> {
    if (settings.dkStore === '') {
      throw new Error('no dricket store configured (tickets.dk.store)');
    }
    return this.readerFor(settings).readAll();
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
