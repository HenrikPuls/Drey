/**
 * Typed IPC contract between the Electron main process and the Angular
 * renderer, exposed via `contextBridge` (see electron/preload.ts).
 *
 * This file is imported by BOTH sides of the boundary -- main (which
 * implements it) and renderer (which consumes it) -- so a mismatch
 * between what main sends and what renderer expects is a compile error,
 * not a runtime surprise. See docs/09_architecture_decisions/0001-*.md.
 */
import type { AppConfig, CustomDictionary, LlmEndpoint } from './app-config';
import type { ActionContext, ActionOutcome, AskOutcome, LlmDebugEntry } from './llm';
import type { ChatThread } from './chat-thread';
import type { TagSearchHit, TagSearchQuery } from './tags';

export type { AppConfig, LlmEndpoint, CustomDictionary } from './app-config';
export type { ChatCard, ChatCardRole, ChatThread } from './chat-thread';
export type {
  ActionContext,
  ActionOutcome,
  AskOutcome,
  LlmDebugEntry,
  ResolvedAction,
} from './llm';
export type { TagSearchHit, TagSearchQuery } from './tags';

/**
 * Channel names. Most are `ipcMain.handle` / `ipcRenderer.invoke` request
 * pairs; `dailyOpen` is the first main -> renderer push
 * (`webContents.send` / `ipcRenderer.on`) -- fired by the quick-capture
 * hotkey to tell the renderer which file to open.
 */
export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  vaultGetActive: 'vault:get-active',
  vaultSelect: 'vault:select',
  vaultListFiles: 'vault:list-files',
  vaultReadFile: 'vault:read-file',
  vaultWriteFile: 'vault:write-file',
  vaultCreateFile: 'vault:create-file',
  vaultCreateDirectory: 'vault:create-directory',
  vaultDelete: 'vault:delete',
  dailyOpen: 'daily:open',
  dailyBuildContent: 'daily:build-content',
  noteSave: 'note:save',
  tagList: 'tags:list',
  tagSearch: 'tags:search',
  tagSummariseResults: 'tags:summarise-results',
  tagSuggest: 'tags:suggest',
  configGet: 'config:get',
  configSet: 'config:set',
  llmListModels: 'llm:list-models',
  llmTestConnection: 'llm:test-connection',
  llmDebugList: 'llm:debug-list',
  llmDebugClear: 'llm:debug-clear',
  llmDebugEntry: 'llm:debug-entry',
  actionRun: 'action:run',
  chatAsk: 'chat:ask',
  llmCancel: 'llm:cancel',
  threadRead: 'thread:read',
  threadWrite: 'thread:write',
  threadSummarize: 'thread:summarize',
  spellCheck: 'spell:check',
  spellLanguages: 'spell:languages',
  spellAddDictionary: 'spell:add-dictionary',
} as const;

/**
 * Mirrors Node's `NodeJS.Platform` values. Spelled out explicitly instead
 * of importing the `NodeJS` global namespace: the renderer's tsconfig
 * deliberately excludes `@types/node` (see tsconfig.app.json, "types": [])
 * so browser code can't assume Node globals exist, and this file is
 * compiled in both contexts.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'
  | 'haiku';

/**
 * Basic runtime info from the main process. This is the milestone-1
 * smoke test for the IPC bridge -- later milestones add real channels
 * (vault listing, file read/write, classifier calls, ...) following the
 * same pattern.
 */
export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: Platform;
}

/**
 * One entry in a vault's file tree, as returned by `listVaultFiles()`.
 * `relativePath` is relative to the vault root and always forward-slash
 * separated (even on Windows), so the renderer never has to know the
 * host's path separator convention.
 */
export interface VaultFileEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  /** Present (possibly empty) for directories only. */
  children?: VaultFileEntry[];
}

/**
 * A single file's contents plus the modification time it had when read.
 * `modifiedMs` is epoch milliseconds (`fs.Stats.mtimeMs`) -- milestone 3
 * only round-trips it (read -> hold -> hand back on write) so the value is
 * there when the file watcher lands and needs a cheap "changed on disk
 * since we opened it?" check (see specs/roadmap.md, "Phase 1" file
 * watcher; docs/11_risks_and_technical_debt.md, autosave-vs-watcher).
 */
export interface VaultFileContent {
  content: string;
  modifiedMs: number;
}

/** `type:` of a note file (see `specs/frontmatter-schema.md`). */
export type NoteType = 'master' | 'notiz' | 'interview-template';

/** `art:` of a `type: master` document (see `specs/frontmatter-schema.md`). */
export type MasterArt = 'thema' | 'person' | 'team' | 'projekt' | 'begriff';

/**
 * A note's parsed YAML frontmatter, normalised. Every field is present:
 * arrays default to `[]`, everything else to `null` when the key is
 * missing or the wrong shape, so consumers never have to null-check the
 * container -- only the values. `tags[0]` is the primary tag.
 */
export interface Frontmatter {
  type: NoteType | null;
  title: string | null;
  tags: string[];
  aliases: string[];
  created: string | null;
  updated: string | null;
  art: MasterArt | null;
  description: string | null;
  verweis: string | null;
}

/**
 * One tag in the vault-wide vocabulary, for `#tag` autocomplete and the
 * search panel's tag picker. `count` is how many heading-sections carry
 * the tag (`electron/tags/TagIndex`).
 */
export interface TagEntry {
  tag: string;
  count: number;
}

/** Renderer -> main: save the active editor buffer as a note. */
export interface NoteSaveRequest {
  /** Vault-relative path of the file being saved. */
  path: string;
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
}

/** Result of `llm:test-connection` / the model-list probe (`GET /models`). */
export interface LlmConnectionTest {
  ok: boolean;
  /** Human-readable success or failure detail for the Settings screen. */
  message: string;
  /** Model ids from the endpoint; `[]` on failure. */
  models: string[];
}

/**
 * One dictionary the spellchecker can be switched to -- the bundled
 * languages plus whatever the user added (`CustomDictionary`). `loaded`
 * says whether the dictionary files were actually readable, so the
 * settings pane can show a broken custom entry as broken instead of
 * silently checking nothing.
 */
export interface SpellLanguage {
  id: string;
  label: string;
  builtin: boolean;
  loaded: boolean;
  /** Why it failed to load, when `loaded` is false. */
  error?: string;
}

/** Result of one `spell:check` round: only the words the dictionary rejects. */
export interface SpellCheckResult {
  /** The dictionary that produced this verdict (`''` when spellcheck is off). */
  language: string;
  issues: Array<{ word: string; suggestions: string[] }>;
}

/** The API surface exposed on `window.dreyApi` by the preload script. */
export interface DreyApi {
  getAppInfo(): Promise<AppInfo>;

  /** The full app config (`shared/app-config.ts`), always normalised/complete. */
  getConfig(): Promise<AppConfig>;

  /**
   * Replaces the whole app config and returns what was persisted (the
   * Settings screen holds the entire object and re-sends it on every
   * change). Rejects only on a filesystem write error.
   */
  setConfig(config: AppConfig): Promise<AppConfig>;

  /**
   * Live `GET /models`. Uses the saved LLM endpoint unless `override` is
   * given — the Settings screen passes the URL/key currently typed in, so
   * loading models doesn't force a save first. Rejects on transport/HTTP error.
   */
  listLlmModels(override?: LlmEndpoint): Promise<string[]>;

  /** Probe the LLM endpoint (saved, or `override`); never rejects (failure is `{ ok: false }`). */
  testLlmConnection(override?: LlmEndpoint): Promise<LlmConnectionTest>;

  /**
   * Every LLM HTTP exchange this session, oldest first — what the LLM
   * settings pane's debug log shows. Bearer tokens are already masked.
   * In-memory only (it carries note content), capped at 50 entries.
   */
  getLlmDebugLog(): Promise<LlmDebugEntry[]>;

  /** Empties the debug log. */
  clearLlmDebugLog(): Promise<void>;

  /**
   * Subscribes to new debug entries as requests happen (main -> renderer
   * push, same shape as `onOpenDailyNote`). Returns an unsubscribe.
   */
  onLlmDebugEntry(listener: (entry: LlmDebugEntry) => void): () => void;

  /**
   * Runs one Action (by trigger id) against `context` (the active
   * document). An `'edit'` outcome is handed to the confirmation flow; the
   * renderer applies the `after` text on confirm.
   *
   * `taskId` (see `cancelLlmTask`) makes the run abortable. Cancelling
   * comes back as a `'noop'` outcome, not an error -- it is the user's
   * decision, not a failure.
   */
  runAction(triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome>;

  /**
   * Chat Ask mode: sends `question` plus the document (and any selection)
   * to the LLM. Returns an answer to display, or an edit to confirm.
   * Abortable via `taskId`; a cancelled call rejects.
   */
  askChat(context: ActionContext, question: string, taskId?: string): Promise<AskOutcome>;

  /**
   * Aborts a running generation. `taskId` is minted by the **renderer**
   * (`crypto.randomUUID`) and passed into the call being started, because
   * the UI has to be able to offer Cancel before that call returns.
   * Resolves `true` when something was actually aborted.
   *
   * This is why `/chat/completions` carries no timeout: a local model can
   * legitimately think for minutes, so the user decides when waiting is
   * over, not a constant (`electron/llm-tasks.ts`).
   */
  cancelLlmTask(taskId: string): Promise<boolean>;

  /**
   * The note assistant's sidecar thread for `notePath`
   * (`shared/chat-thread.ts`). Resolves to an empty thread when no sidecar
   * file exists yet -- "no thread" is a normal state, not an error.
   */
  readChatThread(notePath: string): Promise<ChatThread>;

  /** Writes the sidecar thread back. Rejects only on a filesystem error. */
  writeChatThread(thread: ChatThread): Promise<void>;

  /**
   * Summarises a note for the assistant panel's first card, using the
   * `note-summary` built-in template's prompt. Rejects when LLM features
   * are off or the endpoint is unreachable -- the panel shows the message.
   */
  summarizeNote(context: ActionContext, taskId?: string): Promise<string>;

  /**
   * Checks `words` against the active dictionary and returns only the ones
   * it rejects, each with up to a handful of suggestions. Never rejects:
   * spellcheck being off or a dictionary failing to load yields an empty
   * issue list, because a broken checker must not break typing.
   */
  checkSpelling(words: string[]): Promise<SpellCheckResult>;

  /** Every dictionary that can be selected, bundled and custom. */
  listSpellLanguages(): Promise<SpellLanguage[]>;

  /**
   * Opens a file picker for a Hunspell `.dic` (its `.aff` sibling is taken
   * from the same folder) and returns the config entry to store, or `null`
   * when the user cancelled or the pair is incomplete.
   */
  addSpellDictionary(): Promise<CustomDictionary | null>;

  /** Currently active vault path, or null if none has been selected yet. */
  getActiveVault(): Promise<string | null>;

  /**
   * Opens a native folder picker. Returns the resulting active vault path
   * (the newly picked one, or the previous one unchanged if the user
   * cancels the dialog) -- never rejects on cancel.
   */
  selectVault(): Promise<string | null>;

  /**
   * Recursively lists the active vault's contents. Rejects if no vault is
   * active, or if the vault folder can't be read (e.g. moved/deleted
   * since it was selected -- plausible given a vault can live on
   * OneDrive, see specs/roadmap.md).
   */
  listVaultFiles(): Promise<VaultFileEntry[]>;

  /**
   * Reads one file inside the active vault. `relativePath` is a
   * forward-slash path relative to the vault root (as delivered by
   * `listVaultFiles`). Rejects if no vault is active, if the path resolves
   * outside the vault, or if the file can't be read.
   */
  readVaultFile(relativePath: string): Promise<VaultFileContent>;

  /**
   * Overwrites one file inside the active vault with `content` (UTF-8).
   * Same `relativePath` rules and rejection conditions as `readVaultFile`.
   * Resolves to the file's new `modifiedMs` after the write.
   */
  writeVaultFile(relativePath: string, content: string): Promise<number>;

  /**
   * Creates an empty file inside the active vault (any missing parent
   * folders are created too). `relativePath` follows the same forward-slash
   * / no-escape rules as `readVaultFile`. Rejects if a file or folder
   * already exists at that path, or if no vault is active. Resolves to the
   * created file's vault-relative path (echoed back so the renderer can
   * open it in the editor).
   */
  createVaultFile(relativePath: string): Promise<string>;

  /**
   * Creates a directory inside the active vault (missing parents included).
   * Same path rules as `createVaultFile`; rejects if anything already
   * exists at that path. Resolves to the created directory's
   * vault-relative path.
   */
  createVaultDirectory(relativePath: string): Promise<string>;

  /**
   * Deletes a file or folder (recursively) inside the active vault. Same
   * path rules as `readVaultFile`; refuses the vault root. Deleting a
   * `.md` note also removes its assistant sidecar (`.{name}.chat.json`) if
   * present. A missing target is not an error. Rejects only on a bad path
   * or a real filesystem failure.
   */
  deleteVaultEntry(relativePath: string): Promise<void>;

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
   * Saves a note through the tag pipeline (milestone 6): parses the
   * frontmatter, merges inline `#tag`s from the body into `tags` (topic
   * notes only -- `daily/` and `templates/` are left alone), bumps
   * `updated:`, routes tagged entries into their topic's master document,
   * writes the file, and hands back the rewritten content plus what
   * happened. Replaces `writeVaultFile` for `.md` documents. Same
   * path rules / rejection conditions as `readVaultFile`.
   */
  saveNote(request: NoteSaveRequest): Promise<NoteSaveResult>;

  /**
   * The vault-wide tag vocabulary (`tag` + section count) for `#tag`
   * autocomplete and the search panel's tag picker. Rebuilt when a vault
   * is selected, re-indexed per file on each `saveNote` and on delete;
   * external edits are picked up on the next vault load / manual refresh
   * (no file watcher). Resolves to `[]` when no vault is active.
   */
  listTags(): Promise<TagEntry[]>;

  /**
   * Runs the tag search: sections where every `query.tags` entry is present
   * and every whitespace-split term of `query.text` appears (body or
   * heading). Each hit carries a path, heading, 1-based line and a compact
   * snippet. Fast -- no LLM. `[]` when the query is empty or no vault.
   */
  searchTags(query: TagSearchQuery): Promise<TagSearchHit[]>;

  /**
   * Runs the same search, then asks the local model for a short prose
   * digest of the matching sections. `taskId` makes it cancellable
   * (`cancelLlmTask`); no timeout (ADR-0014). Rejects when LLM features are
   * off, the query is empty, or the model errors.
   */
  summariseSearchResults(query: TagSearchQuery, taskId?: string): Promise<string>;

  /**
   * The drawer's "Autotag" button: `entryText` plus the vault tag
   * vocabulary in, up to four suggested tags out. Only pre-fills the tag
   * field -- the user still confirms by saving. `taskId` makes it
   * cancellable. Rejects when LLM features are off.
   */
  suggestTags(entryText: string, taskId?: string): Promise<string[]>;
}

declare global {
  interface Window {
    dreyApi: DreyApi;
  }
}
