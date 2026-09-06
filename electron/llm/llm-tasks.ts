/**
 * The registry of in-flight LLM generations, so the renderer can cancel one.
 *
 * Why this exists at all: a local model on consumer hardware regularly
 * thinks for minutes, and there is no honest timeout to pick — too short
 * kills legitimate work, too long is indistinguishable from a hang. So
 * `/chat/completions` has **no** deadline (see `LmStudioClient.chat`), and
 * the user gets an explicit Cancel instead. That trade only works if a
 * running request can actually be aborted, which is what this holds.
 *
 * The renderer mints the id (it needs it to render a per-task Cancel
 * before the call returns) and passes it in; `run()` registers an
 * `AbortController` under it for the life of the request.
 */

export class LlmTaskRegistry {
  private readonly running = new Map<string, AbortController>();

  /**
   * Runs `work` with an abort signal registered under `taskId`, clearing
   * the registration when it settles. A `taskId` that is already running is
   * replaced -- ids come from `crypto.randomUUID`, so that only happens if
   * a caller reuses one, and the newer request is the one worth keeping.
   */
  async run<T>(taskId: string | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    if (taskId) {
      this.running.get(taskId)?.abort();
      this.running.set(taskId, controller);
    }
    try {
      return await work(controller.signal);
    } finally {
      if (taskId && this.running.get(taskId) === controller) {
        this.running.delete(taskId);
      }
    }
  }

  /** Aborts a running task. Returns whether there was one to abort. */
  cancel(taskId: string): boolean {
    const controller = this.running.get(taskId);
    if (!controller) {
      return false;
    }
    controller.abort();
    this.running.delete(taskId);
    return true;
  }

  /** Aborts everything (app shutdown). */
  cancelAll(): void {
    for (const controller of this.running.values()) {
      controller.abort();
    }
    this.running.clear();
  }

  get size(): number {
    return this.running.size;
  }
}

/**
 * Whether an error is "the user pressed Cancel" rather than a failure.
 * `fetch` rejects an aborted request with an `AbortError`; Node also
 * surfaces the signal's reason, so both shapes are checked.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  return false;
}

/** The message a cancelled generation reports. */
export const CANCELLED_MESSAGE = 'Generation cancelled.';
