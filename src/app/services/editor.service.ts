import { Injectable, computed, inject, signal } from '@angular/core';
import { imageExtension } from '../../../shared/asset-name';
import { dailyPathFor } from '../../../shared/daily';
import { EntryDraft } from '../../../shared/entry-compose';
import { ActionOutcome } from '../../../shared/ipc-api';
import { setDoneOnLine } from '../../../shared/tasks';
import { EditorCommandsService } from '../editor/editor-commands.service';
import { EditorPrefsService, EditorViewMode } from '../editor/editor-prefs.service';
import { PaneService } from '../panes/pane.service';
import { TagService } from '../services/tag.service';
import { VaultService } from '../vault';

/** Re-exported for existing importers (`Editor`, specs); defined in `markdown-frontmatter.ts`. */
export { stripFrontmatter } from '../editor/markdown-frontmatter';
/** Re-exported for existing importers; defined in the split-out collaborators. */
export type { EditorViewMode } from '../editor/editor-prefs.service';
export type { NewEntryRequest } from '../editor/editor-commands.service';

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
  /**
   * Vault-relative path, e.g. `daily/2026-09-05.md`. Unique per tab. For a
   * `kind: 'browser'` tab this is the synthetic key `browser://<n>` -- not
   * a real path, but still the identity string every pane / tab-bar / close
   * path uses. `://` guarantees it never collides with a vault path.
   */
  readonly path: string;
  /** For a browser tab this follows the page title as it loads (via `patchDoc`). */
  readonly name: string;
  /**
   * `'text'` (a Markdown buffer, the default), `'image'` -- a viewer tab
   * for a `.png`/`.jpg`/… file (ADR-0026), or `'browser'` -- an in-editor
   * web browser tab whose page lives in a main-process `WebContentsView`
   * (ADR-0042). Neither `'image'` nor `'browser'` carries a buffer
   * (`savedContent === bufferContent === ''`, never dirty); both skip every
   * text-only path (`save`, `saveAs`, `setViewMode`, `updateBuffer`).
   */
  readonly kind: 'text' | 'image' | 'browser';
  savedContent: string;
  bufferContent: string;
  viewMode: EditorViewMode;
  /** Line ending this file uses on disk; the buffer is always held in `\n`. */
  eol: '\n' | '\r\n';
  /** `modifiedMs` from the last read/write -- round-tripped for the future file watcher. */
  modifiedMs: number;
  existsOnDisk: boolean;
  /**
   * `true` for a generated scratch doc (the tag-search export) that has no
   * intended location: `save()` routes to `saveAs()` so the user picks one.
   * Daily-note drafts leave this `false` -- they save to their own path.
   */
  askOnSave?: boolean;
  /** Browser tab only: current page URL, mirrored from `browser:event` for the status bar. */
  url?: string;
  /** Browser tab only: current favicon URL (or null), for the tab strip. */
  favicon?: string | null;
}

function baseName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1] || relativePath;
}

/**
 * Whether `path` is a Markdown document (or a still-unnamed one). Only these
 * get Live Preview and the Markdown-only editor chrome; a `.cpp` / `.json` /
 * `.ts` file opens in source mode with that language's syntax highlighting.
 */
function isMarkdownPath(path: string): boolean {
  return path === '' || /\.(md|markdown|mdx)$/i.test(path);
}

/**
 * Holds every open document (the registry: buffer, dirty state, kind, eol)
 * and, via `PaneService`, which one is "active" for every consumer that
 * doesn't care about panes. Same shape as `VaultService`: talk to
 * `window.dreyApi`, keep the result in signals, no logic beyond that
 * (CLAUDE.md, "no business logic inside components"; filesystem access
 * stays in the main process per ADR-0001).
 *
 * Milestone "visual shell" turned this from one-document-at-a-time into a
 * multi-buffer model so the tab bar has something real to drive (see
 * ADR-0003). ADR-0037 split *tab placement* out into `PaneService`: this
 * class no longer owns which paths are tabs or which is active -- it owns
 * the documents themselves, and `activePath`/`activeDoc` (and everything
 * derived from them: `isDirty`, `save()`, word count, ...) now mean "the
 * *focused pane's* active document". That is deliberate: ~20 other files
 * (Assistant, Tasks, Actions, the status bar, MCP tools, keybindings, the
 * calendar, tag search's "open at line", ...) all read this single
 * "current document" and none of them need to become pane-aware -- only
 * `TabBar` and `Editor` do (see `PaneService`'s doc comment for the pane
 * model itself: one pane per path, an arbitrary split tree).
 *
 * Switching tabs never prompts -- unsaved buffers are just kept in memory;
 * only closing a dirty tab asks (CLAUDE.md build order, item 5).
 */
@Injectable({ providedIn: 'root' })
export class EditorService {
  private readonly tags = inject(TagService);
  private readonly vault = inject(VaultService);
  private readonly panes = inject(PaneService);
  private readonly prefs = inject(EditorPrefsService);
  private readonly commands = inject(EditorCommandsService);

  private readonly docs = signal<OpenDoc[]>([]);

  /** Every open document (the registry), regardless of which pane shows it. */
  readonly openDocs = this.docs.asReadonly();
  /** Vault-relative path of the focused pane's active tab, or null when nothing is open. */
  readonly activePath = computed<string | null>(() => this.panes.focusedPane()?.active ?? null);

  private readonly activeDoc = computed<OpenDoc | null>(
    () => this.docs().find((d) => d.path === this.activePath()) ?? null,
  );

  /** The `OpenDoc` for `path`, or null if it isn't open. For a specific pane's own chrome (not "the" active doc). */
  docFor(path: string | null): OpenDoc | null {
    return path === null ? null : (this.docs().find((d) => d.path === path) ?? null);
  }

  /**
   * Vault-relative path of the open file. Kept as the historical name so
   * `App` / `Sidebar` / `DailyNoteService` don't need to care that there's
   * now more than one buffer.
   */
  readonly openPath = computed<string | null>(() => this.activeDoc()?.path ?? null);
  readonly savedContent = computed<string>(() => this.activeDoc()?.savedContent ?? '');
  readonly bufferContent = computed<string>(() => this.activeDoc()?.bufferContent ?? '');
  readonly viewMode = computed<EditorViewMode>(() => this.activeDoc()?.viewMode ?? 'live');

  /**
   * The active tab's kind -- `'image'` / `'browser'` make the centre column
   * swap `<app-editor>` for `<app-image-tab>` / `<app-browser-tab>`, and
   * every text-only consumer (save, tasks, templates, insert-into-note)
   * treats a non-`'text'` kind as "no buffer".
   */
  readonly activeKind = computed<'text' | 'image' | 'browser'>(
    () => this.activeDoc()?.kind ?? 'text',
  );

  /**
   * `true` for a Markdown path (or `null`/nothing open). `false` for a code
   * file (`.cpp`, `.json`, …): a pane's `⋯` menu hides the Live Preview /
   * Source toggle for it, and the surface loads that language's grammar
   * instead of the Markdown bundle. Takes an explicit path (each pane has
   * its own shown document) rather than assuming "the" active one.
   */
  isMarkdown(path: string | null): boolean {
    return isMarkdownPath(path ?? '');
  }

  /**
   * Live viewport of the active image tab (natural pixel size + current
   * zoom) -- the status bar shows it instead of the word/char count.
   * `ImageTab` writes it; `null` when the active tab isn't an image.
   */
  readonly imageViewport = signal<{
    naturalWidth: number;
    naturalHeight: number;
    scale: number;
  } | null>(null);

  setImageViewport(v: { naturalWidth: number; naturalHeight: number; scale: number } | null): void {
    this.imageViewport.set(v);
  }

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Whether the editor shows a line-number gutter. App-wide, persisted per
   * machine like the default view mode. Toggled from the meta bar and
   * View -> "Line numbers". Owned by `EditorPrefsService`; re-exposed here so
   * the meta bar / menu / `App` keep reading it off `EditorService`.
   */
  readonly lineNumbers = this.prefs.lineNumbers;

  toggleLineNumbers(): void {
    this.prefs.toggleLineNumbers();
  }

  /** Word / character counts for the status bar, from the active buffer. */
  readonly wordCount = computed<number>(() => {
    const text = this.bufferContent().trim();
    return text ? text.split(/\s+/).length : 0;
  });
  readonly charCount = computed<number>(() => this.bufferContent().length);

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
   * The deferred editor-command bus (`EditorCommandsService`), re-exposed
   * here so the ~5 callers (`Editor`, `DailyNoteService`, `EntryDraftService`,
   * `AssistantService`, `TemplateLibraryService`) keep going through
   * `EditorService`.
   *
   * `newEntryRequest` is bumped by the quick-capture hotkey flow and the
   * entry drawer to ask the `Editor` component to start a fresh `## HH:mm`
   * entry; `insertRequest` drops text at the caret (the assistant's
   * insert-into-note arrow). Both are id counters, not payload signals: the
   * component computes the real CodeMirror change against live state when it
   * handles the request.
   */
  readonly newEntryRequest = this.commands.newEntryRequest;
  readonly insertRequest = this.commands.insertRequest;

  requestNewDailyEntry(text?: string): void {
    this.commands.requestNewDailyEntry(text);
  }

  /** The assistant card's "insert into note" button. No-op with no open (text) document. */
  requestInsertText(text: string): void {
    if (text.trim() === '' || this.activePath() === null || this.activeKind() !== 'text') {
      return;
    }
    this.commands.requestInsertText(text);
  }

  /** The entry drawer's "Add to document"; `pattern` is the active template. */
  requestEntryFromDraft(draft: EntryDraft, pattern: string): void {
    this.commands.requestEntryFromDraft(draft, pattern);
  }

  /** @see EditorCommandsService.entryDraftEdit */
  entryDraftEdit(
    currentText: string,
    draft: EntryDraft,
    pattern: string,
    now: Date = new Date(),
  ): { from: number; to: number; insert: string } {
    return this.commands.entryDraftEdit(currentText, draft, pattern, now);
  }

  /** @see EditorCommandsService.newDailyEntryEdit */
  newDailyEntryEdit(
    currentText: string,
    now: Date = new Date(),
  ): { insert: string; at: number } | null {
    return this.commands.newDailyEntryEdit(currentText, now);
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
      // Already open -- reveal it (focus + activate whichever pane has it;
      // a path lives in one pane at a time, see `PaneService`).
      this.panes.open(relativePath);
      return;
    }

    // An image file opens as a viewer tab -- never read as text (that used
    // to open a mojibake buffer that Ctrl+S would write back).
    if (imageExtension(relativePath)) {
      this.addDoc(this.makeImageDoc(relativePath));
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
    if (this.docs().some((d) => d.path === relativePath)) {
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
   * Nothing hits disk until the user saves it. The tab is **dirty from the
   * start** (`savedContent` empty) so the Save button is live without a
   * throwaway edit first; `save()` routes it to `saveAs()` (`askOnSave`).
   */
  openScratch(path: string, content: string): void {
    const normalized = content.replace(/\r\n/g, '\n');
    const patch = {
      savedContent: '',
      bufferContent: normalized,
      existsOnDisk: false,
      askOnSave: true,
    };
    if (this.docs().some((d) => d.path === path)) {
      this.patchDoc(path, patch);
      this.panes.open(path);
      return;
    }
    const doc = this.makeDoc(path, normalized, 0, false, true);
    this.addDoc({ ...doc, savedContent: '' });
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
        this.panes.open(candidate);
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

  /**
   * Reveals a tab app-wide: focuses + activates whichever pane already has
   * `relativePath` open (the "Open windows" list, File-menu style global
   * commands). No-op if it isn't open. A pane's *own* tab bar activates
   * within itself via `PaneService.activate` directly -- it doesn't need
   * this "search every pane" version of the same idea.
   */
  activate(relativePath: string): void {
    if (this.docs().some((d) => d.path === relativePath)) {
      this.panes.open(relativePath);
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
    const doc = this.docs().find((d) => d.path === relativePath);
    if (!doc) {
      return;
    }
    if (
      !options.silent &&
      doc.bufferContent !== doc.savedContent &&
      !confirm(`Discard unsaved changes to ${doc.name}?`)
    ) {
      return;
    }
    // Pane placement first (picks the neighbour to activate there), then
    // drop the buffer -- a path lives in one pane at a time, so this closes
    // its one and only tab.
    this.panes.closeEverywhere(relativePath);
    this.docs.update((list) => list.filter((d) => d.path !== relativePath));
  }

  /**
   * A pane's own tab-bar context menu: close every tab / every tab but one
   * *in that pane* -- a split's other panes are untouched. Each is routed
   * through `closeTab`, so a dirty tab still raises its own `confirm()` and
   * a cancel there leaves that tab (and the rest) open. The path list is
   * snapshotted first (from `PaneService`) because `closeTab` mutates it.
   */
  closeAll(paneId: string): void {
    for (const path of this.panes.pane(paneId)?.tabs ?? []) {
      this.closeTab(path);
    }
  }

  closeOthers(paneId: string, keepPath: string): void {
    for (const path of this.panes.pane(paneId)?.tabs ?? []) {
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

  /**
   * A file or folder was renamed/moved on disk: re-point any open tab at
   * its new path, keeping the buffer so unsaved edits survive the rename.
   * For a folder rename every tab under it moves.
   */
  retargetTabs(oldPath: string, newPath: string): void {
    const prefix = `${oldPath}/`;
    const remap = (p: string): string | null =>
      p === oldPath ? newPath : p.startsWith(prefix) ? newPath + p.slice(oldPath.length) : null;

    this.docs.update((list) =>
      list.map((d) => {
        const next = remap(d.path);
        if (next === null) {
          return d;
        }
        // Pane placement references the same path string, so re-point it
        // there too before the registry's own path changes underneath it.
        this.panes.renamePath(d.path, next);
        return { ...d, path: next, name: next.slice(next.lastIndexOf('/') + 1) };
      }),
    );
  }

  /** Called by a pane's editor surface on every buffer change; `path` is that pane's shown document. */
  updateBuffer(path: string, content: string): void {
    const doc = this.docs().find((d) => d.path === path);
    if (!doc || doc.kind !== 'text') {
      return;
    }
    this.patchDoc(path, { bufferContent: content });
  }

  /**
   * Switches a tab's mode and remembers it as the default for future opens
   * (`⋯` menu). `path` defaults to the focused pane's document -- the
   * global Ctrl+S-style callers want that; a pane's own `⋯` menu passes its
   * own shown path explicitly, since that pane needn't be the focused one.
   * Persisted per machine, like the pane sizes.
   */
  setViewMode(mode: EditorViewMode, path?: string): void {
    const doc = path !== undefined ? this.docFor(path) : this.activeDoc();
    if (!doc || doc.kind !== 'text') {
      return;
    }
    // Live Preview is Markdown-only; a code tab stays in source (its menu
    // item is hidden anyway).
    if (mode === 'live' && !isMarkdownPath(doc.path)) {
      return;
    }
    this.patchDoc(doc.path, { viewMode: mode });
    this.prefs.setDefaultMode(mode);
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
   *
   * `options.path` defaults to the focused pane's document (Ctrl+S, the
   * File menu); a pane's own Save button passes its own shown path.
   */
  async save(options: { runOnSaveActions?: boolean; path?: string } = {}): Promise<void> {
    const doc = options.path !== undefined ? this.docFor(options.path) : this.activeDoc();
    if (!this.api || doc === null || doc.kind !== 'text' || this.isSaving()) {
      return;
    }
    // A generated scratch doc has no destination yet -- ask for one, even
    // if the buffer is untouched (the user wants to keep the export as-is).
    if (doc.askOnSave) {
      await this.saveAs(doc.path);
      return;
    }
    if (doc.bufferContent === doc.savedContent) {
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
   * File -> "Save all". Walks every open document in the registry, saving
   * the dirty ones, by explicit path -- doesn't touch pane focus/activation
   * at all (unlike the single-pane version this replaced), since `save()`
   * now takes the path directly. Each goes through `save()`, so a scratch
   * tab still routes to `saveAs()` and an untouched draft is skipped.
   */
  async saveAll(): Promise<void> {
    for (const path of this.docs().map((d) => d.path)) {
      const doc = this.docs().find((d) => d.path === path);
      if (!doc || doc.kind !== 'text' || (doc.bufferContent === doc.savedContent && !doc.askOnSave)) {
        continue;
      }
      await this.save({ path });
    }
  }

  /**
   * File -> "New note". Opens a blank scratch tab; the first save prompts
   * for a location inside the vault (`askOnSave`). A dedicated
   * create-in-place flow can come later.
   */
  newUntitled(): void {
    let name = 'untitled.md';
    let n = 2;
    while (this.docs().some((d) => d.path === name)) {
      name = `untitled-${n++}.md`;
    }
    this.openScratch(name, '');
  }

  /**
   * "Save as…": pick a destination inside the vault (native dialog), write
   * the buffer there, and re-key the tab to the new file. For a never-saved
   * scratch doc this is where `save()` lands; on a normal file it forks the
   * buffer to a new path (the original on disk is untouched). `path`
   * defaults to the focused pane's document, like `save()`.
   */
  async saveAs(path?: string): Promise<void> {
    const doc = path !== undefined ? this.docFor(path) : this.activeDoc();
    if (!this.api?.pickSavePath || doc === null || doc.kind !== 'text' || this.isSaving()) {
      return;
    }
    this.error.set(null);
    let target: string | null;
    try {
      target = await this.api.pickSavePath(doc.name);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      return;
    }
    if (target === null) {
      return; // cancelled
    }
    if (target === doc.path && !doc.askOnSave) {
      await this.save({ path: doc.path });
      return;
    }

    this.isSaving.set(true);
    try {
      await this.api.saveNote({ path: target, body: doc.bufferContent, eol: doc.eol });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.isSaving.set(false);
      return;
    }
    this.isSaving.set(false);

    // Swap the scratch/old tab for the real file, then load it fresh so the
    // buffer, mtime and `existsOnDisk` come from disk.
    this.closeTab(doc.path, { silent: true });
    await this.openFile(target);
    void this.tags.refresh();
    void this.vault.refresh();
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
    this.panes.open(path); // reveal: focuses + activates wherever it is
    this.patchDoc(path, { bufferContent: content });
    await this.save({ runOnSaveActions: false, path });
  }

  /**
   * Forces the done-state of the task on 1-based `line` of `path`
   * (`shared/tasks/setDoneOnLine`) -- the Tasks panel's checkbox.
   *
   * If the file is open as a text tab the edit goes through that buffer
   * (activating the tab if needed) and is saved like any edit, so an
   * unsaved change in it is never lost. Otherwise the file is read,
   * patched and written straight back through the `note:save` pipeline
   * (which re-indexes it). A no-op when the line does not parse as a task.
   */
  async setTaskDone(path: string, line: number, done: boolean): Promise<void> {
    // A browser tab is keyed `browser://<n>`, not a real path -- never read
    // it off disk (no task row references one, but be explicit).
    if (this.docFor(path)?.kind === 'browser') {
      return;
    }
    const open = this.docs().find((d) => d.path === path && d.kind === 'text');
    if (open) {
      const next = setDoneOnLine(open.bufferContent, line, done);
      if (next === open.bufferContent) {
        return;
      }
      this.panes.open(path); // reveal: focuses + activates wherever it is
      this.patchDoc(path, { bufferContent: next });
      await this.save({ path });
      return;
    }

    if (!this.api) {
      return;
    }
    this.error.set(null);
    try {
      const { content } = await this.api.readVaultFile(path);
      const eol: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
      const normalized = content.replace(/\r\n/g, '\n');
      const next = setDoneOnLine(normalized, line, done);
      if (next === normalized) {
        return;
      }
      await this.api.saveNote({ path, body: next, eol });
      void this.tags.refresh();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  private makeDoc(
    relativePath: string,
    rawContent: string,
    modifiedMs: number,
    existsOnDisk: boolean,
    askOnSave = false,
  ): OpenDoc {
    // CodeMirror normalises to `\n`; detect the file's dominant ending so a
    // CRLF file (the Windows default for these notes) doesn't read back as
    // "modified" the instant the buffer syncs. Restored on save.
    const eol: '\n' | '\r\n' = rawContent.includes('\r\n') ? '\r\n' : '\n';
    const normalized = rawContent.replace(/\r\n/g, '\n');
    return {
      path: relativePath,
      name: baseName(relativePath),
      kind: 'text',
      savedContent: normalized,
      bufferContent: normalized,
      // Markdown lands in whichever mode the user last chose (`⋯` menu),
      // Live Preview by default; a code file always opens in source -- Live
      // Preview only renders Markdown.
      viewMode: isMarkdownPath(relativePath) ? this.prefs.defaultMode() : 'source',
      eol,
      modifiedMs,
      existsOnDisk,
      askOnSave,
    };
  }

  /**
   * An image viewer tab (ADR-0026): no `readVaultFile`, no buffer, never
   * dirty. The renderer loads the pixels through `drey-asset://` -- the
   * `ImageTab` component resolves `relativePath` (vault-root-relative)
   * itself.
   */
  private makeImageDoc(relativePath: string): OpenDoc {
    return {
      path: relativePath,
      name: baseName(relativePath),
      kind: 'image',
      savedContent: '',
      bufferContent: '',
      viewMode: 'live',
      eol: '\n',
      modifiedMs: 0,
      existsOnDisk: true,
    };
  }

  /**
   * Registers a browser tab (ADR-0042). Called by
   * `BrowserViewService`, which mints the `browser://<n>` key and owns the
   * matching `WebContentsView` over IPC; `EditorService` only tracks the
   * tab's existence, its (page-title) name and favicon for the tab strip,
   * and its URL for the status bar. No buffer, never dirty, never saved.
   */
  addBrowserDoc(key: string, name: string): void {
    if (this.docs().some((d) => d.path === key)) {
      this.panes.open(key);
      return;
    }
    this.addDoc({
      path: key,
      name,
      kind: 'browser',
      savedContent: '',
      bufferContent: '',
      viewMode: 'live',
      eol: '\n',
      modifiedMs: 0,
      existsOnDisk: true,
      url: '',
      favicon: null,
    });
  }

  /** Updates a browser tab's title / favicon / URL as the page loads. */
  setBrowserMeta(key: string, patch: { name?: string; favicon?: string | null; url?: string }): void {
    if (this.docFor(key)?.kind !== 'browser') {
      return;
    }
    this.patchDoc(key, patch);
  }

  private addDoc(doc: OpenDoc): void {
    this.docs.update((list) => [...list, doc]);
    this.panes.open(doc.path);
  }

  private patchDoc(path: string, patch: Partial<OpenDoc>): void {
    this.docs.update((list) => list.map((d) => (d.path === path ? { ...d, ...patch } : d)));
  }
}
