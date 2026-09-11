/**
 * The in-flight generation tracker for the assistant panel — the
 * pre-conversion `LlmTaskService` (`src/app/llm/llm-task.service.ts`) as a
 * plain-JS factory, no Angular. Both halves matter because
 * `/chat/completions` has no timeout (ADR-0014): the elapsed counter is
 * what tells the user the app is working rather than wedged, and Cancel is
 * what replaces the deadline.
 *
 * The id is minted **here**, before the call is made, because the Cancel
 * button has to exist while the call is still outstanding.
 */

/** One generation the user can watch and cancel. */
export interface RunningTask {
  readonly id: string;
  /** What it is doing, for the status line ("Summarising", "Thinking"). */
  readonly label: string;
  readonly startedAt: number;
}

/** `crypto.randomUUID` in the app; a cheap fallback for test contexts. */
export function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface RunningTasks {
  /** True while at least one generation is in flight. */
  isRunning(): boolean;
  /** e.g. `Summarising · thinking 12s`, or null when nothing is running. */
  currentLabel(): string | null;
  /** How long a finished task took, for a card's footnote. */
  took(durationMs: number): string;
  /** Cancels one task, or the current one when no id is given. */
  cancel(taskId?: string): Promise<void>;
  /**
   * Runs `work` with a fresh task id, tracking it for the duration.
   * Resolves to whatever `work` returned plus how long it took.
   */
  run<T>(label: string, work: (taskId: string) => Promise<T>): Promise<{ value: T; durationMs: number }>;
  /** Re-renders are driven by this — the panel subscribes like for state. */
  subscribe(listener: () => void): () => void;
}

export function createRunningTasks(cancelApi: (taskId: string) => Promise<boolean>): RunningTasks {
  let tasks: readonly RunningTask[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const startTicker = (): void => {
    notify();
    if (ticker === null && typeof setInterval === 'function') {
      ticker = setInterval(() => notify(), 1000);
    }
  };

  const stopTickerIfIdle = (): void => {
    if (ticker !== null && tasks.length === 0) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  return {
    isRunning: () => tasks.length > 0,
    currentLabel: () => {
      const task = tasks[0];
      // The label recomputes each read; the 1 Hz ticker drives the re-render.
      return task === undefined ? null : `${task.label} · thinking ${formatDuration(Date.now() - task.startedAt)}`;
    },
    took: (durationMs) => `took ${formatDuration(durationMs)}`,
    cancel: async (taskId) => {
      const id = taskId ?? tasks[0]?.id;
      if (id !== undefined) {
        await cancelApi(id);
      }
    },
    run: async (label, work) => {
      const task: RunningTask = { id: uid(), label, startedAt: Date.now() };
      tasks = [...tasks, task];
      startTicker();
      try {
        const value = await work(task.id);
        return { value, durationMs: Date.now() - task.startedAt };
      } finally {
        tasks = tasks.filter((entry) => entry.id !== task.id);
        stopTickerIfIdle();
        notify();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** `8s`, `59s`, `1m 04s`. Sub-second rounds up to `1s` (shared/duration.ts copy). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
