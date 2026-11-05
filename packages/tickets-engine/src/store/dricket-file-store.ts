import {
  TicketStoreError,
  type AddOptions,
  type AddResult,
  type CallOptions,
  type Claim,
  type ClaimOptions,
  type CommentOptions,
  type ExtendOptions,
  type LeaseExtension,
  type PutOptions,
  type PutResult,
  type ReleaseOptions,
  type ReleaseResult,
  type StoreCapabilities,
  type TicketComment,
  type TicketDetail,
  type TicketFilter,
  type TicketRecord,
  type TicketStore,
} from '../ports/ticket-store';
import type { DricketTicketStore } from './dricket-ticket-store';
import type { FileStoreReader } from './file-store-reader';

/** What {@link DricketFileStore.write} reports: done, or "changed in the meantime" with the ticket as it is now. */
export type WriteOutcome =
  | { readonly ok: true; readonly result: PutResult }
  | { readonly ok: false; readonly conflict: { readonly current: TicketDetail } };

/**
 * The E14-4 store: reads come from the files of the store's checkout
 * ({@link FileStoreReader}, read-only), every write goes through `dk`
 * ({@link DricketTicketStore}: `put --claim --if-version`, claim, release,
 * extend). The engine is the single writer — `DkProcess` queues all writes of
 * one store — and a read is never more than one directory walk behind the last
 * own write, because a write only returns once the checkout shows its `rev`.
 */
export class DricketFileStore implements TicketStore {
  readonly backend = 'dricket' as const;

  constructor(
    private readonly reader: FileStoreReader,
    private readonly dk: DricketTicketStore,
    /** The checkout `dk sync` runs in (a remote store has to be synced; a local one shares the ref). */
    private readonly checkout: string,
  ) {}

  async capabilities(): Promise<StoreCapabilities> {
    const base = await this.dk.capabilities();
    return { ...base, comments: true };
  }

  list(filter?: TicketFilter, call?: CallOptions): Promise<readonly TicketRecord[]> {
    return this.reader.list(filter, call);
  }

  /** Every ticket with its whole document (what the board needs). */
  readAll(call?: CallOptions): Promise<readonly TicketDetail[]> {
    return this.reader.readAll(call);
  }

  show(id: string, call?: CallOptions): Promise<TicketDetail> {
    return this.reader.show(id, call);
  }

  comments(id: string, call?: CallOptions): Promise<readonly TicketComment[]> {
    return this.reader.comments(id, call);
  }

  claim(id: string, options: ClaimOptions, call?: CallOptions): Promise<Claim> {
    return this.dk.claim(id, options, call);
  }

  release(id: string, options: ReleaseOptions, call?: CallOptions): Promise<ReleaseResult> {
    return this.dk.release(id, options, call);
  }

  extend(id: string, options: ExtendOptions, call?: CallOptions): Promise<LeaseExtension> {
    return this.dk.extend(id, options, call);
  }

  comment(id: string, text: string, options: CommentOptions, call?: CallOptions): Promise<void> {
    return this.dk.comment(id, text, options, call);
  }

  /**
   * Replaces a ticket with `text`, made on `options.expectedRev`. Exit 12 (the
   * ticket moved on) is not an error here: the ticket is re-read and handed back
   * so the caller can ask the user. Every other failure throws.
   */
  async write(id: string, text: string, options: PutOptions, call?: CallOptions): Promise<WriteOutcome> {
    try {
      const result = await this.dk.put(id, text, options, call);
      await this.waitForCheckout(id, result.rev, call);
      return { ok: true, result };
    } catch (error) {
      if (error instanceof TicketStoreError && error.kind === 'conflict') {
        return { ok: false, conflict: { current: await this.reader.show(id, call) } };
      }
      throw error;
    }
  }

  /** Creates an unclaimed ticket (`dk add`); returns once the checkout shows it, so the caller can read and fill it. */
  async add(options: AddOptions, call?: CallOptions): Promise<AddResult> {
    const created = await this.dk.add(options, call);
    await this.waitForCheckout(created.id, 0, call);
    return created;
  }

  /** `dk sync` in the checkout: fetch and fast-forward (refresh, board open, before a claim, the periodic round). */
  sync(call?: CallOptions): Promise<void> {
    return this.dk.sync(this.checkout, call);
  }

  /** The checkout is current after a local write; a remote or dirty checkout is synced once, and a still-stale one is reported. */
  private async waitForCheckout(id: string, rev: number, call?: CallOptions): Promise<void> {
    if (await this.checkoutHas(id, rev, call)) {
      return;
    }
    await this.sync(call);
    if (!(await this.checkoutHas(id, rev, call))) {
      throw new TicketStoreError('unavailable', `the write of ${id} landed (rev ${rev}) but the checkout ${this.checkout} does not show it; is it clean and on the ticket branch?`);
    }
  }

  private async checkoutHas(id: string, rev: number, call?: CallOptions): Promise<boolean> {
    try {
      const now = await this.reader.show(id, call);
      return now.rev !== null && now.rev >= rev;
    } catch (error) {
      if (error instanceof TicketStoreError && error.kind === 'not-found') {
        return false;
      }
      throw error;
    }
  }
}
