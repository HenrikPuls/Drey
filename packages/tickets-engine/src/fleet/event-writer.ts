/**
 * The runner's E7 event writer (concept §3.3): appends to the fleet
 * ledger (`tickets/_meta/ledger.jsonl`) and the per-ticket status log
 * (`<card>.md` → `<card>.status.log`). Every write is fire-and-forget —
 * the caller never awaits, a failure lands in the runner's log and never
 * throws, and NO git commit happens per line: the files ride along with
 * the next regular commit, which sweeps them into the history like every
 * other vault change. A per-writer promise mutex serializes the
 * read-modify-append so two events of one burst cannot interleave.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { LEDGER_FILE, renderLedgerLine, type LedgerWrite } from '../core/ledger';
import { appendStatusLine, type StatusVerb } from '../core/status-log';
import { listTicketDirs } from '../core/phase-dirs';

export interface FleetEventWriterDeps {
  /** The tickets vault root (the runner reads it directly). */
  readonly vaultPath: string;
  /** The runner's log — the only place a swallowed failure surfaces. */
  readonly log: (message: string) => void;
}

/**
 * One ticket's status-log path beside its card: `…/T-0001.md` →
 * `…/T-0001.status.log`. Idempotent on the result (a path that already
 * ends `.status.log` stands); any other non-`.md` path gets the suffix
 * appended — the writer refuses to guess what the caller meant.
 */
export function statusLogPathOf(cardPath: string): string {
  if (cardPath.endsWith('.status.log')) {
    return cardPath;
  }
  return cardPath.endsWith('.md') ? `${cardPath.slice(0, -'.md'.length)}.status.log` : `${cardPath}.status.log`;
}

/**
 * The card path of `ticketId` somewhere in the vault's phase dirs
 * (`tickets/<dir>/<id>.md`, vault-relative) — the runner-side fallback
 * behind the orchestrator's `cardPathOf` seam, for settles whose record
 * predates the path. `archive` and `_meta` hold no board cards. The scan
 * is cached for {@link SCAN_CACHE_MS}: a settle storm must not re-read
 * the directories per event; a ticket that appears within the cache
 * window is found on the next call after it.
 */
export async function statusPathFor(vaultPath: string, ticketId: string): Promise<string | null> {
  const key = JSON.stringify([vaultPath, ticketId]);
  const hit = scanCache.get(key);
  if (hit !== undefined && Date.now() - hit.atMs < SCAN_CACHE_MS) {
    return hit.result;
  }
  const result = await scanForCard(vaultPath, ticketId);
  if (scanCache.size > 1_000) {
    for (const [entryKey, entry] of scanCache) {
      if (Date.now() - entry.atMs >= SCAN_CACHE_MS) {
        scanCache.delete(entryKey);
      }
    }
  }
  scanCache.set(key, { atMs: Date.now(), result });
  return result;
}

/** How long a statusPathFor scan answers stay fresh before the dirs re-scan. */
export const SCAN_CACHE_MS = 5_000;

const scanCache = new Map<string, { atMs: number; result: string | null }>();

async function scanForCard(vaultPath: string, ticketId: string): Promise<string | null> {
  const ticketsRoot = path.join(vaultPath, 'tickets');
  const dirs = await listTicketDirs(ticketsRoot);
  for (const dir of dirs) {
    if (dir === '_meta' || dir === 'archive') {
      continue;
    }
    const there = await fsp.access(path.join(ticketsRoot, dir, `${ticketId}.md`)).then(
      () => true,
      () => false,
    );
    if (there) {
      return `tickets/${dir}/${ticketId}.md`;
    }
  }
  return null;
}

export class FleetEventWriter {
  /** The per-writer mutex tail: every op queues behind the previous one. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: FleetEventWriterDeps) {}

  /** Appends one ledger line; the file may be absent (the first line starts it). */
  ledger(write: LedgerWrite): void {
    this.enqueue(async () => {
      const file = path.join(this.deps.vaultPath, LEDGER_FILE);
      const existing = await fsp.readFile(file, 'utf8').catch(() => null);
      // A torn tail (no trailing newline) would glue the new line onto it.
      const prefix = existing !== null && existing !== '' && !existing.endsWith('\n') ? '\n' : '';
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${prefix}${renderLedgerLine(new Date().toISOString(), write)}`, 'utf8');
    }, `ledger ${write.kind} ${write.ticket}`);
  }

  /** Appends one status line to the ticket's log, creating it on first use. */
  status(cardPath: string, at: string, verb: StatusVerb, payload: string): void {
    this.enqueue(async () => {
      const file = path.join(this.deps.vaultPath, statusLogPathOf(cardPath));
      const existing = await fsp.readFile(file, 'utf8').catch(() => '');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, appendStatusLine(existing, at, verb, payload), 'utf8');
    }, `status ${verb} ${cardPath}`);
  }

  /** Fire-and-forget: failures log and swallow, never throw into the caller. */
  private enqueue(op: () => Promise<void>, what: string): void {
    this.tail = this.tail.then(op).catch((error: unknown) => {
      this.deps.log(`event writer: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
