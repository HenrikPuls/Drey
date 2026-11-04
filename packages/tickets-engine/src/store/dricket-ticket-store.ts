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
import { DkProcess } from './dk-process';
import { flatInt, flatList, flatText, parseFlatDocument } from './flat-frontmatter';
import { toDisplayId, toDricketId } from './ids';

/**
 * `TicketStore` over the installed `dk` (E14-1, ADR-0090). Every operation is
 * one `dk --json` call; nothing of dricket's logic is re-implemented here.
 *
 * What dk v0.5 cannot do is reported, not worked around: `ls` carries only the
 * header subset (R-05), `show` returns the raw file (R-06) and there is no
 * comment list (R-08) — see `docs/design/dricket/dricket-requirements.md`.
 */
export class DricketTicketStore implements TicketStore {
  readonly backend = 'dricket' as const;

  constructor(private readonly dk: DkProcess) {}

  async capabilities(): Promise<StoreCapabilities> {
    const version = await this.dk.version();
    return { backend: 'dricket', comments: false, leases: true, version };
  }

  async list(filter: TicketFilter = {}, call: CallOptions = {}): Promise<readonly TicketRecord[]> {
    const args = ['ls'];
    if (filter.stage !== undefined) {
      args.push('-s', filter.stage);
    }
    if (filter.owner !== undefined) {
      args.push('-o', filter.owner);
    }
    const data = asObject(await this.dk.call(args, { write: false, ...signalOf(call) }), 'ls');
    // An empty store answers `"tickets": null`, not `[]` (observed on v0.5.0).
    const rows = data['tickets'];
    if (rows === null || rows === undefined) {
      return [];
    }
    if (!Array.isArray(rows)) {
      throw malformed('ls', 'tickets is not a list');
    }
    return rows.map((row) => recordFromListRow(asObject(row, 'ls row')));
  }

  async show(id: string, call: CallOptions = {}): Promise<TicketDetail> {
    const data = asObject(await this.dk.call(['show', dricketId(id)], { write: false, ...signalOf(call) }), 'show');
    const content = data['content'];
    if (typeof content !== 'string') {
      throw malformed('show', 'content is missing');
    }
    return detailFromContent(content);
  }

  async claim(id: string, options: ClaimOptions, call: CallOptions = {}): Promise<Claim> {
    const args = ['claim', '--size', options.size ?? 'M', '--kind', options.kind ?? 'agent', dricketId(id)];
    const data = asObject(await this.dk.call(args, { write: true, actor: options.actor, ...signalOf(call) }), 'claim');
    return {
      id: displayOf(data),
      epoch: numberOrNull(data['epoch']),
      leaseUntil: textOrNull(data['lease_until']),
      takeover: data['takeover'] === true,
    };
  }

  async release(id: string, options: ReleaseOptions, call: CallOptions = {}): Promise<ReleaseResult> {
    const args = ['release'];
    if (options.stage !== undefined) {
      args.push('--stage', options.stage);
    }
    if (options.message !== undefined && options.message !== '') {
      args.push('-m', options.message);
    }
    args.push(dricketId(id));
    const data = asObject(await this.dk.call(args, { write: true, actor: options.actor, ...signalOf(call) }), 'release');
    return { id: displayOf(data), stage: textOrNull(data['stage']) ?? options.stage ?? '' };
  }

  async extend(id: string, options: ExtendOptions, call: CallOptions = {}): Promise<LeaseExtension> {
    const data = asObject(
      await this.dk.call(['extend', '-m', options.reason, dricketId(id)], { write: true, actor: options.actor, ...signalOf(call) }),
      'extend',
    );
    return {
      id: displayOf(data),
      epoch: numberOrNull(data['epoch']),
      extensions: numberOrNull(data['extensions']),
      maxExtensions: numberOrNull(data['max_extensions']),
      leaseUntil: textOrNull(data['lease_until']),
    };
  }

  comments(): Promise<readonly TicketComment[]> {
    return Promise.reject(
      new TicketStoreError(
        'unsupported',
        'dk has no way to list comments yet (dricket requirement R-08, planned for v0.6); comments can be added but not read back',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Mapping (header subset -> record; whole file -> detail)

function recordFromListRow(row: Record<string, unknown>): TicketRecord {
  const owner = textOrNull(row['owner']);
  return {
    id: displayOf(row),
    stage: textOrNull(row['stage']) ?? '',
    title: textOrNull(row['title']) ?? '',
    owner,
    priority: textOrNull(row['priority']),
    kind: kindOf(textOrNull(row['kind'])),
    epoch: numberOrNull(row['epoch']),
    rev: numberOrNull(row['rev']),
    labels: typeof row['labels'] === 'string' ? flatList(row['labels']) : [],
    dependsOn: [],
    claimedAt: null,
    leaseUntil: null,
    size: null,
    branch: null,
    repos: [],
    extensions: {},
  };
}

/** The whole-file form: `dk show --json` carries the raw document (R-06 will add parsed fields). */
export function detailFromContent(content: string): TicketDetail {
  const doc = parseFlatDocument(content);
  const f = doc.fields;
  const extensions: Record<string, string> = {};
  for (const [key, value] of Object.entries(f)) {
    if (key.startsWith('x-')) {
      extensions[key] = value;
    }
  }
  const size = f['size'];
  return {
    id: toDisplayId(f['id'] ?? ''),
    stage: f['stage'] ?? '',
    title: f['title'] ?? '',
    owner: flatText(f['owner']),
    priority: flatText(f['priority']),
    kind: kindOf(flatText(f['kind'])),
    epoch: flatInt(f['epoch']),
    rev: flatInt(f['rev']),
    labels: flatList(f['labels']),
    dependsOn: flatList(f['depends']).map(toDisplayId),
    claimedAt: flatText(f['claimed_at']),
    leaseUntil: flatText(f['lease_until']),
    size: size === 'S' || size === 'M' || size === 'L' ? size : null,
    branch: flatText(f['branch']),
    repos: flatList(f['repos']),
    extensions,
    text: content,
    body: doc.body,
  };
}

function dricketId(id: string): string {
  const mapped = toDricketId(id);
  if (mapped === null) {
    throw new TicketStoreError('usage', `"${id}" is not a ticket id (expected T-0063)`);
  }
  return mapped;
}

function displayOf(data: Record<string, unknown>): string {
  const id = data['id'];
  if (typeof id !== 'string') {
    throw malformed('answer', 'id is missing');
  }
  return toDisplayId(id);
}

function kindOf(value: string | null): 'human' | 'agent' | null {
  return value === 'human' || value === 'agent' ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function signalOf(call: CallOptions): { signal?: AbortSignal } {
  return call.signal === undefined ? {} : { signal: call.signal };
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(what, 'not an object');
  }
  return value as Record<string, unknown>;
}

function malformed(what: string, why: string): TicketStoreError {
  return new TicketStoreError('unavailable', `dk ${what}: unexpected output (${why})`);
}
