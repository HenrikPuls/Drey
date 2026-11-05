/**
 * The `TicketStore` port (E14-1, ADR-0090): the one narrow seam between the
 * engine and wherever tickets live. Two implementations sit behind it —
 * `FileTicketStore` (today's files, wrapped, no behaviour change) and
 * `DricketTicketStore` (the installed `dk` program, called with `--json`).
 *
 * Ids cross the port in Drey's DISPLAY form (`T-0063`); the dricket side maps
 * to `t-63` internally (`store/ids.ts`). The port carries no dricket logic:
 * what `dk` decides (claims, leases, epochs, stages) is only reported.
 *
 * This file is pure types plus the error model — no Node imports.
 */

/** Which implementation backs the port (`tickets.backend`, `files` by default until E14-7). */
export type TicketBackend = 'files' | 'dricket';

export function parseTicketBackend(value: unknown): TicketBackend {
  return value === 'dricket' ? 'dricket' : 'files';
}

/** One ticket's header, normalised. Fields a backend cannot know are null / empty. */
export interface TicketRecord {
  /** Display id (`T-0063`). */
  readonly id: string;
  /** The dricket stage, or the legacy phase id for the file store. */
  readonly stage: string;
  readonly title: string;
  /** Claim owner (`DK_OWNER` identity); null = unclaimed. */
  readonly owner: string | null;
  readonly priority: string | null;
  readonly kind: 'human' | 'agent' | null;
  /** Claim generation (fencing token); null on the file store. */
  readonly epoch: number | null;
  /** Write revision; null on the file store. */
  readonly rev: number | null;
  readonly labels: readonly string[];
  /** Display ids this ticket depends on (dricket `depends`, legacy `blocked-by`). */
  readonly dependsOn: readonly string[];
  /** The ticket this one is a part of (display id); null = a ticket of its own. */
  readonly parent: string | null;
  readonly claimedAt: string | null;
  readonly leaseUntil: string | null;
  readonly size: 'S' | 'M' | 'L' | null;
  readonly branch: string | null;
  readonly repos: readonly string[];
  /** `x-*` extension keys, raw (dricket R-01); empty on the file store. */
  readonly extensions: Readonly<Record<string, string>>;
}

/** A record plus the document it came from. */
export interface TicketDetail extends TicketRecord {
  /** The whole file as stored (front matter included). */
  readonly text: string;
  /** Everything after the front matter. */
  readonly body: string;
}

export interface TicketFilter {
  /** Only this stage. */
  readonly stage?: string;
  /** Only this owner. */
  readonly owner?: string;
}

export interface ClaimOptions {
  /** Who claims (`DK_OWNER`, e.g. `ben.run-42`). */
  readonly actor: string;
  /** Lease size; dricket maps it to a duration. Default `M`. */
  readonly size?: 'S' | 'M' | 'L';
  /** Actor kind; default `agent`. */
  readonly kind?: 'human' | 'agent';
}

export interface Claim {
  readonly id: string;
  /** The fencing token the holder must keep; null on the file store. */
  readonly epoch: number | null;
  readonly leaseUntil: string | null;
  /** The claim replaced an expired / foreign one. */
  readonly takeover: boolean;
}

export interface ReleaseOptions {
  readonly actor: string;
  /** Target stage; omitted = the backend's default. */
  readonly stage?: string;
  readonly message?: string;
}

export interface ReleaseResult {
  readonly id: string;
  readonly stage: string;
}

export interface ExtendOptions {
  readonly actor: string;
  /** Why more time is needed (dricket requires it). */
  readonly reason: string;
}

export interface LeaseExtension {
  readonly id: string;
  readonly epoch: number | null;
  readonly extensions: number | null;
  readonly maxExtensions: number | null;
  readonly leaseUntil: string | null;
}

export interface TicketComment {
  readonly author: string;
  readonly at: string;
  readonly text: string;
}

/** A whole-ticket write (E14-4): the document replaces the stored one in one commit. */
export interface PutOptions {
  /** The `rev` the edit was made on (`--if-version`); a ticket at another rev is `conflict`. */
  readonly expectedRev: number;
  /** Who writes (`DK_OWNER`); omitted = dk's own profile identity. */
  readonly actor?: string;
}

export interface PutResult {
  readonly id: string;
  /** The ticket's `rev` after the write. */
  readonly rev: number;
  readonly commit: string | null;
  /** Header keys the write changed (`rev` excluded), then `body`; empty for a no-op. */
  readonly changedFields: readonly string[];
}

/** What a backend can do — the engine asks instead of guessing from a version. */
export interface StoreCapabilities {
  readonly backend: TicketBackend;
  /** `comments()` works (dricket needs R-08, v0.6). */
  readonly comments: boolean;
  /** `extend()` works (the file store has no leases). */
  readonly leases: boolean;
  /** The backend's own version text (`v0.5.0`), null for files. */
  readonly version: string | null;
}

/** Calls take an optional abort signal (the user cancels; there is no wall-clock timeout on writes). */
export interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface TicketStore {
  readonly backend: TicketBackend;
  capabilities(): Promise<StoreCapabilities>;
  list(filter?: TicketFilter, call?: CallOptions): Promise<readonly TicketRecord[]>;
  show(id: string, call?: CallOptions): Promise<TicketDetail>;
  claim(id: string, options: ClaimOptions, call?: CallOptions): Promise<Claim>;
  release(id: string, options: ReleaseOptions, call?: CallOptions): Promise<ReleaseResult>;
  extend(id: string, options: ExtendOptions, call?: CallOptions): Promise<LeaseExtension>;
  comments(id: string, call?: CallOptions): Promise<readonly TicketComment[]>;
}

/**
 * Why a store call failed. The first ten mirror dricket's documented exit
 * codes (`dk` kinds, 10-19); `usage` is exit 2; the rest are Drey-side.
 */
export type TicketStoreErrorKind =
  | 'not-found' // 10
  | 'claimed' // 11  already taken by someone else
  | 'conflict' // 12  changed in the meantime
  | 'claim-lost' // 13  the epoch moved on: stop the worker
  | 'invalid' // 14  not allowed / does not validate
  | 'network' // 15  store unreachable / outcome unknown
  | 'too-old' // 16  dk (or the store's min_version) too old
  | 'forbidden' // 17
  | 'quota' // 18
  | 'secret' // 19
  | 'usage' // 2   bad invocation (our bug, or no store configured)
  | 'error' // 1   anything else dk reports
  | 'unavailable' // dk not found / not runnable / output not understood
  | 'unsupported' // the backend cannot do this (yet); the message names the requirement
  | 'cancelled'; // the caller aborted

export class TicketStoreError extends Error {
  constructor(
    readonly kind: TicketStoreErrorKind,
    message: string,
    /** The process exit code when the error came from `dk`. */
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'TicketStoreError';
  }
}
