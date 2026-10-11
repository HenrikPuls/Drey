import { Injectable, computed, inject, signal } from '@angular/core';
import { ActionOutcome } from '../../../shared/ipc-api';
import { isAutoSavePath } from '../../../shared/structural-folders';
import { EditorCommandsService } from '../editor/editor-commands.service';
import { EditorPrefsService, EditorViewMode } from '../editor/editor-prefs.service';
import { PaneService } from '../panes/pane.service';
import { VaultService } from '../vault';
import { CARET_MEMORY_LIMIT, CaretMemory, CaretMemoryStore } from './caret-memory';
import { ConfirmDialogService } from './confirm-dialog.service';
import { DocDiskSyncService } from './doc-disk-sync.service';
import { DocOpenService } from './doc-open.service';
import { DocSaveService } from './doc-save.service';
import { OpenDoc, docKey, isDirty, isMarkdownPath } from './open-doc';
import { OpenDocsStore } from './open-docs.store';

/** Re-exported for existing importers (`Editor`, specs); defined in `markdown-frontmatter.ts`. */
export { stripFrontmatter } from '../editor/markdown-frontmatter';
/** Re-exported for existing importers; defined in the split-out collaborators. */
export type { EditorViewMode } from '../editor/editor-prefs.service';
export type { NewEntryRequest } from '../editor/editor-commands.service';
export type { CaretMemory } from './caret-memory';
export { docKey } from './open-doc';
export type { OpenDoc } from './open-doc';

type SaveOptions = { runOnSaveActions?: boolean; key?: string; path?: string; origin?: string };

/**
 * The app's one "current document" surface: every open document and, via
 * `PaneService`, which one is "active" for every consumer that doesn't
 * care about panes. A **facade** -- the records live in `OpenDocsStore`,
 * opening is `DocOpenService`, writing is `DocSaveService`, following the
 * disk is `DocDiskSyncService`. What stays here is what ties them
 * together: the selectors of the active document, closing tabs (which may
 * save first), the order and route of saves, and "Save as…" (write, close,
 * reopen).
 *
 * Milestone "visual shell" turned this from one-document-at-a-time into a
 * multi-buffer model so the tab bar has something real to drive (see
 * ADR-0003). ADR-0037 split *tab placement* out into `PaneService`: this
 * class does not own which documents are tabs or which is active, and
 * `activePath` (and everything derived from it: `isDirty`, `save()`, word
 * count, ...) means "the *focused pane's* active document". That is
 * deliberate: ~20 other files (Assistant, Tasks, Actions, the status bar,
 * MCP tools, keybindings, the calendar, tag search's "open at line", ...)
 * all read this single "current document" and none of them need to become
 * pane-aware -- only `TabBar` and `Editor` do (see `PaneService`'s doc
 * comment for the pane model itself: one pane per document, an arbitrary
 * split tree).
 *
 * Since ADR-0051 a document knows its vault: `path` stays vault-relative
 * (what IPC speaks and UI displays), while `key` -- `vaultId::path` -- is
 * the tab identity, so the same relative path from two vaults opens as two
 * independent tabs. Pane tabs, drag payloads and session snapshots all
 * carry keys. IPC calls always go out with the doc's own `vaultId`.
 *
 * Switching tabs never prompts -- unsaved buffers are just kept in memory;
 * only closing a dirty tab asks.
 */
@Injectable({ providedIn: 'root' })
export class EditorService {
  private readonly vault = inject(VaultService);
  private readonly panes = inject(PaneService);
  private readonly prefs = inject(EditorPrefsService);
  private readonly commands = inject(EditorCommandsService);
  private readonly dialogs = inject(ConfirmDialogService);
  private readonly store = inject(OpenDocsStore);
  private readonly opener = inject(DocOpenService);
  private readonly saver = inject(DocSaveService);
  private readonly diskSync = inject(DocDiskSyncService);

  /** Every open document (the registry), regardless of which pane shows it. */
  readonly openDocs = this.store.docs;
  /**
   * Tab key of the focused pane's active tab, or null when nothing is
   * open. (The historical name stays -- most consumers only compare it
   * against `doc.key` / pass it back into `docFor`.)
   */
  readonly activePath = this.store.activeKey;

  /**
   * Live-edit locks (ADR-0049): docs whose user input is blocked while the
   * assistant edits them. Advisory UX protection, not a hard invariant —
   * held per doc key, released by the owner (the assistant panel) at turn end.
   */
  private readonly editLocks = signal<ReadonlySet<string>>(new Set());

  /** Adds or removes `key`'s user-input lock. Unknown keys are ignored. */
  setEditLock(key: string, locked: boolean): void {
    if (locked) {
      this.saver.markAssistantEdited(key);
    }
    this.editLocks.update((locks) => {
      const has = locks.has(key);
      if (locked === has) {
        return locks;
      }
      const next = new Set(locks);
      if (locked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }

  /** Whether `key` is currently locked against user input. */
  isEditLocked(key: string | null): boolean {
    return key !== null && this.editLocks().has(key);
  }

  /** Whether `key` is an external (out-of-vault) document (ADR-0054). */
  isExternal(key: string | null): boolean {
    return key !== null && this.docFor(key)?.external === true;
  }

  /** Whether `key` is an in-app help document (read-only, ADR-0070). */
  isHelpDoc(key: string | null): boolean {
    return key !== null && this.docFor(key)?.help !== undefined;
  }

  private readonly activeDoc = this.store.activeDoc;

  /** The `OpenDoc` whose TAB is `key`, or null if it isn't open. */
  docFor(key: string | null): OpenDoc | null {
    return this.store.docFor(key);
  }

  /** @see OpenDocsStore.resolveDoc */
  resolveDoc(keyOrPath: string): OpenDoc | null {
    return this.store.resolveDoc(keyOrPath);
  }

  /**
   * Vault-relative path of the open file. Kept as the historical name so
   * `App` / `Sidebar` / `DailyNoteService` don't need to care that there's
   * now more than one buffer.
   */
  readonly openPath = computed<string | null>(() => this.activeDoc()?.path ?? null);
  /** Vault id of the open file (ADR-0051), or null for vault-less docs. */
  readonly openVaultId = computed<string | null>(() => this.activeDoc()?.vaultId ?? null);
  /**
   * The active doc's help asset base (`manual/`), or null when it is not a
   * help document (ADR-0070) -- the Live Preview resolves relative image
   * refs against it instead of the vault.
   */
  readonly openAssetBase = computed<string | null>(() => this.activeDoc()?.help?.assetBase ?? null);
  readonly savedContent = computed<string>(() => this.activeDoc()?.savedContent ?? '');
  readonly bufferContent = computed<string>(() => this.activeDoc()?.bufferContent ?? '');
  readonly viewMode = computed<EditorViewMode>(() => this.activeDoc()?.viewMode ?? 'live');

  /**
   * The active tab's kind -- a non-text kind makes the centre column swap
   * `<app-editor>` for the kind's registered surface (`DocKindRegistry`),
   * and every text-only consumer (save, tasks, templates, insert-into-note)
   * treats a non-`'text'` kind as "no buffer".
   */
  readonly activeKind = computed<string>(() => this.activeDoc()?.kind ?? 'text');

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

  readonly isLoading = this.store.isLoading;
  readonly isSaving = this.store.isSaving;
  readonly error = this.store.error;
  /** Serialization tail for `save()` — always resolved, unlike the per-call promises. */
  private saveQueue: Promise<void> = Promise.resolve();

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

  /** @see DocSaveService.pendingActions */
  readonly pendingActions = this.saver.pendingActions;

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
    return doc !== null && isDirty(doc);
  });

  /** True while the active tab is a not-yet-written draft (calendar-created daily note). */
  readonly activeIsDraft = computed<boolean>(() => this.activeDoc()?.existsOnDisk === false);

  /**
   * The deferred editor-command bus (`EditorCommandsService`), re-exposed
   * here so its callers (`Editor`, `DailyNoteService`)
   * keep going through `EditorService`.
   *
   * `newEntryRequest` is bumped by the quick-capture hotkey flow to ask the `Editor` component to start a fresh `## HH:mm`
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

  /** @see EditorCommandsService.claimNewEntryRequest */
  claimNewEntryRequest(id: number): boolean {
    return this.commands.claimNewEntryRequest(id);
  }

  /** @see EditorCommandsService.claimInsertRequest */
  claimInsertRequest(id: number): boolean {
    return this.commands.claimInsertRequest(id);
  }

  /** @see EditorCommandsService.claimRevealRequest */
  claimRevealRequest(id: number): boolean {
    return this.commands.claimRevealRequest(id);
  }

  /** The assistant card's "insert into note" button. No-op with no open (text) document. */
  requestInsertText(text: string): void {
    if (text.trim() === '' || this.activePath() === null || this.activeKind() !== 'text') {
      return;
    }
    this.commands.requestInsertText(text);
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

  /** @see DocDiskSyncService.reloadFromVaultChange */
  reloadFromVaultChange(
    vaultId: string | undefined,
    paths: readonly string[] | undefined,
  ): Promise<void> {
    return this.diskSync.reloadFromVaultChange(vaultId, paths);
  }

  /** @see DocDiskSyncService.resolveDiskChange */
  resolveDiskChange(key: string): Promise<void> {
    return this.diskSync.resolveDiskChange(key);
  }

  /** @see DocOpenService.openFile */
  openFile(
    relativePath: string,
    vaultId?: string,
    opts: {
      keepFocused?: boolean;
      prefetched?: { content: string; modifiedMs: number };
      pinned?: boolean;
    } = {},
  ): Promise<void> {
    return this.opener.openFile(relativePath, vaultId, opts);
  }

  /** @see DocOpenService.openExternalFile */
  openExternalFile(absolutePath: string): Promise<void> {
    return this.opener.openExternalFile(absolutePath);
  }

  /** @see DocOpenService.openFileAt */
  openFileAt(relativePath: string, line: number, vaultId?: string): Promise<void> {
    return this.opener.openFileAt(relativePath, line, vaultId);
  }

  /** id + target for `openFileAt`; `id === 0` means "nothing pending". */
  readonly revealRequest = this.opener.revealRequest;

  /** @see DocOpenService.openScratch */
  openScratch(path: string, content: string): void {
    this.opener.openScratch(path, content);
  }

  /** @see DocOpenService.openHelpDoc */
  openHelpDoc(path: string, name: string, content: string, assetBase = ''): void {
    this.opener.openHelpDoc(path, name, content, assetBase);
  }

  /** @see DocOpenService.openDailyNote */
  openDailyNote(dateStr: string): Promise<void> {
    return this.opener.openDailyNote(dateStr);
  }

  /** @see DocOpenService.newUntitled */
  newUntitled(): void {
    this.opener.newUntitled();
  }

  /** @see DocOpenService.addPluginDoc */
  addPluginDoc(kind: string, key: string, name: string): void {
    this.opener.addPluginDoc(kind, key, name);
  }

  /** Updates a plugin-doc tab's display name (e.g. the browser's page title). */
  renameDoc(key: string, name: string): void {
    const doc = this.docFor(key);
    if (doc === null || doc.kind === 'text') {
      return;
    }
    this.store.patch(key, { name });
  }

  /** Pins / unpins a tab; a no-op for a key that is not open. */
  togglePin(key: string): void {
    this.opener.togglePin(key);
  }

  /** Session restore: re-applies a persisted pin. */
  setPinned(key: string, pinned: boolean): void {
    this.opener.setPinned(key, pinned);
  }

  /**
   * Reveals a tab app-wide: focuses + activates whichever pane already has
   * it open (the "Open windows" list, File-menu style global commands).
   * Accepts a full tab key or a bare vault-relative path (resolved via
   * {@link resolveDoc}). No-op if it isn't open. A pane's *own* tab bar
   * activates within itself via `PaneService.activate` directly -- it
   * doesn't need this "search every pane" version of the same idea.
   */
  activate(keyOrPath: string): void {
    const doc = this.resolveDoc(keyOrPath);
    if (doc !== null) {
      this.panes.open(doc.key);
    }
  }

  /**
   * Closes a tab. A dirty tab asks first -- Save / Don't save / Cancel --
   * through the in-renderer dialog, since the native `confirm()` breaks
   * Windows keyboard focus (electron#41602). "Save" writes the buffer and
   * closes only if that really left nothing unsaved (a failed write or a
   * cancelled Save-As dialog keeps the tab open, like Cancel). Closing the
   * active tab activates its neighbour. `silent` skips the dirty prompt --
   * used when the underlying file was just deleted, where "keep editing"
   * is not an option. Resolves to whether the tab actually closed.
   */
  async closeTab(key: string, options: { silent?: boolean } = {}): Promise<boolean> {
    const doc = this.docFor(key);
    if (!doc) {
      return false;
    }
    if (!options.silent && isDirty(doc)) {
      const decision = await this.dialogs.decide({
        title: 'Unsaved changes',
        message: `Do you want to save the changes to ${doc.name}?`,
      });
      if (decision === 'cancel') {
        return false;
      }
      if (decision === 'save') {
        return this.saveAndClose(doc);
      }
    }
    this.store.remove(key);
    return true;
  }

  /**
   * The "Save" branch of {@link closeTab}. A never-saved scratch tab
   * (`askOnSave`) goes through Save-As and comes back re-keyed to the real
   * file, so it is that tab that closes. Anything still dirty afterwards
   * (write failed, dialog cancelled, typed into mid-save) keeps the tab.
   */
  private async saveAndClose(doc: OpenDoc): Promise<boolean> {
    let savedKey: string | null = doc.key;
    if (doc.askOnSave) {
      savedKey = await this.saveAs(doc.key);
    } else {
      await this.save({ key: doc.key });
    }
    const saved = savedKey === null ? null : this.docFor(savedKey);
    if (saved === null || isDirty(saved)) {
      return false;
    }
    return this.closeTab(saved.key, { silent: true });
  }

  /**
   * A pane's own tab-bar context menu: close every tab / every tab but one
   * *in that pane* -- a split's other panes are untouched. Each is routed
   * through `closeTab`, so a dirty tab still raises its own prompt and a
   * cancel there leaves that tab (and the rest) open. The key list is
   * snapshotted first (from `PaneService`) because `closeTab` mutates it.
   */
  async closeAll(paneId: string): Promise<void> {
    for (const key of this.panes.pane(paneId)?.tabs ?? []) {
      await this.closeTab(key);
    }
  }

  async closeOthers(paneId: string, keepKey: string): Promise<void> {
    for (const key of this.panes.pane(paneId)?.tabs ?? []) {
      if (key !== keepKey) {
        await this.closeTab(key);
      }
    }
  }

  /**
   * Silently closes every open tab under a path that was just deleted --
   * the file itself, or (for a folder) anything under it -- all within the
   * one vault `vaultId` names. No dirty prompt: the file is gone, there is
   * nothing to save it back to.
   */
  closeTabsUnder(vaultId: string | null, deletedPath: string): void {
    const prefix = `${docKey(vaultId, deletedPath)}/`;
    const deletedKey = docKey(vaultId, deletedPath);
    for (const doc of this.openDocs()) {
      if (doc.key === deletedKey || doc.key.startsWith(prefix)) {
        // Silent closes never await the dialog, so this runs fully
        // synchronously -- the delete flow depends on that.
        void this.closeTab(doc.key, { silent: true });
      }
    }
  }

  /** @see OpenDocsStore.retarget */
  retargetTabs(fromKey: string, toKey: string): void {
    this.store.retarget(fromKey, toKey);
  }

  /** Called by a pane's editor surface on every buffer change; `key` is that pane's shown document. */
  updateBuffer(key: string, content: string): void {
    const doc = this.docFor(key);
    if (!doc || doc.kind !== 'text' || doc.help !== undefined) {
      return;
    }
    this.store.patch(key, { bufferContent: content });
    this.scheduleAutoSave(doc);
  }

  /** @see CaretMemoryStore */
  private readonly carets = new CaretMemoryStore();

  /** Oldest entries fall off the caret memory past this many doc keys. */
  static readonly CARET_MEMORY_LIMIT = CARET_MEMORY_LIMIT;

  /**
   * Called by a pane's editor when it leaves a document (tab switch, pane
   * close): remember its viewport so the next fresh state for that doc key
   * lands on the SAME view instead of the top (milestone 50). Needs no
   * open doc -- the memory is what outlives the tab.
   */
  recordCaret(key: string, memory: CaretMemory): void {
    this.carets.record(key, memory);
  }

  /** The remembered viewport for `key`, or undefined when none was recorded. */
  caretFor(key: string): CaretMemory | undefined {
    return this.carets.get(key);
  }

  /**
   * Auto-save for app-owned files (ADR-0048): edits to a chat note or a
   * committed draft persist themselves after a short idle — the user never
   * saves them by hand and they never trip the exit prompt or an assistant
   * guard. `askOnSave` scratch tabs are deliberately excluded (their save
   * would open the Save-As dialog — the one prompt auto-save must not
   * produce); they commit at exit instead. The timer reads the LIVE buffer
   * at fire time (`save()` re-resolves the doc and no-ops when clean), so
   * a tab that reloaded from a chat-engine append in the meantime never
   * writes stale text over it.
   */
  /** Idle window before an app-owned file's edit persists itself. */
  static readonly AUTO_SAVE_DELAY_MS = 800;
  private readonly autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleAutoSave(doc: OpenDoc): void {
    if (!isAutoSavePath(doc.path)) {
      return;
    }
    if (doc.kind !== 'text' || doc.askOnSave) {
      return;
    }
    const existing = this.autoSaveTimers.get(doc.key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.autoSaveTimers.set(
      doc.key,
      setTimeout(() => {
        this.autoSaveTimers.delete(doc.key);
        void this.save({ key: doc.key, runOnSaveActions: false });
      }, EditorService.AUTO_SAVE_DELAY_MS),
    );
  }

  /**
   * Switches a tab's mode and remembers it as the default for future opens
   * (`⋯` menu). `key` defaults to the focused pane's document -- the
   * global Ctrl+S-style callers want that; a pane's own `⋯` menu passes its
   * own shown document explicitly, since that pane needn't be the focused
   * one. Persisted per machine, like the pane sizes.
   */
  setViewMode(mode: EditorViewMode, key?: string): void {
    const doc = key !== undefined ? this.docFor(key) : this.activeDoc();
    if (!doc || doc.kind !== 'text' || doc.help !== undefined) {
      return;
    }
    // Live Preview is Markdown-only; a code tab stays in source (its menu
    // item is hidden anyway).
    if (mode === 'live' && !isMarkdownPath(doc.path)) {
      return;
    }
    this.store.patch(doc.key, { viewMode: mode });
    this.prefs.setDefaultMode(mode);
  }

  /**
   * Saves a document. `options.key` defaults to the focused pane's
   * document (Ctrl+S, the File menu); a pane's own Save button passes its
   * own shown document. A caller may instead pass a bare vault-relative
   * `path` (plugin-facing surfaces) -- resolved via {@link resolveDoc}.
   *
   * Saves are SERIALIZED: a call landing while another save is in flight
   * waits for it instead of being dropped (the old `isSaving()` early
   * return silently lost rapid toggle edits -- a panel checkbox ticked
   * while the previous save was still running never reached disk, and the
   * next index pull "reset" the row). The doc is resolved inside the
   * chained run, so the trailing save sees the state as of its turn.
   */
  async save(options: SaveOptions = {}): Promise<void> {
    const run = this.saveQueue.then(() => this.saveNow(options));
    this.saveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Routes one save: external file, scratch tab without a location, or the vault pipeline. */
  private async saveNow(options: SaveOptions): Promise<void> {
    const doc =
      options.key !== undefined
        ? this.docFor(options.key)
        : options.path !== undefined
          ? this.resolveDoc(options.path)
          : this.activeDoc();
    if (!this.api || doc === null || doc.kind !== 'text') {
      return;
    }
    // An external doc saves in place through its own gated channel -- none
    // of the vault pipeline (frontmatter, index, hooks) applies (ADR-0054).
    if (doc.external === true) {
      await this.saver.saveExternal(doc);
      return;
    }
    // A generated scratch doc has no destination yet -- ask for one, even
    // if the buffer is untouched (the user wants to keep the export as-is).
    if (doc.askOnSave) {
      await this.saveAs(doc.key);
      return;
    }
    await this.saver.saveToVault(doc, options);
  }

  /**
   * File -> "Save all". Walks every open document in the registry, saving
   * the dirty ones, by explicit key -- doesn't touch pane focus/activation
   * at all. Each goes through `save()`, so a scratch tab still routes to
   * `saveAs()` and an untouched draft is skipped.
   *
   * The exit prompt (bug-5) passes `drafts: true`: an `askOnSave` scratch
   * tab is committed into the vault's hidden `.drafts/` folder instead of
   * opening a Save-As dialog nobody can meaningfully answer per-tab while
   * the app is going down, and `runOnSaveActions: false` keeps on-save
   * Actions (LLM round trips) out of shutdown.
   */
  async saveAll(options: { runOnSaveActions?: boolean; drafts?: boolean } = {}): Promise<void> {
    for (const doc of this.openDocs()) {
      if (doc.kind !== 'text' || (!isDirty(doc) && !doc.askOnSave)) {
        continue;
      }
      if (options.drafts && doc.askOnSave) {
        await this.saver.saveDraft(doc.key);
        continue;
      }
      await this.save({ key: doc.key, runOnSaveActions: options.runOnSaveActions });
    }
  }

  /**
   * "Save as…": pick a destination inside the document's own vault (a
   * vault-backed tab saves back into ITS vault so the note stays inside
   * its tree and index; a vault-less scratch tab roots the dialog at the
   * active vault), write the buffer there, and re-key the tab to the new
   * file. For a never-saved scratch doc this is where `save()` lands; on a
   * normal file it forks the buffer to a new path (the original on disk is
   * untouched). `key` defaults to the focused pane's document, like
   * `save()`. Resolves to the key of the tab now holding the saved file
   * (the doc's own key when it saved in place), or `null` when nothing was
   * saved (dialog cancelled, write failed) -- `closeTab`'s "Save" needs it
   * to close the swapped-in tab too.
   */
  async saveAs(key?: string): Promise<string | null> {
    const doc = key !== undefined ? this.docFor(key) : this.activeDoc();
    if (!this.api?.pickSavePath || doc === null || doc.kind !== 'text' || this.isSaving()) {
      return null;
    }
    this.error.set(null);
    const targetVault = doc.vaultId ?? this.vault.activeVaultId();
    let target: string | null;
    try {
      target = await this.api.pickSavePath(doc.name, targetVault ?? undefined);
    } catch (err) {
      this.store.fail(err);
      return null;
    }
    if (target === null) {
      return null; // cancelled
    }
    if (target === doc.path && doc.vaultId === targetVault && !doc.askOnSave) {
      await this.save({ key: doc.key });
      return doc.key;
    }

    if (!(await this.saver.writeCopy(doc, target, targetVault))) {
      return null;
    }

    // Swap the scratch/old tab for the real file, then load it fresh so the
    // buffer, mtime and `existsOnDisk` come from disk. `keepFocused`: the
    // close above already picked this open's tab -- without it the pane's
    // newly-activated neighbour would be read as the replace victim.
    const savedKey = docKey(targetVault, target);
    void this.closeTab(doc.key, { silent: true });
    await this.openFile(target, targetVault ?? undefined, { keepFocused: true });
    if (doc.pinned === true) {
      this.setPinned(savedKey, true);
    }
    // Moving a file out of `.drafts/` (bug-5's exit auto-saves) deletes the
    // draft original -- move semantics, so drafts don't linger in two
    // places, and permanent (a recycle-bin copy would pile up on every
    // save-as; the content lives at the target).
    if (doc.vaultId !== null && doc.path.startsWith('.drafts/') && doc.path !== target) {
      try {
        await this.vault.deleteEntry(doc.path, doc.vaultId, { trash: false });
      } catch {
        // The original staying behind is annoying, not fatal.
      }
    }
    void this.vault.refresh();
    return this.docFor(savedKey) !== null ? savedKey : null;
  }

  /**
   * "Export as PDF…" (editor `⋯` menu, tab context menu): main renders and
   * prints the note; the save dialog lives main-side. The live buffer is
   * always sent, so dirty tabs and scratch (untitled) notes export exactly
   * what the user sees -- and a scratch export never needs the disk read a
   * missing `content` would trigger. `key` defaults to the focused pane's
   * document, like `saveAs()`; cancelled dialogs resolve silently.
   */
  async exportPdf(key?: string): Promise<void> {
    const doc = key !== undefined ? this.docFor(key) : this.activeDoc();
    if (!this.api?.exportNotePdf || doc === null || doc.kind !== 'text') {
      return;
    }
    this.error.set(null);
    try {
      await this.api.exportNotePdf({
        path: doc.path,
        vaultId: doc.vaultId ?? undefined,
        content: doc.bufferContent,
      });
    } catch (err) {
      this.store.fail(err);
    }
  }

  /**
   * Adopts an Action / Ask-mode rewrite of an open document: pushes
   * `content` into the tab's buffer and saves it with the on-save Action
   * hook suppressed (so applying one action can't recurse into another).
   * `path` is what the plugin surface holds -- a bare vault-relative path,
   * resolved via {@link resolveDoc}. No-op when it isn't open.
   */
  async applyRewrite(path: string, content: string): Promise<void> {
    const doc = this.resolveDoc(path);
    if (!doc || content === doc.bufferContent) {
      return;
    }
    this.panes.open(doc.key); // reveal: focuses + activates wherever it is
    this.store.patch(doc.key, { bufferContent: content });
    await this.save({ runOnSaveActions: false, key: doc.key, origin: 'assistant' });
  }
}
