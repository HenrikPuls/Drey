import type { CallOptions, TicketDetail, TicketRecord, TicketStore } from '../ports/ticket-store';

/**
 * Reads every ticket of a store as a `TicketDetail` (E14-2). dk v0.6.0's `ls`
 * answers the header subset only (dricket requirement R-05 is open), so the
 * board needs one `show` per ticket; this reader bounds the parallelism and
 * remembers what it has read, keyed by what `ls` reports about the ticket, so
 * a second snapshot re-reads only tickets whose row changed. When R-05 lands
 * `ls` carries everything and this class shrinks to one call.
 */
export class StoreReader {
  private readonly cache = new Map<string, { key: string; detail: TicketDetail }>();

  constructor(
    private readonly store: TicketStore,
    private readonly concurrency = 6,
  ) {}

  async readAll(call: CallOptions = {}): Promise<readonly TicketDetail[]> {
    const rows = await this.store.list({}, call);
    const out: (TicketDetail | undefined)[] = new Array<TicketDetail | undefined>(rows.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        const row = rows[i];
        if (row === undefined) {
          return;
        }
        out[i] = await this.detailOf(row, call);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, rows.length) }, () => worker()));
    // Forget tickets that left the store.
    const live = new Set(rows.map((r) => r.id));
    for (const id of this.cache.keys()) {
      if (!live.has(id)) {
        this.cache.delete(id);
      }
    }
    return out.filter((d): d is TicketDetail => d !== undefined);
  }

  private async detailOf(row: TicketRecord, call: CallOptions): Promise<TicketDetail> {
    // Every part of the row a write can change: rev moves on any ticket write,
    // epoch / owner / stage on claims and moves.
    const key = [row.rev, row.epoch, row.stage, row.owner, row.title, row.priority].join('|');
    const cached = this.cache.get(row.id);
    if (cached !== undefined && cached.key === key && row.rev !== null) {
      return cached.detail;
    }
    const detail = await this.store.show(row.id, call);
    this.cache.set(row.id, { key, detail });
    return detail;
  }
}
