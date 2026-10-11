/**
 * IPC contract, note part: saving a note and its conflict (ADR-0060),
 * drafts, daily notes, the PDF export, files the OS hands over
 * (ADR-0054), the local note history and the session backups (ADR-0043)
 * (`shared/ipc-api.ts` is the barrel).
 */
import type { ActionOutcome } from '../llm';

/**
 * One file the OS asked Drey to open (ADR-0054), already classified in main.
 * `vault`: it sits inside a registered vault -- open it as an ordinary vault
 * tab (`path` is vault-relative, forward-slash). `external`: it sits in no
 * vault -- open it as a pinned external tab (`path` is the absolute OS
 * path, the only handle `readExternalFile` / `writeExternalFile` accept).
 */
export type OpenRequest =
  | { readonly kind: 'vault'; readonly vaultId: string; readonly path: string }
  | { readonly kind: 'external'; readonly path: string };

/** Result of `readExternalFile`. */
export interface ExternalFileContent {
  readonly content: string;
  readonly modifiedMs: number;
}

/**
 * An untitled ("scratch") buffer to commit into the vault's hidden
 * `.drafts/` folder as `unnamed-N.md` (bug-5, the Notepad++ model): saving
 * on exit never opens a Save-As dialog; only an explicit manual save asks
 * for a location. Main picks the next free index and runs the note through
 * the normal `note:save` pipeline (frontmatter, save hooks -- minus
 * Actions), returning the vault-relative path the tab is re-keyed to.
 */
export interface DraftSaveRequest {
  body: string;
  eol?: '\n' | '\r\n';
}

/**
 * One "Export as PDF…" request (editor `⋯` menu, tab context menu, Files
 * panel row). `path` is the note's vault-relative path; it names the
 * exported file, anchors note-relative image resolution and seeds the save
 * dialog's default location. `content` is the live editor buffer -- sent
 * whenever the doc is open, so dirty and scratch (untitled, `vaultId`
 * absent) tabs export what the user sees; without it main reads the file
 * from disk (Files-panel export of a possibly never-opened note).
 */
export interface PdfExportRequest {
  path: string;
  /** Defaults to the active vault (ADR-0051). Scratch tabs send none. */
  vaultId?: string;
  /** Live buffer override; absent = read from disk. */
  content?: string;
}

/** `type:` of a note file (see `specs/frontmatter-schema.md`). */
export type NoteType = 'master' | 'notiz' | 'interview-template';

/** `art:` of a `type: master` document (see `specs/frontmatter-schema.md`). */
export type MasterArt = 'thema' | 'person' | 'team' | 'projekt' | 'begriff';

/**
 * A note's parsed YAML frontmatter, normalised. Every field is present:
 * arrays default to `[]`, everything else to `null` when the key is
 * missing or the wrong shape, so consumers never have to null-check the
 * container -- only the values. `tags[0]` is the primary tag. `kind` is
 * the one app-understood document-class marker so far (`chat` marks an
 * assistant conversation note, ADR-0048); everything else describes or
 * classifies prose the user owns.
 */
export interface Frontmatter {
  type: NoteType | null;
  kind: string | null;
  title: string | null;
  tags: string[];
  aliases: string[];
  created: string | null;
  updated: string | null;
  art: MasterArt | null;
  description: string | null;
  verweis: string | null;
}

/** Renderer -> main: save the active editor buffer as a note. */
export interface NoteSaveRequest {
  /** Vault-relative path of the file being saved. */
  path: string;
  /**
   * Which vault the file lives in (ADR-0051). Default (absent) is the
   * active vault -- every existing caller means that.
   */
  vaultId?: string;
  /** Full buffer, always `\n`-separated (the editor normalises to LF). */
  body: string;
  /** Line ending to restore on disk. */
  eol: '\n' | '\r\n';
  /**
   * Whether the `on-save` Action triggers run for this save. Default
   * (`undefined`) is yes; the confirmation flow passes `false` when the
   * save is itself applying an Action's result, so it can't recurse.
   */
  runOnSaveActions?: boolean;
  /**
   * The file's `modifiedMs` as the tab last saw it (milestone 60,
   * ADR-0060). When the file on disk carries a different one, nothing is
   * written and the result reports a {@link NoteSaveConflict}. `0` means
   * "the tab believes there is no file yet" (a draft). Absent: no check --
   * auto-saved paths (chat notes, drafts) and "Save as…".
   */
  baseModifiedMs?: number;
  /** Write regardless of `baseModifiedMs` -- the conflict was resolved. */
  force?: boolean;
  /**
   * Who is behind this save, for the local history: a plain user save
   * (`'save'`, the default) records at most one earlier version per few
   * minutes; any other origin always records one.
   */
  origin?: string;
}

/** The file changed on disk since the saving tab last read it. */
export interface NoteSaveConflict {
  /** What is on disk now, in `\n` form. */
  content: string;
  modifiedMs: number;
}

/** One earlier version of a note in the local history (ADR-0060). */
export interface NoteHistoryEntry {
  id: string;
  /** Epoch ms the version was recorded. */
  at: number;
  /**
   * What was about to replace this version: `save`, `mcp`, `links`,
   * `conflict`, `external`, `restore`, `app` or a plugin id.
   */
  origin: string;
  bytes: number;
}

/**
 * Result of `saveNote`. `content` is the possibly-rewritten note text
 * (`updated:` bumped, `created:` filled) in `\n` form -- the renderer
 * adopts it as the tab's new saved content.
 */
export interface NoteSaveResult {
  path: string;
  content: string;
  modifiedMs: number;
  /**
   * `'edit'` outcomes from `on-save` Actions whose trigger still needs
   * confirmation -- the renderer walks these through the confirmation
   * dialog. Non-confirm triggers are applied in the main process before
   * this result returns and are already reflected in `content`. Empty /
   * absent when LLM features are off or there are no `on-save` triggers.
   */
  pendingActions?: ActionOutcome[];
  /**
   * Set when the save was REFUSED because the file changed on disk --
   * nothing was written, `content` echoes the request body.
   */
  conflict?: NoteSaveConflict;
}

/** Saving, drafts, daily notes, export, external files, history, session backups. */
export interface NotesIpc {
  /**
   * Commits an untitled buffer into the vault's hidden `.drafts/` folder as
   * the next free `unnamed-N.md` (bug-5). Runs the normal note-save
   * pipeline (frontmatter bump, save hooks; on-save Actions suppressed).
   * Resolves with the full save result -- `path` is the vault-relative path
   * the tab is re-keyed to. Rejects when there is no active vault.
   */
  saveDraftNote(request: DraftSaveRequest): Promise<NoteSaveResult>;

  /**
   * Opens the native "Save note" dialog rooted at the given vault
   * (default: the active one). Resolves to the chosen location as a
   * forward-slash vault-relative path (`.md` enforced), or `null` if the
   * user cancelled. Rejects if the chosen location is outside that vault.
   */
  pickSavePath(suggestedName: string, vaultId?: string): Promise<string | null>;

  /**
   * Exports a note as PDF (paper-styled, A4, page-numbered footer): main
   * renders the note's Markdown body to HTML, prints it in a hidden window
   * and writes the result to a location chosen in the native save dialog.
   * Resolves to the saved ABSOLUTE path, or `null` if the user cancelled.
   * Unlike `pickSavePath` the target is deliberately NOT restricted to the
   * vault -- an export is meant to leave the vault.
   */
  exportNotePdf(request: PdfExportRequest): Promise<string | null>;

  /**
   * Builds the Markdown a fresh daily note for `date` (`YYYY-MM-DD`) would
   * start from -- the current `templates/daily.md` with its placeholders
   * substituted -- WITHOUT creating the file (and without scaffolding the
   * template either). The renderer opens the result as an unsaved draft
   * buffer when a calendar day with no note yet is clicked; `daily/<date>.md`
   * is written only once the user types something and saves, so clicking
   * around the calendar never litters the vault with empty notes.
   * `{{date}}` / `{{title}}` come from `date`; `{{time}}` / `{{datetime}}`
   * from the current wall-clock time. Rejects if no vault is active or
   * `date` is not a `YYYY-MM-DD` string.
   */
  buildDailyNoteContent(date: string): Promise<string>;

  /**
   * Subscribes to the quick-capture hotkey signal from the main process.
   * The payload is the vault-relative path of today's daily note --
   * already created from `templates/daily.md` (scaffolded on first use)
   * if it did not exist. The renderer opens it in the editor and starts a
   * fresh `## HH:mm` entry. Returns an unsubscribe function; the raw IPC
   * event is never forwarded (see docs/09_architecture_decisions/0001-*.md).
   */
  onOpenDailyNote(listener: (relativePath: string) => void): () => void;

  /**
   * Drains the files the launch itself carried (`drey.exe notes.md`, an
   * Explorer double-click on a cold start), classified as vault / external
   * (ADR-0054). A PULL, not a push: main would otherwise fire before the
   * renderer has finished starting. Calling it also tells main the renderer
   * is ready, so every later launch (`second-instance`) arrives through
   * `onOpenRequest` instead. Resolves to `[]` when nothing was passed.
   */
  takePendingOpenRequests(): Promise<OpenRequest[]>;

  /** Later OS launches while the app is running -- see `takePendingOpenRequests`. */
  onOpenRequest(listener: (requests: OpenRequest[]) => void): () => void;

  /**
   * Reads one external file. Main only serves paths it collected from the OS
   * itself (an allowlist) with a Markdown/text extension and a size cap, so
   * this can never be turned into an arbitrary file read. Rejects otherwise.
   */
  readExternalFile(absolutePath: string): Promise<ExternalFileContent>;

  /**
   * Saves an external file back to its original location (UTF-8, `content`
   * already carries the file's own line endings). Same allowlist as
   * `readExternalFile`: only a path main collected from the OS itself, with
   * a Markdown/text extension and under the size cap. Resolves to the new
   * `modifiedMs`; rejects otherwise.
   */
  writeExternalFile(absolutePath: string, content: string): Promise<number>;

  /**
   * Saves a note through the tag pipeline (milestone 6): parses the
   * frontmatter, merges inline `#tag`s from the body into `tags` (topic
   * notes only -- `daily/` and `templates/` are left alone), bumps
   * `updated:`, routes tagged entries into their topic's master document,
   * writes the file, and hands back the rewritten content plus what
   * happened. Replaces `writeVaultFile` for `.md` documents. Same
   * path rules / rejection conditions as `readVaultFile`.
   */
  saveNote(request: NoteSaveRequest): Promise<NoteSaveResult>;

  // --- Local note history (milestone 60, ADR-0060) -----------------------

  /** The recorded earlier versions of a note, newest first. */
  listNoteHistory(relativePath: string, vaultId?: string): Promise<NoteHistoryEntry[]>;

  /** One version's text (as recorded), or `null` when it has expired. */
  readNoteHistory(relativePath: string, entryId: string, vaultId?: string): Promise<string | null>;

  /**
   * Records `content` as a version -- for text that exists only in the
   * renderer (a buffer about to be discarded, a tab's last known disk
   * state). Resolves to whether a version was written.
   */
  captureNoteHistory(
    relativePath: string,
    content: string,
    origin: string,
    vaultId?: string,
  ): Promise<boolean>;

  // --- Session history (ADR-0043) ---------------------------------------
  //
  // The layout + open-tab list is persisted by the renderer in
  // `localStorage['drey.session']`. These channels only back the text of
  // buffers with nothing on disk to reload from (a never-saved scratch
  // tab, or unsaved edits to a real file) -- one file per `id` under
  // `<userData>/session-backups/`.

  /** Writes (or overwrites) the backup for `id`. `id` must be a UUID. */
  writeSessionBackup(id: string, content: string): Promise<void>;

  /** Reads a backup, or `null` if it is gone. */
  readSessionBackup(id: string): Promise<string | null>;

  /** Every backup id currently on disk -- for pruning orphans on restore. */
  listSessionBackups(): Promise<string[]>;

  /** Deletes the named backups (ignored if already gone). */
  deleteSessionBackups(ids: string[]): Promise<void>;
}
