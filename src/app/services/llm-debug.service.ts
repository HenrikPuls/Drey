import { Injectable, signal } from '@angular/core';
import { LlmDebugEntry } from '../../../shared/ipc-api';

/**
 * The LLM traffic log shown at the bottom of the LLM settings pane. Holds
 * the entries the main process has recorded this session and appends new
 * ones live via the `llm:debug-entry` push.
 *
 * Same shape as the other IPC-backed services: call the bridge, keep the
 * result in a signal, no logic. Entries arrive with the bearer token
 * already masked (`shared/llm-debug.ts`) -- the real key stays in the main
 * process and is only re-inserted, in the renderer, when the user asks for
 * a copyable `curl`.
 */
@Injectable({ providedIn: 'root' })
export class LlmDebugService {
  readonly entries = signal<LlmDebugEntry[]>([]);

  /**
   * Why the log itself could not be loaded. Surfaced rather than swallowed:
   * an empty panel used to be indistinguishable from "the IPC channel isn't
   * there", which is exactly what a stale main process looks like
   * (docs/11, environment gotchas).
   */
  readonly error = signal<string | null>(null);

  private unsubscribe: (() => void) | null = null;

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** Loads the backlog and starts appending live entries. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (!this.api) {
      this.error.set('Not running inside Electron — no LLM bridge available.');
      return;
    }
    if (!this.unsubscribe) {
      this.unsubscribe = this.api.onLlmDebugEntry((entry) => {
        // Merge rather than append: `start()` awaits the backlog, and an
        // entry can land during that await. Keyed by id, so a duplicate
        // between push and backlog collapses instead of showing twice.
        this.entries.update((list) =>
          list.some((e) => e.id === entry.id) ? list : [...list, entry],
        );
      });
    }
    try {
      const backlog = await this.api.getLlmDebugLog();
      this.error.set(null);
      this.entries.update((live) => {
        const byId = new Map(backlog.map((e) => [e.id, e]));
        for (const entry of live) {
          byId.set(entry.id, entry);
        }
        return [...byId.values()].sort((a, b) => a.id - b.id);
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async clear(): Promise<void> {
    this.entries.set([]);
    await this.api?.clearLlmDebugLog();
  }
}
