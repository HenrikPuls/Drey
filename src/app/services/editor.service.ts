import { Injectable, computed, inject, signal } from '@angular/core';
import { dailyPathFor } from '../../../shared/daily';
import { EntryDraft, entryInsertion } from '../../../shared/entry-compose';
import { ActionOutcome } from '../../../shared/ipc-api';
import { formatTime } from '../../../shared/timestamp';
import { TagService } from './tag.service';
import { VaultService } from './vault.service';

/** Re-exported for existing importers (`Editor`, specs); defined in `markdown-frontmatter.ts`. */
export { stripFrontmatter } from '../editor/markdown-frontmatter';

/**
 * Which mode the editor shows. One `EditorView` runs both; `'live'` adds
 * the Live Preview extensions (ADR-0009), `'source'` shows the raw Markdown.
 * Both share the same typography (`editor-theme.ts`).
 */
export type EditorViewMode = 'source' | 'live';

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
  /** Line ending this file uses on disk; the buffer is always held in `\n`. */
  eol: '\n' | '\r\n';
  /** `modifiedMs` from the last read/write -- round-tripped for the future file watcher. */
  modifiedMs: number;
  existsOnDisk: boolean;
}

/**
 * One ask for a new `## HH:mm` entry at the end of the active document.
 * `id` deduplicates (the handling component remembers the last id it acted
 * on). Exactly one of the payloads is set: `text` for a bare body (the
 * quick-capture hotkey sends neither), `draft` for the entry drawer, whose
 * topic / text / tags are rendered by `shared/entry-compose.ts`.
 */
export interface NewEntryRequest {
  readonly id: number;
  readonly text?: string;
  readonly draft?: EntryDraft;
}

/** `localStorage` key for editor-wide preferences. */
const PREFS_KEY = 'drey.editor';

/**
 * The mode a freshly opened note lands in: whatever the user last switched to
 * via the `⋯` menu, defaulting to `'live'`. Read synchronously at
 * construction, like the pane sizes in `LayoutService`. A stored `'preview'`
 * (the pre-ADR-0009 name of the rendered mode) migrates to `'live'` by
 * falling through the `'source'` check.
 */
function readDefaultMode(): EditorViewMode {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return (JSON.parse(raw ?? '{}') as { defaultMode?: string }).defaultMode === 'source'
      ? 'source'
      : 'live';
  } catch {
    return 'live';
  }
}

function baseName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1] || relativePath;
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
  private readonly tags = inject(TagService);
  private readonly vault = inject(VaultService);

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
  readonly viewMode = computed<EditorViewMode>(() => this.activeDoc()?.viewMode ?? 'live');

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * `'edit'` outcomes from `on-save` Actions that still need confirmation
   * (ADR-0011). Set by `save()`, drained by `ActionsService` (an effect) so
   * `EditorService` needn't depend on it -- that would be a DI cycle.
   */
  readonly pendingActions = signal<ActionOutcome[]>([]);

  /** Returns the queued on-save action outcomes and clears them. */
  consumePendingActions(): ActionOutcome[] {
    const queue = this.pendingActions();
    if (queue.length > 0) {
      this.pendingActions.set([]);
    }
    return queue;
  }

  readonly isDirty = computed<boolean>(() => {
    const doc = this.activeDoc();
    return doc !== null && doc.bufferContent !== doc.savedContent;
  });

  /** True while the active tab is a not-yet-written draft (calendar-created daily note). */
  readonly activeIsDraft = computed<boolean>(() => this.activeDoc()?.existsOnDisk === false);

  /**
   * Bumped by the quick-capture hotkey flow (via `DailyNoteService`) and by
   * the entry drawer (via `EntryDraftService`) to ask the `Editor`
   * component to start a fresh `## HH:mm` entry at the end of the current
   * document -- with `text`, that text is inserted under the heading; with
   * a `draft`, the composed drawer entry is appended and saved. An id
   * counter rather than a raw payload signal: the component computes the
   * actual edit against live CodeMirror state when it handles the request,
   * which sidesteps effect-ordering with the doc-reload that a just-opened
   * file triggers.
   */
  readonly newEntryRequest = signal<NewEntryRequest>({ id: 0 });

  requestNewDailyEntry(text?: string): void {
    this.newEntryRequest.update((r) => ({ id: r.id + 1, text }));
  }

  /** The entry drawer's "Zum Dokument hinzufügen". */
  requestEntryFromDraft(draft: EntryDraft): void {
    this.newEntryRequest.update((r) => ({ id: r.id + 1, draft }));
  }

  /**
   * Pure: the CodeMirror change that appends `draft` to `currentText`.
   * Lives here rather than in the component for the same reason
   * `newDailyEntryEdit` does -- the component only dispatches it.
   */
  entryDraftEdit(
    currentText: string,
    draft: EntryDraft,
    now: Date = new Date(),
  ): { from: number; to: number; insert: string } {
    return entryInsertion(currentText, draft, now);
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
   * Opens `relativePath` and asks the editor to put the caret at the start
   * of 1-based `line` (a tag-search hit lands here). The `Editor` component
   * consumes `revealRequest` once the buffer for that path is loaded.
   */
  async openFileAt(relativePath: string, line: number): Promise<void> {
    await this.openFile(relativePath);
    if (this.active() === relativePath) {
      this.revealRequest.update((r) => ({ id: r.id + 1, path: relativePath, line }));
    }
  }

  /** id + target for `openFileAt`; `id === 0` means "nothing pending". */
  readonly revealRequest = signal<{ id: number; path: string; line: number }>({
    id: 0,
    path: '',
    line: 1,
  });

  /**
   * Opens (or replaces) an unsaved **draft** tab at `path` holding
   * arbitrary generated content -- e.g. the tag-search results document.
   * Nothing hits disk until the user saves it; a re-generate reuses the
   * same tab.
   */
  openScratch(path: string, content: string): void {
    const normalized = content.replace(/\r\n/g, '\n');
    if (this.docs().some((d) => d.path === path)) {
      this.patchDoc(path, { savedContent: normalized, bufferContent: normalized });
      this.active.set(path);
      return;
    }
    this.addDoc(this.makeDoc(path, normalized, 0, false));
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
    const nestedPath = dailyPathFor(dateStr);
    const legacyPath = `daily/${dateStr}.md`;
    // A note this session may already be open under either layout.
    for (const candidate of [nestedPath, legacyPath]) {
      if (this.docs().some((d) => d.path === candidate)) {
        this.active.set(candidate);
        return;
      }
    }

    this.isLoading.set(true);
    this.error.set(null);
    try {
      // Prefer the nested layout; fall back to a pre-existing flat file;
      // otherwise open an unsaved draft at the nested path.
      const existing =
        (await this.tryReadDaily(nestedPath)) ?? (await this.tryReadDaily(legacyPath));
      if (existing) {
        this.addDoc(this.makeDoc(existing.path, existing.content, existing.modifiedMs, true));
      } else {
        const template = await this.api.buildDailyNoteContent(dateStr);
        this.addDoc(this.makeDoc(nestedPath, template, 0, false));
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  private async tryReadDaily(
    path: string,
  ): Promise<{ path: string; content: string; modifiedMs: number } | null> {
    try {
      const { content, modifiedMs } = await this.api!.readVaultFile(path);
      return { path, content, modifiedMs };
    } catch {
      return null;
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
   * Closing the active tab activates its neighbour. `silent` skips the
   * dirty prompt -- used when the underlying file was just deleted, where
   * "keep editing" is not an option.
   */
  closeTab(relativePath: string, options: { silent?: boolean } = {}): void {
    const list = this.docs();
    const index = list.findIndex((d) => d.path === relativePath);
    if (index === -1) {
      return;
    }
    const doc = list[index];
    if (
      !options.silent &&
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

  /**
   * Tab-bar context menu: close every tab / every tab but one. Each is
   * routed through `closeTab`, so a dirty tab still raises its own
   * `confirm()` and a cancel there leaves that tab (and the rest) open.
   * The path list is snapshotted first because `closeTab` mutates `docs`.
   */
  closeAll(): void {
    for (const path of this.docs().map((d) => d.path)) {
      this.closeTab(path);
    }
  }

  closeOthers(keepPath: string): void {
    for (const path of this.docs().map((d) => d.path)) {
      if (path !== keepPath) {
        this.closeTab(path);
      }
    }
  }

  /**
   * Silently closes every open tab for a path that was just deleted -- the
   * file itself, or (for a folder) anything under it. No dirty prompt: the
   * file is gone, there is nothing to save it back to.
   */
  closeTabsUnder(deletedPath: string): void {
    const prefix = `${deletedPath}/`;
    for (const path of this.docs().map((d) => d.path)) {
      if (path === deletedPath || path.startsWith(prefix)) {
        this.closeTab(path, { silent: true });
      }
    }
  }

  /** Called by the editor component on every buffer change (active tab). */
  updateBuffer(content: string): void {
    this.patchActive({ bufferContent: content });
  }

  /**
   * Switches the active tab's mode and remembers it as the default for
   * future opens (`⋯` menu). Persisted per machine, like the pane sizes.
   */
  setViewMode(mode: EditorViewMode): void {
    this.patchActive({ viewMode: mode });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ defaultMode: mode }));
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }

  /**
   * Saves the active buffer through the tag pipeline (`note:save`): the
   * main process merges inline `#tag`s into the frontmatter, bumps
   * `updated:`, and routes tagged entries into their topic's master
   * document. The returned `content` is the rewritten note -- adopted as
   * both saved and buffer text, so the editor shows the merged frontmatter
   * and the tab is clean. Any master doc that got a routed History entry
   * and is open in another (clean) tab is reloaded from disk. No-op when
   * nothing changed.
   */
  async save(options: { runOnSaveActions?: boolean } = {}): Promise<void> {
    const doc = this.activeDoc();
    if (!this.api || doc === null || doc.bufferContent === doc.savedContent || this.isSaving()) {
      return;
    }

    const wasDraft = doc.existsOnDisk === false;

    this.isSaving.set(true);
    this.error.set(null);
    try {
      const result = await this.api.saveNote({
        path: doc.path,
        body: doc.bufferContent,
        eol: doc.eol,
        runOnSaveActions: options.runOnSaveActions,
      });
      this.patchDoc(doc.path, {
        savedContent: result.content,
        bufferContent: result.content,
        modifiedMs: result.modifiedMs,
        existsOnDisk: true,
      });
      // The main process re-indexed this file on save; pull the vocabulary
      // so `#tag` autocomplete and the search picker stay current.
      void this.tags.refresh();
      // A first save of a draft (a daily note opened from the calendar, or
      // the quick-capture hotkey) creates a file the sidebar tree does not
      // know about yet -- no watcher, so pull the tree in.
      if (wasDraft) {
        void this.vault.refresh();
      }
      if (result.pendingActions && result.pendingActions.length > 0) {
        this.pendingActions.set(result.pendingActions);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isSaving.set(false);
    }
  }

  /**
   * Adopts an Action / Ask-mode rewrite of an open document: pushes
   * `content` into the tab's buffer and saves it with the on-save Action
   * hook suppressed (so applying one action can't recurse into another).
   * No-op when the path isn't open.
   */
  async applyRewrite(path: string, content: string): Promise<void> {
    const doc = this.docs().find((d) => d.path === path);
    if (!doc || content === doc.bufferContent) {
      return;
    }
    if (this.active() !== path) {
      this.active.set(path);
    }
    this.patchDoc(path, { bufferContent: content });
    await this.save({ runOnSaveActions: false });
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
      // Land in whichever mode the user last chose (`⋯` menu), Live Preview by default.
      viewMode: readDefaultMode(),
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
