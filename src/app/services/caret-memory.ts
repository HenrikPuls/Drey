/**
 * The remembered viewport of a document (milestone 50): caret (CodeMirror
 * head offset) plus the scroller's raw offset, replayed into every fresh
 * state for that doc key during the app session. `caretRel` -- the caret's
 * offset from the viewport top at capture, when it was rendered -- is what
 * makes the restore EXACT: a fresh state's height map is entirely
 * estimated, so the raw offset alone lands a few lines off; the restore
 * measures the caret's rendered position and corrects by the delta.
 */
export interface CaretMemory {
  head: number;
  scrollTop: number;
  caretRel?: number;
}

/** Oldest entries fall off the caret memory past this many doc keys. */
export const CARET_MEMORY_LIMIT = 200;

/**
 * Caret memory (milestone 50): the last known caret AND scroll offset per
 * doc key, kept for the WHOLE APP SESSION -- deliberately decoupled from
 * the doc records, because a clean tab is REPLACED when another file opens
 * (milestone 32) and the memory must survive that close/reopen cycle too.
 * Purely in-memory: nothing rides into the session snapshot, and a restart
 * starts empty. Bounded FIFO past `limit`.
 */
export class CaretMemoryStore {
  private readonly carets = new Map<string, CaretMemory>();

  constructor(private readonly limit: number = CARET_MEMORY_LIMIT) {}

  record(key: string, memory: CaretMemory): void {
    const prior = this.carets.get(key);
    if (
      prior !== undefined &&
      prior.head === memory.head &&
      prior.scrollTop === memory.scrollTop &&
      prior.caretRel === memory.caretRel
    ) {
      return;
    }
    if (this.carets.size >= this.limit && prior === undefined) {
      const oldest = this.carets.keys().next().value;
      if (oldest !== undefined) {
        this.carets.delete(oldest);
      }
    }
    this.carets.set(key, memory);
  }

  get(key: string): CaretMemory | undefined {
    return this.carets.get(key);
  }
}
