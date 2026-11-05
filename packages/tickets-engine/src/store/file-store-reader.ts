import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import {
  TicketStoreError,
  type CallOptions,
  type TicketComment,
  type TicketDetail,
  type TicketFilter,
  type TicketRecord,
} from '../ports/ticket-store';
import { detailFromContent } from './dricket-ticket-store';
import { parseFlatDocument } from './flat-frontmatter';
import { toDricketId } from './ids';

/**
 * The read-only file reader behind the `TicketStore` read port (E14-4,
 * ADR-0090 later change, owner decision 2026-11-05). It builds the board from
 * the files of a store's checkout — `tickets/<prefix>/<shard>/<id>/ticket.md`
 * and `comments/`, the contract in dricket's `docs/protocol.md` — instead of
 * one `dk` process per ticket (91 tickets: 18 ms against 29 s).
 *
 * It is a PARSER, nothing else: it never writes, never claims, never moves a
 * ticket. Every change goes through `dk put` (`DricketFileStore`). The one rule
 * it applies is the lease-expiry rule of protocol.md ("Claims"): a claim whose
 * `lease_until` plus the 20-minute takeover grace has passed is dead — the
 * ticket is reported unclaimed, because another actor may take it over. The raw
 * `text` is never altered, so a later `put` still sees the file as it is.
 */

/** The takeover grace after `lease_until` (protocol.md: not configurable). */
export const TAKEOVER_GRACE_MS = 20 * 60 * 1000;

const DEFAULT_TICKETS_DIR = 'tickets';

export interface FileStoreReaderOptions {
  /** The checkout of the store's ticket branch (a local store: the store directory itself). */
  readonly root: string;
  /** The path prefix of the tickets inside the checkout (`dricket.toml` `path`); default `tickets`. */
  readonly ticketsDir?: string;
  /** Test seam for the lease-expiry rule. */
  readonly now?: () => number;
  /** Parallel file reads; default 16. */
  readonly concurrency?: number;
}

/** A claim past `lease_until` + grace is no claim: owner and lease fields read as empty, `epoch` stays. */
export function applyLeaseExpiry(detail: TicketDetail, nowMs: number): TicketDetail {
  if (detail.owner === null || detail.leaseUntil === null) {
    return detail;
  }
  const until = Date.parse(detail.leaseUntil);
  if (!Number.isFinite(until) || nowMs <= until + TAKEOVER_GRACE_MS) {
    return detail;
  }
  return { ...detail, owner: null, claimedAt: null, leaseUntil: null, size: null };
}

export class FileStoreReader {
  private readonly ticketsRoot: string;
  private readonly now: () => number;
  private readonly concurrency: number;

  constructor(options: FileStoreReaderOptions) {
    this.ticketsRoot = path.join(options.root, options.ticketsDir ?? DEFAULT_TICKETS_DIR);
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? 16;
  }

  /** True when the checkout has a tickets directory at all (a missing branch reads as an empty store). */
  async exists(): Promise<boolean> {
    try {
      return (await fsp.stat(this.ticketsRoot)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Every ticket with its whole document, sorted by id; a directory without a readable `ticket.md` is skipped. */
  async readAll(call: CallOptions = {}): Promise<readonly TicketDetail[]> {
    const dirs = await this.ticketDirs();
    const out: (TicketDetail | undefined)[] = new Array<TicketDetail | undefined>(dirs.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        throwIfAborted(call);
        const i = next;
        next += 1;
        const dir = dirs[i];
        if (dir === undefined) {
          return;
        }
        out[i] = await this.readDir(dir);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, dirs.length) }, () => worker()));
    return out.filter((d): d is TicketDetail => d !== undefined).sort((a, b) => a.id.localeCompare(b.id));
  }

  async list(filter: TicketFilter = {}, call: CallOptions = {}): Promise<readonly TicketRecord[]> {
    const all = await this.readAll(call);
    return all.filter((t) => (filter.stage === undefined || t.stage === filter.stage) && (filter.owner === undefined || t.owner === filter.owner));
  }

  async show(id: string, call: CallOptions = {}): Promise<TicketDetail> {
    throwIfAborted(call);
    const dir = this.dirOf(id);
    const detail = await this.readDir(dir);
    if (detail === undefined) {
      throw new TicketStoreError('not-found', `ticket ${id} is not in the store`);
    }
    return detail;
  }

  /** The ticket's comments, oldest first (the file names start with the timestamp). */
  async comments(id: string, call: CallOptions = {}): Promise<readonly TicketComment[]> {
    throwIfAborted(call);
    const dir = path.join(this.dirOf(id), 'comments');
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
    } catch {
      return [];
    }
    const out: TicketComment[] = [];
    for (const name of names) {
      try {
        const doc = parseFlatDocument(await fsp.readFile(path.join(dir, name), 'utf8'));
        out.push({
          author: doc.fields['author'] ?? '',
          at: doc.fields['created_at'] ?? '',
          text: doc.body.replace(/^\r?\n/, '').trimEnd(),
        });
      } catch {
        // A comment that vanished between listing and reading is a write in flight; skip it.
      }
    }
    return out;
  }

  private dirOf(id: string): string {
    const mapped = toDricketId(id);
    if (mapped === null) {
      throw new TicketStoreError('usage', `"${id}" is not a ticket id (expected T-0063)`);
    }
    const [prefix, number] = mapped.split('-') as [string, string];
    const shard = String(Math.floor(Number(number) / 1000)).padStart(4, '0');
    return path.join(this.ticketsRoot, prefix, shard, mapped);
  }

  private async readDir(dir: string): Promise<TicketDetail | undefined> {
    let content: string;
    try {
      content = await fsp.readFile(path.join(dir, 'ticket.md'), 'utf8');
    } catch {
      return undefined;
    }
    return applyLeaseExpiry(detailFromContent(content), this.now());
  }

  /** `<prefix>/<shard>/<id>` directories — three levels, so a stray file anywhere else is ignored. */
  private async ticketDirs(): Promise<string[]> {
    const out: string[] = [];
    for (const prefix of await subdirs(this.ticketsRoot)) {
      for (const shard of await subdirs(prefix)) {
        out.push(...(await subdirs(shard)));
      }
    }
    return out;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function throwIfAborted(call: CallOptions): void {
  if (call.signal?.aborted === true) {
    throw new TicketStoreError('cancelled', 'cancelled');
  }
}
