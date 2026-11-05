import { hostname } from 'node:os';

import { TicketStoreError, type Claim, type TicketStore } from '../ports/ticket-store';

/**
 * The run's claim on a dricket ticket (E14-5, ADR-0090 decision 2). One
 * {@link RunLease} per run: the runner claims through `dk` BEFORE the worker
 * spawns, keeps the lease alive while the worker lives, and gives the ticket up
 * with a target stage and a message. Everything about claims is dk's decision —
 * the lease length by size, the epoch, takeover after `lease_until` + grace,
 * the stage rules; this class only sequences the calls and reacts to exit 13
 * (`claim-lost`): the epoch moved on, another actor owns the ticket, the worker
 * must stop and nothing more is written to the ticket.
 *
 * Workers never see `dk` or its identity: the runner is the only caller
 * (ADR-0076's single-writer rule stands).
 */

/** The longest wait before a lease check; also what an unreadable `lease_until` falls back to. */
const FALLBACK_EXTEND_MS = 30 * 60_000;
/** Never extend more often than this, however short the lease. */
const MIN_EXTEND_MS = 30_000;
/** A failed extension (network, busy store) is retried after this. */
const RETRY_EXTEND_MS = 60_000;

/** `agent-<run id>@<host>` in dk's owner grammar (`[a-z0-9._@-]`, requirements Q-02): stable per run, so an adopted run re-claims idempotently. */
export function runOwnerId(runId: string, host: string = hostname()): string {
  const clean = (text: string): string => text.toLowerCase().replaceAll(/[^a-z0-9._-]/g, '-');
  return `agent-${clean(runId)}@${clean(host)}`;
}

/** The commit trailers of protocol.md ("Code repositories"): what `dk validate --trailers` checks. */
export function dricketTrailers(input: {
  readonly dricketId: string;
  readonly epoch: number;
  readonly actor: string;
  readonly op: string;
}): readonly string[] {
  return [
    `Dricket-Ticket: ${input.dricketId}`,
    `Dricket-Epoch: ${input.epoch}`,
    `Dricket-Op: ${input.op}`,
    `Dricket-Actor: ${input.actor}`,
  ];
}

/** The instruction block that makes a worker's commits carry the trailers. */
export function trailerInstruction(trailers: readonly string[]): string {
  return [
    '## Commit trailers',
    '',
    'The ticket store checks every commit of this branch for these trailers. Put them in the',
    'trailer block (the last paragraph) of every commit message you write, unchanged:',
    '',
    ...trailers.map((line) => `    ${line}`),
  ].join('\n');
}

export type LeaseRelease =
  | { readonly ok: true; readonly stage: string }
  | { readonly ok: false; readonly lost: boolean; readonly error: string };

export interface RunLeaseOptions {
  readonly store: TicketStore;
  readonly ticketId: string;
  readonly actor: string;
  readonly runId: string;
  readonly size: 'S' | 'M' | 'L';
  readonly log: (message: string) => void;
  /** Called once when dk reports exit 13: stop the worker, write nothing more. */
  readonly onLost: (why: string) => void;
  readonly now?: () => Date;
  /** Test seam over the timers. */
  readonly timers?: {
    readonly set: (fn: () => void, ms: number) => unknown;
    readonly clear: (handle: unknown) => void;
  };
}

export class RunLease {
  /** The fencing token the claim returned; null before the claim and for a store without epochs. */
  epoch: number | null = null;
  leaseUntil: string | null = null;
  /** True when the claim was a takeover of an expired lease. */
  takeover = false;
  /** The stage the ticket sat in before the claim (dk may have moved it to a claim stage). */
  preStage: string | null = null;
  /** Another actor owns the ticket now: no further call is made. */
  fenced = false;
  /** The ticket was handed back (release / park); the keep-alive is over. */
  released = false;

  private timer: unknown = null;
  private extendStopped = false;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: RunLeaseOptions) {
    this.now = options.now ?? ((): Date => new Date());
    this.setTimer = options.timers?.set ?? ((fn, ms): unknown => setTimeout(fn, ms));
    this.clearTimer = options.timers?.clear ?? ((handle): void => clearTimeout(handle as NodeJS.Timeout));
  }

  get actor(): string {
    return this.options.actor;
  }

  /**
   * `dk claim` — idempotent for the same owner (no commit), a takeover when the
   * previous lease ran out past the grace. Throws the {@link TicketStoreError}
   * of dk (exit 11: someone else holds the ticket). On success the keep-alive runs.
   */
  async claim(): Promise<Claim> {
    try {
      this.preStage = (await this.options.store.show(this.options.ticketId)).stage;
    } catch {
      this.preStage = null; // best effort: only the stay-put release uses it
    }
    const claim = await this.options.store.claim(this.options.ticketId, {
      actor: this.options.actor,
      size: this.options.size,
      kind: 'agent',
    });
    this.epoch = claim.epoch;
    this.leaseUntil = claim.leaseUntil;
    this.takeover = claim.takeover;
    this.released = false;
    this.fenced = false;
    this.extendStopped = false;
    this.options.log(
      `run ${this.options.runId}: claimed ${this.options.ticketId} as ${this.options.actor}` +
        (claim.epoch !== null ? ` (epoch ${claim.epoch}${claim.takeover ? ', takeover of an expired lease' : ''})` : '') +
        (claim.leaseUntil !== null ? `, lease until ${claim.leaseUntil}` : ''),
    );
    this.scheduleExtend();
    return claim;
  }

  /**
   * Hands the ticket back to the first stage dk accepts. `candidates` are tried in
   * order; an `invalid` answer (exit 14: unknown stage, or the agent policy refuses
   * a same-stage release) goes on to the next one. Exit 13 fences the lease.
   *
   * `note` becomes a COMMENT before the release, never `release -m`: dk's `-m` replaces
   * body chapters between `## Result` and `## Log` (dricket requirement R-21, open),
   * and Drey's tickets keep several chapters there.
   */
  async release(candidates: readonly (string | null)[], note: string | null): Promise<LeaseRelease> {
    if (this.fenced) {
      return { ok: false, lost: true, error: 'the claim was lost - nothing is written' };
    }
    this.stopKeepAlive();
    if (note !== null && note !== '') {
      await this.comment(note);
      if (this.fenced) {
        return { ok: false, lost: true, error: 'the claim was lost - nothing is written' };
      }
    }
    const stages = [...new Set(candidates.filter((s): s is string => s !== null && s !== ''))];
    let last = 'no target stage';
    for (const stage of stages.length > 0 ? stages : [undefined]) {
      try {
        const answer = await this.options.store.release(this.options.ticketId, {
          actor: this.options.actor,
          ...(stage === undefined ? {} : { stage }),
        });
        this.released = true;
        return { ok: true, stage: answer.stage };
      } catch (error) {
        if (error instanceof TicketStoreError && error.kind === 'claim-lost') {
          this.fence(error.message);
          return { ok: false, lost: true, error: error.message };
        }
        last = errorText(error);
        if (!(error instanceof TicketStoreError && error.kind === 'invalid')) {
          break; // a network or store failure does not get better with another stage
        }
      }
    }
    return { ok: false, lost: false, error: last };
  }

  /** A comment on the ticket (park notes); a failure is a log line, never a failed run. */
  async comment(text: string): Promise<boolean> {
    if (this.fenced) {
      return false;
    }
    try {
      await this.options.store.comment(this.options.ticketId, text, { actor: this.options.actor });
      return true;
    } catch (error) {
      if (error instanceof TicketStoreError && error.kind === 'claim-lost') {
        this.fence(error.message);
      } else {
        this.options.log(`run ${this.options.runId}: comment on ${this.options.ticketId} failed - ${errorText(error)}`);
      }
      return false;
    }
  }

  stopKeepAlive(): void {
    this.extendStopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Exit 13 seen anywhere: the claim is gone for good. */
  fence(why: string): void {
    if (this.fenced) {
      return;
    }
    this.fenced = true;
    this.stopKeepAlive();
    this.options.onLost(why);
  }

  private scheduleExtend(): void {
    if (this.extendStopped || this.fenced || this.released) {
      return;
    }
    const until = this.leaseUntil === null ? Number.NaN : Date.parse(this.leaseUntil);
    const left = Number.isNaN(until) ? FALLBACK_EXTEND_MS * 2 : until - this.now().getTime();
    this.arm(Math.max(MIN_EXTEND_MS, Math.floor(left / 2)));
  }

  private arm(ms: number): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
    }
    this.timer = this.setTimer(() => void this.extendOnce(), ms);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  private async extendOnce(): Promise<void> {
    this.timer = null;
    if (this.extendStopped || this.fenced || this.released) {
      return;
    }
    try {
      const extended = await this.options.store.extend(this.options.ticketId, {
        actor: this.options.actor,
        reason: `run ${this.options.runId} is still working`,
      });
      this.leaseUntil = extended.leaseUntil ?? this.leaseUntil;
      if (extended.epoch !== null && this.epoch !== null && extended.epoch !== this.epoch) {
        this.fence(`epoch moved from ${this.epoch} to ${extended.epoch}`);
        return;
      }
      this.scheduleExtend();
    } catch (error) {
      if (error instanceof TicketStoreError && error.kind === 'claim-lost') {
        this.fence(error.message);
        return;
      }
      if (error instanceof TicketStoreError && (error.kind === 'invalid' || error.kind === 'forbidden')) {
        // The extension budget is spent: the lease runs out on its own; keep working until dk says no.
        this.options.log(`run ${this.options.runId}: ${this.options.ticketId} lease not extended - ${error.message}`);
        this.extendStopped = true;
        return;
      }
      this.options.log(`run ${this.options.runId}: lease extension of ${this.options.ticketId} failed (retrying) - ${errorText(error)}`);
      this.arm(RETRY_EXTEND_MS);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
