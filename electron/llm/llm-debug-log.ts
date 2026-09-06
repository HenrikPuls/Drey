/**
 * In-memory ring buffer of LLM HTTP exchanges, surfaced in the LLM
 * settings pane so the traffic between this app and the model server is
 * inspectable and reproducible with `curl`.
 *
 * Main-process only and deliberately **not** persisted: it holds request
 * bodies (i.e. note content) and is a debugging aid for the current
 * session, not an audit trail. Entries arrive with the bearer token
 * already masked (`shared/llm-debug.ts`); the real key never leaves
 * `AppConfigStore`.
 */
import { LlmDebugEntry } from '../../shared/llm';

/** Enough to see a connection test plus a couple of real calls; bounded so a long session can't grow without limit. */
const MAX_ENTRIES = 50;

export class LlmDebugLog {
  private entries: LlmDebugEntry[] = [];
  private nextId = 1;
  private listeners = new Set<(entry: LlmDebugEntry) => void>();

  /** Appends an entry (assigning its id) and notifies listeners. */
  record(entry: Omit<LlmDebugEntry, 'id'>): LlmDebugEntry {
    const full: LlmDebugEntry = { ...entry, id: this.nextId++ };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    for (const listener of this.listeners) {
      listener(full);
    }
    return full;
  }

  /** Oldest first. */
  all(): LlmDebugEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }

  /** Subscribe to new entries (the main -> renderer push). Returns an unsubscribe. */
  onEntry(listener: (entry: LlmDebugEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
