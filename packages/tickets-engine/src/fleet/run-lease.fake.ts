import {
  TicketStoreError,
  type Claim,
  type ClaimOptions,
  type CommentOptions,
  type ExtendOptions,
  type LeaseExtension,
  type ReleaseOptions,
  type ReleaseResult,
  type TicketDetail,
  type TicketStore,
} from '../ports/ticket-store';

/** What the fake store saw, in order: `claim`, `show`, `extend`, `comment`, `release`. */
export interface StoreCall {
  readonly op: 'show' | 'claim' | 'extend' | 'comment' | 'release';
  readonly id: string;
  readonly actor?: string;
  readonly stage?: string;
  readonly text?: string;
  readonly size?: string;
}

/**
 * A scripted dricket store for the lease and the run supervisor specs: records every call,
 * answers like dk (epoch rises per claim, exit 14 for stages not in `stages`, exit 13 once
 * `loseClaim()` was called) and lets a spec fail one operation.
 */
export class FakeStore implements TicketStore {
  readonly backend = 'dricket' as const;
  readonly calls: StoreCall[] = [];
  epoch = 1;
  stage = 'prioritized';
  leaseUntil = '2026-10-17T14:00:00Z';
  /** Stages a release accepts; others answer `invalid` (exit 14). */
  stages: readonly string[] = ['inbox', 'prioritized', 'build', 'commit', 'done'];
  /** A release to the stage the ticket is in is refused (dk: an agent may not release `build -> build`). */
  claimStage = 'build';
  private lost = false;
  private failures = new Map<string, TicketStoreError>();

  /** The next claim fails with this error (exit 11 for a ticket someone else holds). */
  failNext(op: StoreCall['op'], error: TicketStoreError): void {
    this.failures.set(op, error);
  }

  /** From now on every call answers exit 13 (another actor took the ticket over). */
  loseClaim(): void {
    this.lost = true;
  }

  of(op: StoreCall['op']): StoreCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  private check(op: StoreCall['op']): void {
    const failure = this.failures.get(op);
    if (failure !== undefined) {
      this.failures.delete(op);
      throw failure;
    }
    if (this.lost && op !== 'show') {
      throw new TicketStoreError('claim-lost', 'claim lost: epoch 2 holds the ticket now', 13);
    }
  }

  capabilities(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  list(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  show(id: string): Promise<TicketDetail> {
    this.calls.push({ op: 'show', id });
    return Promise.resolve({ id, stage: this.stage, text: '', body: '' } as unknown as TicketDetail);
  }

  claim(id: string, options: ClaimOptions): Promise<Claim> {
    this.calls.push({ op: 'claim', id, actor: options.actor, ...(options.size === undefined ? {} : { size: options.size }) });
    try {
      this.check('claim');
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve({ id, epoch: this.epoch, leaseUntil: this.leaseUntil, takeover: false });
  }

  release(id: string, options: ReleaseOptions): Promise<ReleaseResult> {
    this.calls.push({ op: 'release', id, actor: options.actor, ...(options.stage === undefined ? {} : { stage: options.stage }) });
    try {
      this.check('release');
    } catch (error) {
      return Promise.reject(error);
    }
    const stage = options.stage ?? 'review';
    if (!this.stages.includes(stage)) {
      return Promise.reject(new TicketStoreError('invalid', `stage "${stage}" is not one of ${this.stages.join(', ')}`, 14));
    }
    if (stage === this.claimStage) {
      return Promise.reject(new TicketStoreError('invalid', `agent may not release ${id} from ${stage} to ${stage}`, 14));
    }
    return Promise.resolve({ id, stage });
  }

  extend(id: string, options: ExtendOptions): Promise<LeaseExtension> {
    this.calls.push({ op: 'extend', id, actor: options.actor, text: options.reason });
    try {
      this.check('extend');
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve({ id, epoch: this.epoch, extensions: 1, maxExtensions: 3, leaseUntil: this.leaseUntil });
  }

  comment(id: string, text: string, options: CommentOptions): Promise<void> {
    this.calls.push({ op: 'comment', id, actor: options.actor, text });
    try {
      this.check('comment');
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  comments(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

/** A manual clock for the lease's keep-alive: `fire()` runs the armed callback. */
export class FakeTimers {
  armed: { fn: () => void; ms: number } | null = null;
  readonly delays: number[] = [];
  readonly set = (fn: () => void, ms: number): unknown => {
    this.armed = { fn, ms };
    this.delays.push(ms);
    return this.armed;
  };
  readonly clear = (handle: unknown): void => {
    if (this.armed === handle) {
      this.armed = null;
    }
  };

  async fire(): Promise<void> {
    const armed = this.armed;
    this.armed = null;
    armed?.fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}
