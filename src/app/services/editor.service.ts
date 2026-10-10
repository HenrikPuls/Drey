import { Injectable, computed, inject, signal } from '@angular/core';
import { imageExtension, pdfExtension } from '../../../shared/asset-name';
import { externalDocumentExtension } from '../../../shared/external-document';
import { dailyPathFor } from '../../../shared/daily';
import { externalDocKey } from '../../../shared/external-open';
import { ActionOutcome, NoteSaveRequest } from '../../../shared/ipc-api';
import { isAutoSavePath, isChatNotePath } from '../../../shared/structural-folders';
import { ConflictService } from '../conflict';
import { EditorCommandsService } from '../editor/editor-commands.service';
import { refreshChangedAssets } from '../editor/vault-image';
import { EditorPrefsService, EditorViewMode } from '../editor/editor-prefs.service';
import { PaneService } from '../panes/pane.service';
import { VaultService } from '../vault';
import { ConfirmDialogService } from './confirm-dialog.service';
import { FileOpenerRegistry } from './file-opener-registry.service';
import { SettingsService } from './settings.service';

/** Re-exported for existing importers (`Editor`, specs); defined in `markdown-frontmatter.ts`. */
export { stripFrontmatter } from '../editor/markdown-frontmatter';
/** Re-exported for existing importers; defined in the split-out collaborators. */
export type { EditorViewMode } from '../editor/editor-prefs.service';
export type { NewEntryRequest } from '../editor/editor-commands.service';

/**
 * The tab-identity string for a vault document: `` `${vaultId}::${path}` ``.
 * The vault id (ADR-0051) scopes the namespace, so the same relative path
 * in two vaults is two documents. A vault-less doc (a scratch tab, a
 * registered plugin kind like `browser://1`) uses the bare string as its
 * key -- `:` cannot occur in a minted vault id, in a Windows path segment,
 * and `://` keeps plugin keys away from vault paths, so the key space is
 * collision-free.
 */
export function docKey(vaultId: string | null, path: string): string {
  return vaultId !== null && vaultId !== '' ? `${vaultId}::${path}` : path;
}

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
   * The doc's vault id (ADR-0051). `null` for docs that belong to no
   * vault: a never-located scratch tab, or a registered plugin kind
   * (`browser://<n>`).
   */
  readonly vaultId: string | null;
  /**
   * Vault-relative path, e.g. `daily/2026-09-05.md` -- what every IPC call
   * speaks. What identifies the TAB across panes/sessions is {@link key}.
   * For a `kind: 'browser'` tab this is the synthetic key `browser://<n>`.
   */
  readonly path: string;
  /**
   * Tab identity (see {@link docKey}): every pane / tab-bar / session /
   * drag consumer keys on this. `path` remains the vault-relative path for
   * IPC and display.
   */
  readonly key: string;
  /** For a browser tab this follows the page title as it loads (via `patchDoc`). */
  readonly name: string;
  /**
   * `'text'` (a Markdown/code buffer, the default), `'image'` (a viewer
   * tab for a `.png`/`.jpg`/… file, ADR-0026) and `'pdf'` (a viewer tab
   * for a `.pdf` file over the built-in PDFium viewer, ADR-0052) are the
   * base kinds. Anything else is a registered doc kind (ADR-0044 stage
   * 8A) -- the browser tab (`browser://<n>`, ADR-0042) today, plugin tabs
   * from stage 8B -- resolved through the `DocKindRegistry` by the pane
   * body, the tab strip and the session. The non-text kinds carry no
   * buffer (`savedContent === bufferContent === ''`, never dirty); they
   * skip every text-only path (`save`, `saveAs`, `setViewMode`,
   * `updateBuffer`).
   */
  readonly kind: string;
  savedContent: string;
  bufferContent: string;
  viewMode: EditorViewMode;
  /** Line ending this file uses on disk; the buffer is always held in `\n`. */
  eol: '\n' | '\r\n';
  /** `modifiedMs` from the last read/write -- round-tripped for the future file watcher. */
  modifiedMs: number;
  existsOnDisk: boolean;
  /**
   * The file changed on disk while this tab holds unsaved edits (ADR-0060)
   * -- noticed by the watcher round, shown in the meta bar, settled through
   * `EditorService.resolveDiskChange` or by the next save's own check.
   */
  diskChanged?: boolean;
  /**
   * `true` for a generated scratch doc (the tag-search export) that has no
   * intended location: `save()` routes to `saveAs()` so the user picks one.
   * Daily-note drafts leave this `false` -- they save to their own path. A
   * plugin doc kind tab does not carry this either -- it saves nothing.
   */
  askOnSave?: boolean;
  /**
   * A pinned tab is never the tab another file replaces (milestone 32's
   * clean-tab replacement, see `EditorService.replacedTabCandidate`): the
   * next file opens in a new tab beside it. Persisted with the session;
   * closing a pinned tab stays an explicit act.
   */
  pinned?: boolean;
  /**
   * An out-of-vault file the OS handed to Drey (Explorer "Open with",
   * ADR-0054). `path` is its ABSOLUTE path (shown in the meta bar, never sent
   * over a vault IPC), `vaultId` is `null`, the key is `external://…`. It is
   * edited like any note and saved IN PLACE through the gated
   * `external:write` channel (no vault pipeline: no frontmatter bump, no
   * index, no hooks); it opens pinned. "Save as…" copies it into a vault.
   */
  external?: boolean;
}

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
 * class no longer owns which documents are tabs or which is active -- it
 * owns the documents themselves, and `activePath`/`activeDoc` (and everything
 * derived from them: `isDirty`, `save()`, word count, ...) now mean "the
 * *focused pane's* active document". That is deliberate: ~20 other files
 * (Assistant, Tasks, Actions, the status bar, MCP tools, keybindings, the
 * calendar, tag search's "open at line", ...) all read this single
 * "current document" and none of them need to become pane-aware -- only
 * `TabBar` and `Editor` do (see `PaneService`'s doc comment for the pane
 * model itself: one pane per document, an arbitrary split tree).
 *
 * Since ADR-0051 a document knows its vault: `path` stays vault-relative
 * (what IPC speaks and UI displays), while {@link key} -- `vaultId::path`
 * -- is the tab identity, so the same relative path from two vaults opens
 * as two independent tabs. Pane tabs, drag payloads and session snapshots
 * all carry keys. IPC calls always go out with the doc's own `vaultId`.
 *
 * Switching tabs never prompts -- unsaved buffers are just kept in memory;
 * only closing a dirty tab asks (CLAUDE.md build order, item 5).
 */
@Injectable({ providedIn: 'root' })
export class EditorService {
  private readonly vault = inject(VaultService);
  private readonly panes = inject(PaneService);
  private readonly prefs = inject(EditorPrefsService);
  private readonly commands = inject(EditorCommandsService);
  private readonly dialogs = inject(ConfirmDialogService);
  private readonly settings = inject(SettingsService);
  private readonly conflicts = inject(ConflictService);
  private readonly fileOpeners = inject(FileOpenerRegistry);

  private readonly docs = signal<OpenDoc[]>([]);

  /** Every open document (the registry), regardless of which pane shows it. */
  readonly openDocs = this.docs.asReadonly();
  /**
   * Tab key of the focused pane's active tab, or null when nothing is
   * open. (The historical name stays -- most consumers only compare it
   * against `doc.key` / pass it back into `docFor`.)
   */
  readonly activePath = computed<string | null>(() => this.panes.focusedPane()?.active ?? null);

  /**
   * Live-edit locks (ADR-0049): docs whose user input is blocked while the
   * assistant edits them. Advisory UX protection, not a hard invariant —
   * held per doc key, released by the owner (the assistant panel) at turn end.
   */
  private readonly editLocks = signal<ReadonlySet<string>>(new Set());

  /**
   * Docs the assistant has edited since their last save (a live-edit lock
   * was taken, or a confirmed rewrite applied): that save tells the local
   * history so -- its version is always recorded, never throttled away
   * like the user's own saves (ADR-0060).
   */
  private readonly assistantEdited = new Set<string>();

  /** Adds or removes `key`'s user-input lock. Unknown keys are ignored. */
  setEditLock(key: string, locked: boolean): void {
    if (locked) {
      this.assistantEdited.add(key);
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

  private readonly activeDoc = computed<OpenDoc | null>(
    () => this.docs().find((d) => d.key === this.activePath()) ?? null,
  );

  /** The `OpenDoc` whose TAB is `key`, or null if it isn't open. */
  docFor(key: string | null): OpenDoc | null {
    return key === null ? null : (this.docs().find((d) => d.key === key) ?? null);
  }

  /**
   * Resolves a doc from what a caller may hold: a full tab key (panes,
   * session) or a bare vault-relative path (plugin-facing surfaces, which
   * never see keys). A bare path resolves to the active vault's doc first,
   * then -- when unambiguous -- to the one open doc with that path in any
   * vault. Returns null when it matches nothing (or would be ambiguous).
   */
  resolveDoc(keyOrPath: string): OpenDoc | null {
    const byKey = this.docFor(keyOrPath);
    if (byKey !== null) {
      return byKey;
    }
    const activeVaultId = this.vault.activeVaultId();
    if (activeVaultId !== null) {
      const inActive = this.docFor(docKey(activeVaultId, keyOrPath));
      if (inActive !== null) {
        return inActive;
      }
    }
    const matches = this.docs().filter((d) => d.path === keyOrPath);
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Vault-relative path of the open file. Kept as the historical name so
   * `App` / `Sidebar` / `DailyNoteService` don't need to care that there's
   * now more than one buffer.
   */
  readonly openPath = computed<string | null>(() => this.activeDoc()?.path ?? null);
  /** Vault id of the open file (ADR-0051), or null for vault-less docs. */
  readonly openVaultId = computed<string | null>(() => this.activeDoc()?.vaultId ?? null);
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

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  /** Serialization tail for `save()` — always resolved, unlike the per-call promises. */
  private saveQueue: Promise<void> = Promise.resolve();
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
   * (ADR-0011). Set by `save()`; the plugin host consumes the queue when it
   * synthesizes the `pending-actions` document event, so the assistant
   * plugin (the queue's owner since ADR-0044 stage 7) routes them through
   * the shared confirmation dialog.
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

  constructor() {
    // External-change auto-reload (ADR-0045): the `vault:changed` push
    // carries the changed `.md` paths (scoped to one vault since ADR-0051);
    // clean tabs among them re-read from disk here. Lives for the app's
    // lifetime -- no teardown.
    if (typeof window !== 'undefined' && typeof window.dreyApi?.onVaultChanged === 'function') {
      window.dreyApi.onVaultChanged((push) => {
        if (push.paths !== undefined && typeof document !== 'undefined') {
          refreshChangedAssets(push.vaultId, push.paths, document);
        }
        void this.reloadFromVaultChange(push.vaultId, push.paths);
      });
    }
  }

  /**
   * Re-reads every open **clean** text tab whose file is in `paths` from
   * disk -- the renderer half of the watcher round (ADR-0045, req-14).
   * `vaultId` scopes the round to one vault's tabs (ADR-0051); when absent
   * the paths are matched against every vault's tabs (a push from an older
   * main). A dirty tab keeps its buffer and is marked `diskChanged`
   * instead -- the conflict is the user's to settle (ADR-0060). A file
   * that no longer exists flips its tab to draft semantics
   * (`existsOnDisk: false`) -- the tab stays open and the next edit + save
   * resurrects the file. `paths === undefined` (a full refresh -- huge
   * batch or manual refresh) never touches tabs.
   */
  async reloadFromVaultChange(
    vaultId: string | undefined,
    paths: readonly string[] | undefined,
  ): Promise<void> {
    if (!paths || paths.length === 0 || typeof this.api?.readVaultFile !== 'function') {
      return;
    }
    const changed = new Set(paths);
    // Chat notes follow the disk EVEN when the tab is dirty: the chat
    // engine appends every turn to the file (the note is the source of
    // truth, ADR-0048), so the tab is a view of it, not an independent
    // buffer. Only typing inside the auto-save window can be lost —
    // sub-second, and the conversation content always wins. Every other
    // dirty tab keeps its buffer and is only MARKED (`diskChanged`): which
    // version survives is the user's call (ADR-0060).
    const targets = this.docs().filter(
      (d) =>
        d.kind === 'text' &&
        d.existsOnDisk &&
        d.external !== true &&
        (vaultId === undefined || d.vaultId === vaultId) &&
        changed.has(d.path),
    );
    for (const doc of targets) {
      const follows = doc.bufferContent === doc.savedContent || isChatNotePath(doc.path);
      try {
        const { content, modifiedMs } = await this.api.readVaultFile(doc.path, doc.vaultId ?? undefined);
        // Same normalization as `makeDoc`: hold `\n` in the buffer, keep
        // the file's dominant ending for the write-back.
        const normalized = content.replace(/\r\n/g, '\n');
        if (!follows) {
          if (normalized !== doc.savedContent) {
            this.patchDoc(doc.key, { diskChanged: true });
          }
          continue;
        }
        if (normalized !== doc.savedContent) {
          // The tab is the last place that still knows the previous text.
          this.captureHistory(doc, doc.savedContent, 'external');
        }
        this.patchDoc(doc.key, {
          savedContent: normalized,
          bufferContent: normalized,
          eol: content.includes('\r\n') ? '\r\n' : '\n',
          modifiedMs,
          existsOnDisk: true,
          diskChanged: false,
        });
      } catch {
        if (follows) {
          this.patchDoc(doc.key, { existsOnDisk: false });
        }
      }
    }
  }

  /**
   * The meta bar's "Changed on disk" button: settles a marked tab without
   * saving, through the same merge dialog. A result that is exactly the
   * disk version reloads the tab (the buffer goes into the history); any
   * other result becomes the buffer on top of the disk state, both
   * versions recorded, and the next save writes it.
   */
  async resolveDiskChange(key: string): Promise<void> {
    const doc = this.docFor(key);
    if (!this.api || doc === null || doc.kind !== 'text') {
      return;
    }
    let disk: { content: string; modifiedMs: number };
    try {
      disk = await this.api.readVaultFile(doc.path, doc.vaultId ?? undefined);
    } catch {
      // Gone again: nothing to compare with; a save recreates the file.
      this.patchDoc(key, { diskChanged: false });
      return;
    }
    const normalized = disk.content.replace(/\r\n/g, '\n');
    let buffer = doc.bufferContent;
    if (normalized !== doc.savedContent) {
      const merged = await this.conflicts.ask({
        path: doc.path,
        base: doc.savedContent,
        disk: normalized,
        mine: buffer,
        saving: false,
      });
      if (merged === null) {
        return;
      }
      if (merged === normalized) {
        await this.adoptDisk(key);
        return;
      }
      // The next save overwrites the disk version; a plain save's history
      // record is throttled, so keep it now. A merge also replaces the
      // buffer as it was.
      this.captureHistory(doc, normalized, 'conflict');
      if (merged !== buffer) {
        this.captureHistory(doc, buffer, 'conflict');
        buffer = merged;
      }
    }
    // The tab now knowingly sits on top of the disk state.
    this.patchDoc(key, {
      savedContent: normalized,
      bufferContent: buffer,
      modifiedMs: disk.modifiedMs,
      diskChanged: false,
    });
  }

  /** Replaces a tab's buffer with the file on disk; the buffer goes into the history first. */
  private async adoptDisk(key: string): Promise<void> {
    const doc = this.docFor(key);
    if (!this.api || doc === null) {
      return;
    }
    this.captureHistory(doc, doc.bufferContent, 'conflict');
    try {
      const { content, modifiedMs } = await this.api.readVaultFile(doc.path, doc.vaultId ?? undefined);
      const normalized = content.replace(/\r\n/g, '\n');
      this.patchDoc(key, {
        savedContent: normalized,
        bufferContent: normalized,
        eol: content.includes('\r\n') ? '\r\n' : '\n',
        modifiedMs,
        existsOnDisk: true,
        diskChanged: false,
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Best-effort history record of text only this tab still holds (ADR-0060). */
  private captureHistory(doc: OpenDoc, content: string, origin: string): void {
    if (doc.vaultId === null || typeof this.api?.captureNoteHistory !== 'function') {
      return;
    }
    void this.api.captureNoteHistory(doc.path, content, origin, doc.vaultId).catch(() => undefined);
  }

  /**
   * Opens a file in a tab. `vaultId` defaults to the active vault. If it's
   * already open, just activates that tab. Never prompts -- a dirty buffer
   * for another file stays in memory.
   *
   * Tab replacement (milestone 32): when the new file opens, the focused
   * pane's *clean* active tab is closed with it -- following documents
   * replaces the view instead of accumulating tabs. A dirty focused tab
   * stays and the new file opens alongside. Only file-view kinds qualify
   * (see {@link replacedTabCandidate}); the already-open reveal path never
   * closes anything, and a failed read keeps the tab. Internal composition
   * flows pass `keepFocused: true`: the session restore reopens the whole
   * saved tab set, `saveAs` swaps the tab itself, and the Files panel's
   * multi-select open replaces only on its first call.
   *
   * `prefetched` (milestone 61): a file read already in flight (the
   * session restore fires all of its reads in parallel) — the content is
   * used as-is instead of a second read. The raw (CRLF-intact) content,
   * exactly as `readVaultFile` would return it.
   *
   * `pinned`: the new tab is pinned right away (the Files tree's
   * "Open in new tab") -- never the tab another open replaces, and the pin
   * rides the session snapshot. An already-open tab is revealed and pinned.
   */
  async openFile(
    relativePath: string,
    vaultId?: string,
    opts: {
      keepFocused?: boolean;
      prefetched?: { content: string; modifiedMs: number };
      pinned?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.api) {
      return;
    }
    const victim = opts.keepFocused === true ? null : this.replacedTabCandidate();
    const pin = opts.pinned === true ? { pinned: true } : {};
    const resolvedVault = vaultId ?? this.vault.activeVaultId();
    const key = docKey(resolvedVault, relativePath);
    if (this.docs().some((d) => d.key === key)) {
      // Already open -- reveal it (focus + activate whichever pane has it;
      // a document lives in one pane at a time, see `PaneService`). A pin
      // request still applies ("Open in new tab" on an already-open file
      // means reveal + pin -- the "keep this one" intent lands either way).
      this.panes.open(key);
      if (opts.pinned === true) {
        this.setPinned(key, true);
      }
      return;
    }

    // A plugin that claims this name suffix opens it as its own doc kind
    // (SDK 1.16, ADR-0064) -- asked first, because `.drawio.svg` would
    // otherwise be an image.
    if (this.fileOpeners.open(relativePath, resolvedVault)) {
      this.closeReplacedTab(victim);
      return;
    }

    // An Office document (or another type on the allowlist) opens in its
    // own program, not in a tab (ADR-0066) -- so no tab is replaced either.
    if (externalDocumentExtension(relativePath)) {
      try {
        await this.api.openVaultFileExternally(relativePath, resolvedVault ?? undefined);
      } catch (err) {
        this.error.set(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // An image file opens as a viewer tab -- never read as text (that used
    // to open a mojibake buffer that Ctrl+S would write back).
    if (imageExtension(relativePath)) {
      this.addDoc({ ...this.makeImageDoc(relativePath, resolvedVault), ...pin });
      this.closeReplacedTab(victim);
      return;
    }

    // Same for a PDF (ADR-0052): the built-in (PDFium) viewer tab, never a
    // text buffer.
    if (pdfExtension(relativePath)) {
      this.addDoc({ ...this.makePdfDoc(relativePath, resolvedVault), ...pin });
      this.closeReplacedTab(victim);
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);
    try {
      const { content, modifiedMs } =
        opts.prefetched ??
        (await this.api.readVaultFile(relativePath, resolvedVault ?? undefined));
      this.addDoc({
        ...this.makeDoc(relativePath, resolvedVault, content, modifiedMs, true),
        ...pin,
      });
      this.closeReplacedTab(victim);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Opens a file the OS handed to Drey that sits in NO registered vault
   * (ADR-0054): a pinned, editable tab keyed `external://<path>` that saves
   * back to that path. Main only serves the read (and write) for paths it
   * collected from the OS itself. Already open
   * -> just reveal it. Being pinned, it is never the tab another file
   * replaces, and opening it never replaces the focused tab either.
   */
  async openExternalFile(absolutePath: string): Promise<void> {
    if (!this.api) {
      return;
    }
    const key = externalDocKey(absolutePath);
    if (this.docs().some((d) => d.key === key)) {
      this.panes.open(key);
      return;
    }
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const { content, modifiedMs } = await this.api.readExternalFile(absolutePath);
      const doc = this.makeDoc(absolutePath, null, content, modifiedMs, true);
      this.addDoc({
        ...doc,
        key,
        name: baseName(absolutePath.replace(/\\/g, '/')),
        external: true,
        pinned: true,
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * The tab opening another file may replace: the focused pane's active
   * tab if it qualifies, else -- when the active tab is **pinned** -- the
   * pane's rightmost tab that does. Qualifying means a **clean** file-view
   * doc (text, image or pdf) whose content is on disk, so closing it loses
   * nothing, and not pinned. A dirty tab stays; a registered plugin doc
   * kind (`browser://…`) stays (its live state is not behind the file, so
   * no re-open would bring it back); a pinned tab stays (the user asked
   * for it to stay) and hands the replacement to an unpinned neighbour, so
   * browsing from a pinned reference note reuses the "preview" slot rather
   * than piling up tabs. A dirty or plugin *active* tab does not delegate:
   * the new file opens alongside, as before. `null` when nothing is
   * focused or nothing qualifies.
   */
  private replacedTabCandidate(): string | null {
    const pane = this.panes.focusedPane();
    const active = this.docFor(pane?.active ?? null);
    if (pane === null || active === null) {
      return null;
    }
    if (active.pinned !== true) {
      return this.isReplaceable(active) ? active.key : null;
    }
    for (const key of [...pane.tabs].reverse()) {
      const doc = this.docFor(key);
      if (doc !== null && this.isReplaceable(doc)) {
        return key;
      }
    }
    return null;
  }

  private isReplaceable(doc: OpenDoc): boolean {
    return (
      doc.pinned !== true &&
      (doc.kind === 'text' || doc.kind === 'image' || doc.kind === 'pdf') &&
      doc.bufferContent === doc.savedContent
    );
  }

  /** Pins / unpins a tab; a no-op for a key that is not open. */
  togglePin(key: string): void {
    const doc = this.docFor(key);
    // An external tab is permanently pinned (ADR-0054).
    if (doc !== null && doc.external !== true) {
      this.patchDoc(key, { pinned: doc.pinned !== true });
    }
  }

  /** Session restore: re-applies a persisted pin. */
  setPinned(key: string, pinned: boolean): void {
    if (this.docFor(key) !== null) {
      this.patchDoc(key, { pinned });
    }
  }

  /**
   * Closes the tab captured by {@link replacedTabCandidate} -- after the
   * new file is safely open. Re-checks cleanliness: if the buffer turned
   * dirty while the read was in flight (the user typed into it), the tab
   * stays, per the same rule that never closes a dirty tab.
   */
  private closeReplacedTab(victim: string | null): void {
    if (victim === null) {
      return;
    }
    const doc = this.docFor(victim);
    if (doc === null || !this.isReplaceable(doc)) {
      return;
    }
    // The doc is clean at this instant, so no dialog can fire.
    void this.closeTab(victim, { silent: true });
  }

  /**
   * Opens `relativePath` and asks the editor to put the caret at the start
   * of 1-based `line` (a tag-search hit lands here). The `Editor` component
   * consumes `revealRequest` once the buffer for that document is loaded.
   */
  async openFileAt(relativePath: string, line: number, vaultId?: string): Promise<void> {
    await this.openFile(relativePath, vaultId);
    const key = docKey(vaultId ?? this.vault.activeVaultId(), relativePath);
    if (this.docs().some((d) => d.key === key)) {
      this.revealRequest.update((r) => ({ id: r.id + 1, key, line }));
    }
  }

  /** id + target for `openFileAt`; `id === 0` means "nothing pending". */
  readonly revealRequest = signal<{ id: number; key: string; line: number }>({
    id: 0,
    key: '',
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
    if (this.docs().some((d) => d.key === path)) {
      this.patchDoc(path, patch);
      this.panes.open(path);
      return;
    }
    const doc = this.makeDoc(path, null, normalized, 0, false, true);
    this.addDoc({ ...doc, savedContent: '' });
  }

  /**
   * Opens the daily note for `dateStr` (`YYYY-MM-DD`) in the ACTIVE vault,
   * under the configured daily folder (`AppConfig.daily.dir`, default
   * `daily/`). If the file exists -- nested, or as a legacy flat file
   * inside that folder -- it's opened normally; otherwise a **draft** tab
   * is opened from the template -- nothing hits disk until the user types
   * and saves. Whatever an older folder setting wrote is never read here.
   *
   * Same tab replacement as {@link openFile}: clicking through the calendar
   * follows days instead of accumulating one clean tab per day.
   */
  async openDailyNote(dateStr: string): Promise<void> {
    if (!this.api) {
      return;
    }
    const victim = this.replacedTabCandidate();
    const vaultId = this.vault.activeVaultId();
    const dir = this.settings.dailyDir();
    const nestedPath = dailyPathFor(dateStr, dir);
    const legacyPath = `${dir}/${dateStr}.md`;
    // A note this session may already be open under either layout.
    for (const candidate of [nestedPath, legacyPath]) {
      const key = docKey(vaultId, candidate);
      if (this.docs().some((d) => d.key === key)) {
        this.panes.open(key);
        return;
      }
    }

    this.isLoading.set(true);
    this.error.set(null);
    try {
      // Prefer the nested layout; fall back to a pre-existing flat file;
      // otherwise open an unsaved draft at the nested path.
      const existing =
        (await this.tryReadDaily(nestedPath, vaultId)) ??
        (await this.tryReadDaily(legacyPath, vaultId));
      if (existing) {
        this.addDoc(this.makeDoc(existing.path, vaultId, existing.content, existing.modifiedMs, true));
        this.closeReplacedTab(victim);
      } else {
        const template = await this.api.buildDailyNoteContent(dateStr);
        this.addDoc(this.makeDoc(nestedPath, vaultId, template, 0, false));
        this.closeReplacedTab(victim);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  private async tryReadDaily(
    path: string,
    vaultId: string | null,
  ): Promise<{ path: string; content: string; modifiedMs: number } | null> {
    try {
      const { content, modifiedMs } = await this.api!.readVaultFile(path, vaultId ?? undefined);
      return { path, content, modifiedMs };
    } catch {
      return null;
    }
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
    const doc = this.docs().find((d) => d.key === key);
    if (!doc) {
      return false;
    }
    if (!options.silent && doc.bufferContent !== doc.savedContent) {
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
    // Pane placement first (picks the neighbour to activate there), then
    // drop the buffer -- a document lives in one pane at a time, so this
    // closes its one and only tab.
    this.panes.closeEverywhere(key);
    this.docs.update((list) => list.filter((d) => d.key !== key));
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
    if (saved === null || saved.bufferContent !== saved.savedContent) {
      return false;
    }
    return this.closeTab(saved.key, { silent: true });
  }

  /**
   * A pane's own tab-bar context menu: close every tab / every tab but one
   * *in that pane* -- a split's other panes are untouched. Each is routed
   * through `closeTab`, so a dirty tab still raises its own `confirm()` and
   * a cancel there leaves that tab (and the rest) open. The key list is
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
    for (const doc of this.docs()) {
      if (doc.key === deletedKey || doc.key.startsWith(prefix)) {
        // Silent closes never await the dialog, so this runs fully
        // synchronously -- the delete flow depends on that.
        void this.closeTab(doc.key, { silent: true });
      }
    }
  }

  /**
   * A file or folder was renamed/moved on disk: re-point any open tab at
   * its new key, keeping the buffer so unsaved edits survive the rename.
   * Both arguments are full TAB KEYS (see {@link docKey}) -- a cross-vault
   * move retargets the tab into the other vault's namespace the same way a
   * folder rename moves it under a prefix. For a folder rename every tab
   * under it moves.
   */
  retargetTabs(fromKey: string, toKey: string): void {
    const prefix = `${fromKey}/`;
    const remap = (p: string): string | null =>
      p === fromKey ? toKey : p.startsWith(prefix) ? toKey + p.slice(fromKey.length) : null;

    this.docs.update((list) =>
      list.map((d) => {
        const nextKey = remap(d.key);
        if (nextKey === null) {
          return d;
        }
        // Pane placement references the same key string, so re-point it
        // there too before the registry's own key changes underneath it.
        this.panes.renamePath(d.key, nextKey);
        return {
          ...d,
          key: nextKey,
          vaultId: toVaultIdOf(nextKey),
          path: toPathOf(nextKey),
          name: baseName(toPathOf(nextKey)),
        };
      }),
    );
  }

  /** Called by a pane's editor surface on every buffer change; `key` is that pane's shown document. */
  updateBuffer(key: string, content: string): void {
    const doc = this.docs().find((d) => d.key === key);
    if (!doc || doc.kind !== 'text') {
      return;
    }
    this.patchDoc(key, { bufferContent: content });
    this.scheduleAutoSave(doc);
  }

  /**
   * Caret memory (milestone 50): the last known caret (CodeMirror head
   * offset) AND scroll offset per doc key, kept for the WHOLE APP SESSION
   * -- deliberately decoupled from the doc records, because a clean tab
   * is REPLACED when another file opens (milestone 32) and the memory
   * must survive that close/reopen cycle too. Purely in-memory: nothing
   * rides into the session snapshot, and a restart starts empty.
   * Bounded FIFO past {@link CARET_MEMORY_LIMIT}.
   */
  private readonly carets = new Map<string, CaretMemory>();

  /** Oldest entries fall off the caret memory past this many doc keys. */
  static readonly CARET_MEMORY_LIMIT = 200;

  /**
   * Called by a pane's editor when it leaves a document (tab switch, pane
   * close): remember its viewport so the next fresh state for that doc key
   * lands on the SAME view instead of the top (milestone 50). Needs no
   * open doc -- the memory is what outlives the tab.
   */
  recordCaret(key: string, memory: CaretMemory): void {
    const prior = this.carets.get(key);
    if (
      prior !== undefined &&
      prior.head === memory.head &&
      prior.scrollTop === memory.scrollTop &&
      prior.caretRel === memory.caretRel
    ) {
      return;
    }
    if (this.carets.size >= EditorService.CARET_MEMORY_LIMIT && prior === undefined) {
      const oldest = this.carets.keys().next().value;
      if (oldest !== undefined) {
        this.carets.delete(oldest);
      }
    }
    this.carets.set(key, memory);
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
    if (!doc || doc.kind !== 'text') {
      return;
    }
    // Live Preview is Markdown-only; a code tab stays in source (its menu
    // item is hidden anyway).
    if (mode === 'live' && !isMarkdownPath(doc.path)) {
      return;
    }
    this.patchDoc(doc.key, { viewMode: mode });
    this.prefs.setDefaultMode(mode);
  }

  /**
   * Saves a buffer through the tag pipeline (`note:save`): the main process
   * merges inline `#tag`s into the frontmatter, bumps `updated:`, and
   * routes tagged entries into their topic's master document. The returned
   * `content` is the rewritten note -- adopted as both saved and buffer
   * text, so the editor shows the merged frontmatter and the tab is clean.
   * Any master doc that got a routed History entry and is open in another
   * (clean) tab is reloaded from disk. No-op when nothing changed.
   *
   * `options.key` defaults to the focused pane's document (Ctrl+S, the
   * File menu); a pane's own Save button passes its own shown document.
   * A caller may instead pass a bare vault-relative `path` (plugin-facing
   * surfaces) -- resolved via {@link resolveDoc}.
   */
  /**
   * Saves are SERIALIZED: a call landing while another save is in flight
   * waits for it instead of being dropped (the old `isSaving()` early
   * return silently lost rapid toggle edits -- a panel checkbox ticked
   * while the previous save was still running never reached disk, and the
   * next index pull "reset" the row). The doc is resolved inside the
   * chained run, so the trailing save sees the state as of its turn.
   */
  async save(
    options: { runOnSaveActions?: boolean; key?: string; path?: string; origin?: string } = {},
  ): Promise<void> {
    const run = this.saveQueue.then(() => this.saveNow(options));
    this.saveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async saveNow(
    options: { runOnSaveActions?: boolean; key?: string; path?: string; origin?: string } = {},
  ): Promise<void> {
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
      await this.saveExternal(doc);
      return;
    }
    // A generated scratch doc has no destination yet -- ask for one, even
    // if the buffer is untouched (the user wants to keep the export as-is).
    if (doc.askOnSave) {
      await this.saveAs(doc.key);
      return;
    }
    if (doc.bufferContent === doc.savedContent) {
      return;
    }

    const wasDraft = doc.existsOnDisk === false;
    // What this save is committing — a buffer edited while the save runs
    // (a checkbox ticked mid-save, typing) must not be clobbered by the
    // response.
    let sentBody = doc.bufferContent;

    this.isSaving.set(true);
    this.error.set(null);
    try {
      const request: NoteSaveRequest = {
        path: doc.path,
        vaultId: doc.vaultId ?? undefined,
        body: sentBody,
        eol: doc.eol,
        runOnSaveActions: options.runOnSaveActions,
      };
      const origin = options.origin ?? (this.assistantEdited.has(doc.key) ? 'assistant' : undefined);
      if (origin !== undefined) {
        request.origin = origin;
      }
      // The conflict guard (ADR-0060): say which state of the file this
      // tab edited. Auto-saved paths skip it -- a chat note follows the
      // disk by design.
      if (!isAutoSavePath(doc.path)) {
        request.baseModifiedMs = wasDraft ? 0 : doc.modifiedMs;
      }
      let result = await this.api.saveNote(request);
      if (result.conflict !== undefined) {
        const disk = result.conflict;
        // Same text as the tab last read: only the timestamp moved (a sync
        // client touching the file) -- nothing to ask about.
        if (disk.content !== doc.savedContent) {
          const merged = await this.conflicts.ask({
            path: doc.path,
            base: doc.savedContent,
            disk: disk.content,
            mine: sentBody,
            saving: true,
          });
          if (merged === null) {
            return;
          }
          if (merged === disk.content) {
            await this.adoptDisk(doc.key);
            return;
          }
          if (merged !== sentBody) {
            // A merge replaces the buffer as it was; main records the disk
            // version when the forced write overwrites it.
            this.captureHistory(doc, sentBody, 'conflict');
            this.patchDoc(doc.key, { bufferContent: merged });
            sentBody = merged;
            request.body = merged;
          }
          request.origin = 'conflict';
        }
        result = await this.api.saveNote({ ...request, force: true });
      }
      this.assistantEdited.delete(doc.key);
      // Adopt the pipeline's rewrite (frontmatter bump) only when the
      // buffer still holds what was sent; otherwise keep the live buffer.
      const fresh = this.docFor(doc.key);
      const currentBuffer = fresh?.bufferContent ?? result.content;
      this.patchDoc(doc.key, {
        savedContent: result.content,
        bufferContent: currentBuffer === sentBody ? result.content : currentBuffer,
        modifiedMs: result.modifiedMs,
        existsOnDisk: true,
        diskChanged: false,
      });
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
   * the dirty ones, by explicit key -- doesn't touch pane focus/activation
   * at all (unlike the single-pane version this replaced), since `save()`
   * now takes the key directly. Each goes through `save()`, so a scratch
   * tab still routes to `saveAs()` and an untouched draft is skipped.
   *
   * The exit prompt (bug-5) passes `drafts: true`: an `askOnSave` scratch
   * tab is committed into the vault's hidden `.drafts/` folder instead of
   * opening a Save-As dialog nobody can meaningfully answer per-tab while
   * the app is going down, and `runOnSaveActions: false` keeps on-save
   * Actions (LLM round trips) out of shutdown.
   */
  async saveAll(options: { runOnSaveActions?: boolean; drafts?: boolean } = {}): Promise<void> {
    for (const doc of this.docs()) {
      if (doc.kind !== 'text' || (doc.bufferContent === doc.savedContent && !doc.askOnSave)) {
        continue;
      }
      if (options.drafts && doc.askOnSave) {
        await this.saveDraft(doc.key);
        continue;
      }
      await this.save({ key: doc.key, runOnSaveActions: options.runOnSaveActions });
    }
  }

  /**
   * Commits an untitled ("scratch") buffer into the ACTIVE vault's hidden
   * `.drafts/` folder as the next `unnamed-N.md`, with no dialog (bug-5).
   * The tab is re-keyed to the real file (`retargetTabs` moves the pane
   * placement with it -- from the vault-less scratch namespace into the
   * vault's) and marked clean/on-disk, so the session snapshot then
   * restores the real file on the next start. An empty buffer saves
   * nothing -- there is nothing worth keeping. Errors land in `error` and
   * the tab stays a scratch one.
   */
  private async saveDraft(key: string): Promise<void> {
    const doc = this.docFor(key);
    if (!this.api?.saveDraftNote || !doc || doc.kind !== 'text' || doc.bufferContent.trim() === '') {
      return;
    }
    this.isSaving.set(true);
    this.error.set(null);
    try {
      const result = await this.api.saveDraftNote({ body: doc.bufferContent, eol: doc.eol });
      // The draft materializes in the ACTIVE vault; re-key the tab there.
      const activeVaultId = this.vault.activeVaultId();
      const nextKey = docKey(activeVaultId, result.path);
      this.retargetTabs(doc.key, nextKey);
      this.patchDoc(nextKey, {
        savedContent: result.content,
        bufferContent: result.content,
        modifiedMs: result.modifiedMs,
        existsOnDisk: true,
        askOnSave: false,
      });
      // No vault.refresh(): `.drafts/` is a dot-folder, the file tree (and
      // the plugins' indexes) never list it.
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isSaving.set(false);
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
    while (this.docs().some((d) => d.key === name)) {
      name = `untitled-${n++}.md`;
    }
    this.openScratch(name, '');
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
      this.error.set(err instanceof Error ? err.message : String(err));
      return null;
    }
    if (target === null) {
      return null; // cancelled
    }
    if (target === doc.path && doc.vaultId === targetVault && !doc.askOnSave) {
      await this.save({ key: doc.key });
      return doc.key;
    }

    this.isSaving.set(true);
    try {
      await this.api.saveNote({
        path: target,
        vaultId: targetVault ?? undefined,
        body: doc.bufferContent,
        eol: doc.eol,
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.isSaving.set(false);
      return null;
    }
    this.isSaving.set(false);

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
   * Writes an external document back to the path it was opened from. The
   * buffer is held in `\n`; the file's own line ending is restored on the
   * way out. What is committed is the buffer as of the call -- typing during
   * the write keeps the tab dirty.
   */
  private async saveExternal(doc: OpenDoc): Promise<void> {
    if (!this.api || doc.bufferContent === doc.savedContent) {
      return;
    }
    const sentBody = doc.bufferContent;
    this.isSaving.set(true);
    this.error.set(null);
    try {
      const onDisk = doc.eol === '\r\n' ? sentBody.replace(/\n/g, '\r\n') : sentBody;
      const modifiedMs = await this.api.writeExternalFile(doc.path, onDisk);
      this.patchDoc(doc.key, { savedContent: sentBody, modifiedMs });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isSaving.set(false);
    }
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
      this.error.set(err instanceof Error ? err.message : String(err));
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
    this.patchDoc(doc.key, { bufferContent: content });
    await this.save({ runOnSaveActions: false, key: doc.key, origin: 'assistant' });
  }

  private makeDoc(
    relativePath: string,
    vaultId: string | null,
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
      vaultId,
      path: relativePath,
      key: docKey(vaultId, relativePath),
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
   * `ImageTab` component resolves the image (vault-relative path + vault
   * id) itself.
   */
  private makeImageDoc(relativePath: string, vaultId: string | null): OpenDoc {
    return {
      vaultId,
      path: relativePath,
      key: docKey(vaultId, relativePath),
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
   * A PDF viewer tab (ADR-0052): no `readVaultFile`, no buffer, never
   * dirty. The renderer loads the file through `drey-asset://` -- the
   * `PdfTab` component resolves the URL (vault-relative path + vault id)
   * itself and the built-in (PDFium) viewer renders it.
   */
  private makePdfDoc(relativePath: string, vaultId: string | null): OpenDoc {
    return {
      vaultId,
      path: relativePath,
      key: docKey(vaultId, relativePath),
      name: baseName(relativePath),
      kind: 'pdf',
      savedContent: '',
      bufferContent: '',
      viewMode: 'live',
      eol: '\n',
      modifiedMs: 0,
      existsOnDisk: true,
    };
  }

  /**
   * Registers a tab of a registered (plugin or core) doc kind
   * (`DocKindRegistry`). The kind's owner mints the key (`browser://<n>`
   * for browser tabs) and owns everything behind it -- the view, the
   * chrome state, the favicon/status slots; `EditorService` only tracks
   * the tab's existence and its display name. No buffer, never dirty,
   * never saved.
   */
  addPluginDoc(kind: string, key: string, name: string): void {
    if (this.docs().some((d) => d.key === key)) {
      this.panes.open(key);
      return;
    }
    this.addDoc({
      vaultId: null,
      path: key,
      key,
      name,
      kind,
      savedContent: '',
      bufferContent: '',
      viewMode: 'live',
      eol: '\n',
      modifiedMs: 0,
      existsOnDisk: true,
    });
  }

  /** Updates a plugin-doc tab's display name (e.g. the browser's page title). */
  renameDoc(key: string, name: string): void {
    const doc = this.docFor(key);
    if (doc === null || doc.kind === 'text') {
      return;
    }
    this.patchDoc(key, { name });
  }

  private addDoc(doc: OpenDoc): void {
    this.docs.update((list) => [...list, doc]);
    this.panes.open(doc.key);
  }

  private patchDoc(key: string, patch: Partial<OpenDoc>): void {
    this.docs.update((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }
}

/** A retargeted doc's new vault id: the segment before `::` (null when bare). */
function toVaultIdOf(nextKey: string): string | null {
  const sep = nextKey.indexOf('::');
  return sep === -1 ? null : nextKey.slice(0, sep);
}

/** A retargeted doc's new vault-relative path: everything after `::`, or the bare key itself. */
function toPathOf(nextKey: string): string {
  const sep = nextKey.indexOf('::');
  return sep === -1 ? nextKey : nextKey.slice(sep + 2);
}
