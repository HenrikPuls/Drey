import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { EXTERNAL_KEY_PREFIX } from '../../../shared/external-open';
import { VaultService } from '../vault';
import { EditorService } from './editor.service';

/** Separates the vault id from the vault-relative path in a tab key (see `docKey`). */
const VAULT_KEY_SEPARATOR = '::';

/** The pointer-based history: tab keys oldest-first, `index` = current doc. */
interface HistoryState {
  readonly entries: readonly string[];
  readonly index: number;
}

/**
 * Back/forward navigation over the documents viewed this session (the
 * titlebar arrows, Alt+Left / Alt+Right) -- the editor analogue of a
 * browser's history: ONE global, pointer-based list of tab keys, however
 * many panes are split. Purely in-memory like the caret memory
 * (milestone 50); nothing rides into the session snapshot.
 *
 * Recording is a single `effect` over `EditorService.activePath()`, so
 * every activation pushes -- Files tree, calendar, search hit, wikilink,
 * tab click, pane focus flip (the VS Code model). The pointer moves on
 * `back()`/`forward()`; a NEW activation truncates the forward branch,
 * exactly like a browser. Bounded circularly at {@link HISTORY_LIMIT}:
 * past the limit the oldest entry falls off.
 *
 * Two guards keep navigation itself out of the recording: `suspended`
 * around the App-startup mass-opens (session restore, OS-collected files,
 * the daily-note fallback -- `resume()` then seeds the doc the user
 * actually landed on as the base entry), and the `nav` counter while a
 * `back()`/`forward()` activation is in flight.
 *
 * Going back to a doc whose tab was since closed REOPENS it (a vault file
 * via `openFile`, an external one via `openExternalFile`); entries that
 * cannot be restored -- scratch tabs, registered plugin doc kinds --
 * are pruned and skipped. Known simplification: a rename retargets pane
 * placement but not history entries; a stale key just fails its reopen
 * attempt and is pruned the same way.
 */
@Injectable({ providedIn: 'root' })
export class DocHistoryService {
  /** Oldest entries fall off the history past this many documents. */
  static readonly HISTORY_LIMIT = 100;

  /** Overridable in specs (kept beside the static like `CARET_MEMORY_LIMIT`). */
  protected limit = DocHistoryService.HISTORY_LIMIT;

  private readonly state = signal<HistoryState>({ entries: [], index: -1 });

  /** A back step exists (an entry left of the pointer). */
  readonly canBack = computed(() => this.state().index > 0);
  /** A forward step exists (an entry right of the pointer). */
  readonly canForward = computed(() => {
    const s = this.state();
    return s.index >= 0 && s.index < s.entries.length - 1;
  });

  /** For tests and status surfaces: how many documents the history holds. */
  readonly size = computed(() => this.state().entries.length);

  /** The visited tab keys, most recent first, each once (the quick switcher's empty-query order). */
  recentKeys(): string[] {
    return [...new Set([...this.state().entries].reverse())];
  }

  /** Set around App startup; recording resumes with a fresh seed. */
  private suspended = false;
  /** Held while a back/forward activation is in flight (across awaits). */
  private nav = 0;
  /** Back/forward steps serialize, so rapid clicks step one at a time. */
  private queue: Promise<void> = Promise.resolve();

  private readonly editor = inject(EditorService);
  private readonly vault = inject(VaultService);

  constructor() {
    effect(() => {
      const key = this.editor.activePath();
      if (key === null || this.suspended || this.nav > 0) {
        return;
      }
      this.push(key);
    });
  }

  /** Stops recording while the startup flows mass-open tabs (App calls this). */
  suspend(): void {
    this.suspended = true;
  }

  /**
   * Resumes recording and seeds the document the startup flows landed on
   * as the base entry -- "back" from the first real navigation then leads
   * there, and nowhere into the restore churn. Idempotent.
   */
  resume(): void {
    if (!this.suspended) {
      return;
    }
    this.suspended = false;
    const key = this.editor.activePath();
    this.state.set(key !== null ? { entries: [key], index: 0 } : { entries: [], index: -1 });
  }

  /** One step back (Alt+Left). No-op when there is nothing to go back to. */
  back(): Promise<void> {
    return this.enqueue(-1);
  }

  /** One step forward (Alt+Right), after at least one back step. */
  forward(): Promise<void> {
    return this.enqueue(1);
  }

  private enqueue(dir: -1 | 1): Promise<void> {
    const run = this.queue.then(() => this.step(dir));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Walks the pointer one step in `dir` to the nearest SHOWABLE entry:
   * still-open docs activate, closed ones reopen, unrestorable ones are
   * pruned and stepped over. The (possibly pruned) state is written back
   * whatever the outcome. The `nav` guard spans the whole walk, so the
   * activation this causes never records itself; if the user clicked
   * elsewhere while a reopen was in flight, that activation reconciles in
   * as the newest entry after the walk.
   */
  private async step(dir: -1 | 1): Promise<void> {
    const cur = this.state();
    if (cur.entries.length === 0 || cur.index < 0) {
      return;
    }
    const entries = [...cur.entries];
    let index = cur.index;
    this.nav++;
    try {
      for (;;) {
        const next = index + dir;
        if (next < 0 || next >= entries.length) {
          break;
        }
        if (await this.show(entries[next])) {
          index = next;
          break;
        }
        // Dead entry: drop it. Removing left of the pointer shifts the
        // pointer left with it (the current doc is entries[index]); to the
        // right the next candidate simply slides into `next`.
        entries.splice(next, 1);
        if (dir === -1) {
          index = next;
        }
      }
    } finally {
      this.nav--;
    }
    const actual = this.editor.activePath();
    if (actual !== null && actual !== entries[index]) {
      this.push(actual);
      return;
    }
    this.state.set({ entries, index });
  }

  /** Makes `key` the active document; `false` when it cannot be shown. */
  private async show(key: string): Promise<boolean> {
    if (this.editor.docFor(key) !== null) {
      this.editor.activate(key);
      return true;
    }
    return this.reopen(key);
  }

  /**
   * Reopens a closed document from its tab key: `external://<path>` via the
   * gated external read, `vaultId::path` via a vault-scoped `openFile` --
   * `keepFocused` so the step never closes the tab we are leaving (history
   * navigation is a view switch, not a clean-tab replace). Bare keys
   * (scratch tabs, plugin doc kinds) have nothing on disk to reopen.
   */
  private async reopen(key: string): Promise<boolean> {
    if (key.startsWith(EXTERNAL_KEY_PREFIX)) {
      const absolutePath = key.slice(EXTERNAL_KEY_PREFIX.length);
      if (absolutePath === '') {
        return false;
      }
      await this.editor.openExternalFile(absolutePath);
      return this.editor.docFor(key) !== null;
    }
    const sep = key.indexOf(VAULT_KEY_SEPARATOR);
    if (sep <= 0) {
      return false;
    }
    const vaultId = key.slice(0, sep);
    const path = key.slice(sep + VAULT_KEY_SEPARATOR.length);
    if (path === '' || !this.vault.vaults().some((v) => v.id === vaultId)) {
      return false;
    }
    await this.editor.openFile(path, vaultId, { keepFocused: true });
    return this.editor.docFor(key) !== null;
  }

  /** Records an activation: truncate the forward branch, append, respect the limit. */
  private push(key: string): void {
    const cur = this.state();
    if (cur.entries[cur.index] === key) {
      return;
    }
    const entries = cur.entries.slice(0, cur.index + 1);
    entries.push(key);
    let index = entries.length - 1;
    if (entries.length > this.limit) {
      entries.shift();
      index--;
    }
    this.state.set({ entries, index });
  }
}
