/**
 * Who of Drey is still here (req-110). Every Drey instance holds one
 * `/api/events` stream for as long as its tickets plugin lives; the
 * engine outlives Drey, so the stream closing is how the engine learns
 * that Drey quit — cleanly or not. When the last one goes, the engine asks
 * the runner to retire if idle. The grace span outlasts the client's 2 s
 * reconnect, so a dropped-and-reopened stream does not pass for a quit;
 * a second instance (`DREY_MULTI_INSTANCE`) still subscribed holds the
 * count above zero. The phone never counts: it reaches the engine through
 * the gateway, and the runner serves it with Drey closed by design.
 */
export class DreyPresence {
  private count = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onLastGone: () => void,
    private readonly graceMs: number,
  ) {}

  /** A Drey event stream opened. Returns the matching close. */
  attach(): () => void {
    this.count += 1;
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    let open = true;
    return () => {
      if (!open) {
        return;
      }
      open = false;
      this.count -= 1;
      if (this.count === 0) {
        this.pending = setTimeout(() => {
          this.pending = null;
          if (this.count === 0) {
            this.onLastGone();
          }
        }, this.graceMs);
        this.pending.unref?.();
      }
    };
  }

  get connected(): number {
    return this.count;
  }

  dispose(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }
}
