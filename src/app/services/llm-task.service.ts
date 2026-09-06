import { Injectable, computed, signal } from '@angular/core';
import { formatThinking, formatTook } from '../../../shared/duration';

/** `crypto.randomUUID` in the app; a cheap fallback for test contexts. */
function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** One generation the user can watch and cancel. */
export interface RunningTask {
  readonly id: string;
  /** What it is doing, for the status line ("Summarising", "Thinking"). */
  readonly label: string;
  readonly startedAt: number;
}

/**
 * Tracks LLM generations that are in flight so the UI can show how long one
 * has been running and offer a Cancel.
 *
 * Both halves matter because `/chat/completions` has no timeout any more
 * (`electron/llm-tasks.ts`): the elapsed counter is what tells the user the
 * app is working rather than wedged, and Cancel is what replaces the
 * deadline that used to kill the request for them.
 *
 * The id is minted **here**, before the call is made, because the Cancel
 * button has to exist while the call is still outstanding — waiting for the
 * main process to hand one back would mean nothing is cancellable during
 * exactly the period you would want to cancel.
 *
 * The ticker runs only while something is running, at 1 Hz: it drives a
 * seconds-resolution label, so anything faster is wasted work.
 */
@Injectable({ providedIn: 'root' })
export class LlmTaskService {
  private readonly tasks = signal<readonly RunningTask[]>([]);
  /** Bumped by the ticker so elapsed labels recompute. */
  private readonly now = signal(Date.now());
  private ticker: ReturnType<typeof setInterval> | null = null;

  readonly running = this.tasks.asReadonly();
  readonly isRunning = computed<boolean>(() => this.tasks().length > 0);

  /** The oldest running task -- what the status line describes. */
  readonly current = computed<RunningTask | null>(() => this.tasks()[0] ?? null);

  /** e.g. `Summarising · thinking 12s`, or null when nothing is running. */
  readonly currentLabel = computed<string | null>(() => {
    const task = this.current();
    return task === null ? null : `${task.label} · ${formatThinking(this.now() - task.startedAt)}`;
  });

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /**
   * Runs `work` with a fresh task id, tracking it for the duration.
   * Resolves to whatever `work` returned plus how long it took, so the
   * caller can store "took 8s" alongside the result.
   */
  async run<T>(
    label: string,
    work: (taskId: string) => Promise<T>,
  ): Promise<{
    value: T;
    durationMs: number;
  }> {
    const task: RunningTask = { id: uid(), label, startedAt: Date.now() };
    this.tasks.update((list) => [...list, task]);
    this.startTicker();
    try {
      const value = await work(task.id);
      return { value, durationMs: Date.now() - task.startedAt };
    } finally {
      this.tasks.update((list) => list.filter((entry) => entry.id !== task.id));
      this.stopTickerIfIdle();
    }
  }

  /** Cancels one task, or the current one when no id is given. */
  async cancel(taskId?: string): Promise<void> {
    const id = taskId ?? this.current()?.id;
    if (id) {
      await this.api?.cancelLlmTask?.(id);
    }
  }

  /** How long a finished task took, for a card's footnote. */
  took(durationMs: number): string {
    return formatTook(durationMs);
  }

  private startTicker(): void {
    this.now.set(Date.now());
    if (this.ticker === null && typeof setInterval === 'function') {
      this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
    }
  }

  private stopTickerIfIdle(): void {
    if (this.ticker !== null && this.tasks().length === 0) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}
