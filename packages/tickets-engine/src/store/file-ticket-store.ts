import { parseTicketFile, patchTicketFile, ticketPathParts } from '../core/ticket-files';
import type { TicketMeta } from '../contracts/tickets';
import {
  TicketStoreError,
  type CallOptions,
  type Claim,
  type ClaimOptions,
  type ExtendOptions,
  type LeaseExtension,
  type ReleaseOptions,
  type ReleaseResult,
  type StoreCapabilities,
  type TicketComment,
  type TicketDetail,
  type TicketFilter,
  type TicketRecord,
  type TicketStore,
} from '../ports/ticket-store';

/**
 * The file IO the wrapper needs — the engine host's file API plus the git
 * step (`EngineHost.read/write/listMarkdownFiles` + the board's commit).
 * Paths are vault-relative (`tickets/<phase>/T-0063.md`).
 */
export interface FileTicketIo {
  /** Every markdown path in the tickets vault. */
  listMarkdownFiles(): Promise<readonly string[]>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** One commit for exactly these paths; a warning text or null. */
  commit(paths: readonly string[], message: string): Promise<string | null>;
  announce(paths: readonly string[]): void;
}

/**
 * `TicketStore` over today's ticket files (E14-1): reads go through
 * `parseTicketFile`, the claim operations through `patchTicketFile` exactly as
 * `EngineBoardService.setClaim` does them (stamp / clear `claimed-by` +
 * `claimed-at`, one Log line, one commit). No behaviour change — this is the
 * `files` backend seen through the port, so both stores can be driven by the
 * same contract.
 *
 * Not on the port for files: leases (`extend`), stage moves through `release`
 * (a move is the transition machine's job), comments (legacy tickets carry a
 * `## Log`, not comments). The write operations are not yet called by the
 * board service — they move behind the port in E14-4.
 */
export class FileTicketStore implements TicketStore {
  readonly backend = 'files' as const;

  constructor(private readonly io: FileTicketIo) {}

  capabilities(): Promise<StoreCapabilities> {
    return Promise.resolve({ backend: 'files', comments: false, leases: false, version: null });
  }

  async list(filter: TicketFilter = {}): Promise<readonly TicketRecord[]> {
    const found = await this.readAll();
    return found
      .map((f) => f.record)
      .filter((r) => (filter.stage === undefined || r.stage === filter.stage) && (filter.owner === undefined || r.owner === filter.owner));
  }

  async show(id: string): Promise<TicketDetail> {
    const found = await this.find(id);
    const split = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(found.text);
    return { ...found.record, text: found.text, body: split === null ? found.text : found.text.slice(split[0].length) };
  }

  async claim(id: string, options: ClaimOptions): Promise<Claim> {
    const found = await this.find(id);
    if (found.record.owner === options.actor) {
      throw new TicketStoreError('claimed', 'you already hold this claim');
    }
    const previous = found.record.owner;
    await this.stamp(found, options.actor, `claim takeover${previous !== null ? ` (was ${previous})` : ''}`, { claimBy: options.actor }, 'claim takeover');
    return { id: found.record.id, epoch: null, leaseUntil: null, takeover: previous !== null };
  }

  async release(id: string, options: ReleaseOptions): Promise<ReleaseResult> {
    const found = await this.find(id);
    if (options.stage !== undefined && options.stage !== found.record.stage) {
      throw new TicketStoreError('unsupported', 'a stage move is a ticket transition, not a release, on the files backend');
    }
    if (found.record.owner === null) {
      throw new TicketStoreError('invalid', 'this ticket is not claimed');
    }
    await this.stamp(found, options.actor, 'claim release', { releaseClaim: true }, 'claim release');
    return { id: found.record.id, stage: found.record.stage };
  }

  extend(_id: string, _options: ExtendOptions): Promise<LeaseExtension> {
    return Promise.reject(new TicketStoreError('unsupported', 'the files backend has no leases to extend'));
  }

  comments(_id: string, _call?: CallOptions): Promise<readonly TicketComment[]> {
    return Promise.resolve([]);
  }

  // ---------------------------------------------------------------------

  private async readAll(): Promise<FoundTicket[]> {
    const paths = (await this.io.listMarkdownFiles()).filter((p) => p.startsWith('tickets/') && !p.startsWith('tickets/_meta/') && ticketPathParts(p) !== null);
    const out: FoundTicket[] = [];
    for (const path of paths) {
      const text = await this.io.read(path);
      const parsed = parseTicketFile(text, path);
      const parts = ticketPathParts(path)!;
      out.push({ path, text, record: recordOf(parsed.meta, parts.stem, parts.phase) });
    }
    return out;
  }

  private async find(id: string): Promise<FoundTicket> {
    const found = (await this.readAll()).find((f) => f.record.id === id);
    if (found === undefined) {
      throw new TicketStoreError('not-found', `${id} is not on the board`);
    }
    return found;
  }

  private async stamp(
    found: FoundTicket,
    actor: string,
    action: string,
    claim: { claimBy: string } | { releaseClaim: true },
    commitWord: string,
  ): Promise<void> {
    let patched: string;
    try {
      patched = patchTicketFile(found.text, { to: found.record.stage, from: null, now: new Date(), actor, action, ...claim });
    } catch (error) {
      throw new TicketStoreError('invalid', error instanceof Error ? error.message : String(error));
    }
    await this.io.write(found.path, patched);
    await this.io.commit([found.path], `tickets: ${found.record.id} ${commitWord}`);
    this.io.announce([found.path]);
  }
}

interface FoundTicket {
  readonly path: string;
  readonly text: string;
  readonly record: TicketRecord;
}

function recordOf(meta: TicketMeta, stem: string, phase: string): TicketRecord {
  return {
    id: meta.id ?? stem,
    stage: phase,
    title: meta.title ?? '',
    owner: meta.claimedBy,
    priority: meta.priority,
    kind: null,
    epoch: null,
    rev: null,
    labels: [],
    dependsOn: meta.blockedBy,
    claimedAt: meta.claimedAt,
    leaseUntil: null,
    size: null,
    branch: meta.branch,
    repos: meta.repos,
    extensions: {},
  };
}
