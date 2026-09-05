import { Injectable, computed, signal } from '@angular/core';
import { formatTime } from '../../../shared/timestamp';

/** Which of the two views (CLAUDE.md: "source/rendered view via tab switch") is showing. */
export type EditorViewMode = 'source' | 'rendered';

/**
 * One open document (one tab). `savedContent` is what's on disk (in `\n`
 * form); `bufferContent` is the live editor buffer; the two differing is
 * what makes the tab dirty.
 *
 * `existsOnDisk` is `false` for a **draft** -- a daily note opened from the
 * calendar for a day that has no file yet. A draft's `savedContent` is the
 * substituted template, so an untouched draft is *not* dirty and `save()`
 * skips it: clicking around the calendar never writes empty notes. The
 * first real edit makes it dirty; the first `save()` writes the file and
 * flips `existsOnDisk`.
 */
export interface OpenDoc {
  /** Vault-relative path, e.g. `daily/2026-09-05.md`. Unique per tab. */
  readonly path: string;
  readonly name: string;
  savedContent: string;
  bufferContent: string;
  viewMode: EditorViewMode;
  /**
   * Last known caret position as a character offset into `bufferContent`.
   * The single value both views sync on in auto-switch mode (ADR-0004):
   * CodeMirror pushes its selection head here, the rendered view reads it
   * to place its DOM caret, and vice versa. `0` until the doc is touched.
   */
  caretOffset: number;
  /** Line ending this file uses on disk; the buffer is always held in `\n`. */
  eol: '\n' | '\r\n';
  /** `modifiedMs` from the last read/write -- round-tripped for the future file watcher. */
  modifiedMs: number;
  existsOnDisk: boolean;
}

/** `localStorage` key for editor-wide preferences (currently just auto-switch). */
const PREFS_KEY = 'drey.editor';

function readAutoSwitch(): boolean {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? Boolean((JSON.parse(raw) as { autoSwitch?: boolean }).autoSwitch) : false;
  } catch {
    return false;
  }
}

function baseName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1] || relativePath;
}

/**
 * Removes a leading YAML frontmatter block (`---` ... `---` as the very
 * first thing in the file) so the rendered view shows the note, not its
 * metadata. Only a fence at offset 0 counts -- a `---` further down is a
 * horizontal rule and stays. The buffer is always held in `\n` form, so a
 * plain `\n` match is enough. Pure and exported for direct testing.
 */
export function stripFrontmatter(text: string): string {
  const match = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/.exec(text);
  return match ? text.slice(match[0].length).replace(/^\n+/, '') : text;
}

/**
 * Holds every open document and which one is active. Same shape as
 * `VaultService`: talk to `window.dreyApi`, keep the result in
 * signals, no logic beyond that (CLAUDE.md, "no business logic inside
 * components"; filesystem access stays in the main process per ADR-0001).
 *
 * Milestone "visual shell" turned this from one-document-at-a-time into a
 * multi-buffer model so the tab bar has something real to drive (see
 * ADR-0003). Switching tabs never prompts -- unsaved buffers are just kept
 * in memory; only closing a dirty tab asks (CLAUDE.md build order, item 5).
 */
@Injectable({ providedIn: 'root' })
export class EditorService {
  private readonly docs = signal<OpenDoc[]>([]);
  private readonly active = signal<string | null>(null);

  /** All open documents, in tab order. */
  readonly openDocs = this.docs.asReadonly();
  /** Vault-relative path of the active tab, or null when nothing is open. */
  readonly activePath = this.active.asReadonly();

  private readonly activeDoc = computed<OpenDoc | null>(
    () => this.docs().find((d) => d.path === this.active()) ?? null,
  );

  /**
   * Vault-relative path of the open file. Kept as the historical name so
   * `App` / `Sidebar` / `DailyNoteService` don't need to care that there's
   * now more than one buffer.
   */
  readonly openPath = computed<string | null>(() => this.activeDoc()?.path ?? null);
  readonly savedContent = computed<string>(() => this.activeDoc()?.savedContent ?? '');
  readonly bufferContent = computed<string>(() => this.activeDoc()?.bufferContent ?? '');
  readonly viewMode = computed<EditorViewMode>(() => this.activeDoc()?.viewMode ?? 'rendered');
  readonly caretOffset = computed<number>(() => this.activeDoc()?.caretOffset ?? 0);

  /**
   * Auto-switch mode (ADR-0004): the rendered view stays put on a click and
   * shows its own caret; typing a character is what drops into source, and
   * a save returns to rendered at the same spot. A per-machine workflow
   * preference (not per document), so it lives in `localStorage` like the
   * pane sizes in `LayoutService`, read synchronously at construction.
   */
  private readonly autoSwitchState = signal(readAutoSwitch());
  readonly autoSwitch = this.autoSwitchState.asReadonly();

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly error = signal<string | null>(null);

  readonly isDirty = computed<boolean>(() => {
    const doc = this.activeDoc();
    return doc !== null && doc.bufferContent !== doc.savedContent;
  });

  /** True while the active tab is a not-yet-written draft (calendar-created daily note). */
  readonly activeIsDraft = computed<boolean>(() => this.activeDoc()?.existsOnDisk === false);

  /**
   * Bumped by the quick-capture hotkey flow (via `DailyNoteService`) to
   * ask the `Editor` component to start a fresh `## HH:mm` entry at the
   * end of the current document. A plain counter rather than a payload:
   * the component computes the actual edit against live CodeMirror state
   * when it handles the request, which sidesteps effect-ordering with the
   * doc-reload that a just-opened file triggers.
   */
  readonly newEntryRequest = signal(0);

  requestNewDailyEntry(): void {
    this.newEntryRequest.update((n) => n + 1);
  }

  /**
   * Pure: given the editor's current text, the insertion needed to start
   * a new daily entry heading (`## HH:mm`), or `null` when the text
   * already ends with an empty entry heading -- pressing the hotkey twice
   * without typing shouldn't stack blank sections. The `Editor` component
   * applies the result to CodeMirror and leaves the buffer dirty (the
   * user saves with Ctrl+S like any edit).
   */
  newDailyEntryEdit(
    currentText: string,
    now: Date = new Date(),
  ): { insert: string; at: number } | null {
    if (/(^|\n)##[ \t]+\d{1,2}:\d{2}[ \t]*\n?\s*$/.test(currentText)) {
      return null;
    }

    // Land the new heading after exactly one blank line.
    let gap = '';
    if (currentText.length > 0 && !currentText.endsWith('\n\n')) {
      gap = currentText.endsWith('\n') ? '\n' : '\n\n';
    }
    return { insert: `${gap}## ${formatTime(now)}\n`, at: currentText.length };
  }

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /**
   * Opens a file in a tab. If it's already open, just activates that tab.
   * Never prompts -- a dirty buffer for another file stays in memory.
   */
  async openFile(relativePath: string): Promise<void> {
    if (!this.api) {
      return;
    }
    if (this.docs().some((d) => d.path === relativePath)) {
      this.active.set(relativePath);
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    try {
      const { content, modifiedMs } = await this.api.readVaultFile(relativePath);
      this.addDoc(this.makeDoc(relativePath, content, modifiedMs, true));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Opens the daily note for `dateStr` (`YYYY-MM-DD`). If the file exists
   * it's opened normally; otherwise a **draft** tab is opened from the
   * template -- nothing hits disk until the user types and saves.
   */
  async openDailyNote(dateStr: string): Promise<void> {
    if (!this.api) {
      return;
    }
    const relativePath = `daily/${dateStr}.md`;
    if (this.docs().some((d) => d.path === relativePath)) {
      this.active.set(relativePath);
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    try {
      try {
        const { content, modifiedMs } = await this.api.readVaultFile(relativePath);
        this.addDoc(this.makeDoc(relativePath, content, modifiedMs, true));
      } catch {
        // No file for that day yet -- open an unsaved draft.
        const template = await this.api.buildDailyNoteContent(dateStr);
        this.addDoc(this.makeDoc(relativePath, template, 0, false));
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Switches the active tab. No-op if the path isn't open. */
  activate(relativePath: string): void {
    if (this.docs().some((d) => d.path === relativePath)) {
      this.active.set(relativePath);
    }
  }

  /**
   * Closes a tab. A dirty tab asks first (the roadmap's minimum bar until
   * the file watcher forces a real keep-mine / take-external decision).
   * Closing the active tab activates its neighbour.
   */
  closeTab(relativePath: string): void {
    const list = this.docs();
    const index = list.findIndex((d) => d.path === relativePath);
    if (index === -1) {
      return;
    }
    const doc = list[index];
    if (
      doc.bufferContent !== doc.savedContent &&
      !confirm(`Discard unsaved changes to ${doc.name}?`)
    ) {
      return;
    }

    const remaining = list.filter((d) => d.path !== relativePath);
    this.docs.set(remaining);
    if (this.active() === relativePath) {
      const next = remaining[index] ?? remaining[index - 1] ?? null;
      this.active.set(next?.path ?? null);
    }
  }

  /** Called by the editor component on every buffer change (active tab). */
  updateBuffer(content: string): void {
    this.patchActive({ bufferContent: content });
  }

  setViewMode(mode: EditorViewMode): void {
    this.patchActive({ viewMode: mode });
  }

  /** Records the live caret position (see `OpenDoc.caretOffset`). */
  setCaretOffset(offset: number): void {
    this.patchActive({ caretOffset: Math.max(0, Math.floor(offset)) });
  }

  /**
   * Toggles auto-switch mode and persists it. Turning it on forces the
   * active tab into the rendered view -- that is the mode's landing state
   * ("preview stays until you type").
   */
  setAutoSwitch(on: boolean): void {
    this.autoSwitchState.set(on);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ autoSwitch: on }));
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
    if (on) {
      this.patchActive({ viewMode: 'rendered' });
    }
  }

  /** Writes the active buffer to disk. No-op when nothing changed. */
  async save(): Promise<void> {
    const doc = this.activeDoc();
    if (!this.api || doc === null || doc.bufferContent === doc.savedContent || this.isSaving()) {
      return;
    }

    this.isSaving.set(true);
    this.error.set(null);
    const written = doc.bufferContent;
    const onDisk = doc.eol === '\r\n' ? written.replace(/\n/g, '\r\n') : written;
    try {
      const modifiedMs = await this.api.writeVaultFile(doc.path, onDisk);
      this.patchDoc(doc.path, {
        savedContent: written,
        modifiedMs,
        existsOnDisk: true,
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isSaving.set(false);
    }
  }

  private makeDoc(
    relativePath: string,
    rawContent: string,
    modifiedMs: number,
    existsOnDisk: boolean,
  ): OpenDoc {
    // CodeMirror normalises to `\n`; detect the file's dominant ending so a
    // CRLF file (the Windows default for these notes) doesn't read back as
    // "modified" the instant the buffer syncs. Restored on save.
    const eol: '\n' | '\r\n' = rawContent.includes('\r\n') ? '\r\n' : '\n';
    const normalized = rawContent.replace(/\r\n/g, '\n');
    return {
      path: relativePath,
      name: baseName(relativePath),
      savedContent: normalized,
      bufferContent: normalized,
      // Rendered ("preview") is the default landing view; click-to-edit
      // drops into source (CLAUDE.md, "UI/UX Design").
      viewMode: 'rendered',
      caretOffset: 0,
      eol,
      modifiedMs,
      existsOnDisk,
    };
  }

  private addDoc(doc: OpenDoc): void {
    this.docs.update((list) => [...list, doc]);
    this.active.set(doc.path);
  }

  private patchActive(patch: Partial<OpenDoc>): void {
    const path = this.active();
    if (path !== null) {
      this.patchDoc(path, patch);
    }
  }

  private patchDoc(path: string, patch: Partial<OpenDoc>): void {
    this.docs.update((list) => list.map((d) => (d.path === path ? { ...d, ...patch } : d)));
  }
}
