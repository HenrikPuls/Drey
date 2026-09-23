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
import type { ActionOutcome, LlmCapabilities, LlmDebugEntry } from './llm';
import type { PluginDescriptorForRenderer, PluginIpcEventPayload } from './plugin-api/plugin-ipc';

export type {
  PluginDescriptorForRenderer,
  PluginIpcEventPayload,
  PluginIpcInvokePayload,
} from './plugin-api/plugin-ipc';

export type { AppConfig, LlmEndpoint, CustomDictionary } from './app-config';
export type { ActionOutcome, LlmCapabilities, LlmDebugEntry } from './llm';

/**
 * Channel names. Most are `ipcMain.handle` / `ipcRenderer.invoke` request
 * pairs; `dailyOpen` is the first main -> renderer push
 * (`webContents.send` / `ipcRenderer.on`) -- fired by the quick-capture
 * hotkey to tell the renderer which file to open.
 */
export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowRecoverInput: 'window:recover-input',
  exitConfirmRequest: 'exit:confirm-request',
  exitDecision: 'exit:decision',
  exitListenerReady: 'exit:listener-ready',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizeChanged: 'window:maximize-changed',
  editExec: 'edit:exec',
  uiSetZoom: 'ui:set-zoom',
  openExternal: 'app:open-external',
  appLog: 'app:log',
  vaultGetActive: 'vault:get-active',
  // Multi-vault registry (ADR-0051): the vaults the app knows about, one
  // native-picker add, registry-only remove, display-name rename, explicit
  // active switch, and a shell reveal of the folder. `vault:select` (the
  // old picker-overwrite switch) is gone -- switching is `set-active`.
  vaultList: 'vault:list',
  vaultAdd: 'vault:add',
  vaultRemove: 'vault:remove',
  vaultRenameVault: 'vault:rename-vault',
  vaultSetActive: 'vault:set-active',
  vaultRevealFolder: 'vault:reveal-folder',
  vaultRevealPath: 'vault:reveal-path',
  vaultOpenInTerminal: 'vault:open-in-terminal',
  vaultGetActiveId: 'vault:get-active-id',
  vaultListFiles: 'vault:list-files',
  vaultReadFile: 'vault:read-file',
  vaultWriteFile: 'vault:write-file',
  vaultSaveAsset: 'vault:save-asset',
  vaultSaveAssetFromUrl: 'vault:save-asset-from-url',
  vaultCreateFile: 'vault:create-file',
  vaultCreateDirectory: 'vault:create-directory',
  vaultRename: 'vault:rename-entry',
  vaultCopy: 'vault:copy-entry',
  vaultDuplicate: 'vault:duplicate-entry',
  vaultDelete: 'vault:delete',
  vaultDeleteMany: 'vault:delete-many',
  vaultRefresh: 'vault:refresh',
  draftSave: 'draft:save',
  vaultPickSavePath: 'vault:pick-save-path',
  dailyOpen: 'daily:open',
  // Files the OS hands to Drey (Explorer "Open with" / default program,
  // ADR-0054). `external:take-pending` is the renderer's cold-start PULL of
  // whatever the launch argv carried; `external:open-request` is the PUSH for
  // every later launch (`second-instance`); `external:read` reads one file
  // main itself collected from the OS -- never an arbitrary renderer path;
  // `external:write` saves back to exactly such a path, same allowlist.
  externalTakePending: 'external:take-pending',
  externalRead: 'external:read',
  externalWrite: 'external:write',
  externalOpenRequest: 'external:open-request',
  dailyBuildContent: 'daily:build-content',
  noteSave: 'note:save',
  exportNotePdf: 'export:note-pdf',
  tagSuggest: 'tags:suggest',
  // Tag vocabulary + prefix styles over the section-search provider (the
  // tags plugin registers it; ADR-0017/ADR-0044). `search:vocabulary` is a
  // request the base renderer makes; it degrades to an empty payload when
  // no provider is registered. `search:changed` is the main -> renderer
  // push fired whenever the provider or its index changed.
  searchVocabulary: 'search:vocabulary',
  searchChanged: 'search:changed',
  configGet: 'config:get',
  configSet: 'config:set',
  llmListModels: 'llm:list-models',
  llmTestConnection: 'llm:test-connection',
  llmDebugList: 'llm:debug-list',
  llmDebugClear: 'llm:debug-clear',
  llmDebugEntry: 'llm:debug-entry',
  llmDelta: 'llm:delta',
  llmCancel: 'llm:cancel',
  llmCapabilitiesChanged: 'llm:capabilities-changed',
  spellCheck: 'spell:check',
  spellLanguages: 'spell:languages',
  spellAddDictionary: 'spell:add-dictionary',
  spellAddWord: 'spell:add-word',
  // MCP vault server (ADR-0021).
  mcpStatus: 'mcp:status',
  mcpWriteRequest: 'mcp:write-request',
  mcpWriteDecision: 'mcp:write-decision',
  // Vault change push (ADR-0045): main -> renderer after any external or
  // MCP write lands -- formerly the MCP-only 'mcp:vault-changed'. Carries
  // the changed paths when a scoped reload is possible.
  vaultChanged: 'vault:changed',
  // Session history (ADR-0043): a backup store under the user-data dir for
  // the text of tabs that have no file on disk (or unsaved edits), so they
  // survive a restart. The layout / tab list itself lives in the
  // renderer's localStorage, like the dock layout.
  sessionWriteBackup: 'session:write-backup',
  sessionReadBackup: 'session:read-backup',
  sessionListBackups: 'session:list-backups',
  sessionDeleteBackups: 'session:delete-backups',
  // Plugin host (ADR-0044). Two FIXED channels, not per-plugin names: the
  // invoke payload carries { pluginId, method, payload } and main routes it
  // to that plugin's registered method allowlist; events fan out
  // renderer-side. pluginList is the discovery report for Settings.
  pluginInvoke: 'plugin:invoke',
  pluginEvent: 'plugin:event', // push main -> renderer
  pluginList: 'plugin:list',
} as const;

/**
 * One registered vault (ADR-0051). `id` is minted once at registration and
 * never changes -- it survives folder renames/moves because it lives in
 * the registry (`<userData>/vault-config.json`), not on disk -- and is the
 * vault identity carried through IPC payloads, open-tab keys and asset
 * URLs. `name` is the user-editable display name (defaults to the folder
 * basename; duplicates allowed). `path` is the absolute OS path of the
 * vault root.
 */
export interface VaultRegistration {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/**
 * A `VaultRegistration` plus its live status, as `listVaults()` reports it
 * to the Files panel: `exists` is false for a registration whose folder
 * has disappeared (moved drive, OneDrive not mounted -- the registration
 * stays and the row greys out), `active` marks the one vault that new
 * content (daily notes, capture, chats) targets by default.
 */
export interface VaultStatus extends VaultRegistration {
  readonly exists: boolean;
  readonly active: boolean;
}

/**
 * A `vault_write` an MCP client asked for, pushed to the renderer so the
 * user can confirm it in the shared diff dialog before it hits disk
 * (skipped entirely in YOLO mode). The renderer replies via
 * `resolveMcpWrite(id, approved)`. `vaultId`/`vaultName` name the target
 * vault for the dialog's header (absent in old payloads / the default
 * active-vault case).
 */
export interface McpWriteRequest {
  id: number;
  path: string;
  before: string;
  after: string;
  mode: 'overwrite' | 'append';
  vaultId?: string;
  vaultName?: string;
}

/**
 * Payload of the `vault:changed` push (ADR-0045): external vault changes
 * landed (watcher batch, manual refresh, or an MCP write). `paths` lists
 * the changed/deleted `.md` files, vault-relative and forward-slash, so
 * consumers can scope their work -- `EditorService` auto-reloads the
 * matching clean tabs. Omitted when the batch is too big to be worth
 * listing (over 200 paths); consumers then treat the push as a full
 * refresh and must not touch open tabs.
 *
 * `vaultId` (ADR-0051) scopes the push to one vault: only that vault's
 * tree and tabs react. Absent means registry-level / all vaults -- a
 * registry mutation (add/remove/rename/set-active) or a refresh round that
 * covered everything -- and consumers reload all trees (and the registry).
 */
export interface VaultChangedPush {
  readonly vaultId?: string;
  readonly paths?: readonly string[];
}

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
 * Pushed to the renderer when the window is about to close with the exit
 * prompt undecided (bug-5). The renderer owns the dirty-document registry,
 * so the payload carries only the correlation id: no dirty docs -> it
 * replies `'discard'` (proceed) without showing anything; otherwise it
 * shows the exit dialog and replies with the chosen `ExitDecision`.
 */
export interface ExitConfirmRequest {
  id: number;
}

/** The renderer's answer to an `ExitConfirmRequest`. */
export type ExitDecision = 'save' | 'discard' | 'cancel';

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

/** What `getMcpStatus` reports for the Settings pane. */
export interface McpStatus {
  enabled: boolean;
  httpListening: boolean;
  httpPort: number | null;
  /** Absolute path to the stdio bridge script, for the client config snippet. */
  stdioBridgePath: string;
}

/**
 * Standard editing commands the HTML Edit menu routes through the focused
 * `webContents` element (`electron/main.ts`). CodeMirror and native
 * `<input>` / `<textarea>` fields both honour these, so one path covers
 * every editable surface -- and it survives the menu click stealing DOM
 * focus, which a renderer-side dispatch would not.
 */
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

/** One renderer-sourced log entry written to the main process's log file. */
export interface LogEntry {
  level: 'error' | 'warn' | 'info';
  message: string;
  /** Optional structured payload (a stack, a state snapshot); JSON-stringified. */
  context?: unknown;
}

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

/**
 * One tag in the vault-wide vocabulary, for `#tag` autocomplete and the
 * search panel's tag picker. `count` is how many heading-sections carry
 * the tag (`electron/tags/TagIndex`).
 */
export interface TagEntry {
  tag: string;
  count: number;
}

/**
 * The vocabulary + prefix-style payload the section-search provider serves
 * (see `search:vocabulary`). Empty when no provider is registered (e.g. the
 * tags plugin is disabled) — consumers degrade to no completion / auto
 * colors.
 */
export interface TagVocabularyPayload {
  entries: TagEntry[];
  prefixes: Array<{ prefix: string; color: string }>;
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
 * One streamed-LLM-text push (ADR-0047), tagged with the renderer-minted
 * `taskId` of the chat that produced it. A provider that cannot stream
 * sends its full text as exactly one event.
 */
export interface LlmDeltaEvent {
  taskId: string;
  text: string;
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

  /**
   * Custom-titlebar window controls. The renderer draws its own
   * minimize/maximize/close buttons because the window is frameless
   * (`titleBarStyle: 'hidden'`) -- see
   * docs/09_architecture_decisions/0019-*.md. No-ops if the window is gone.
   */
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;

  /**
   * Fires when the window is about to close and the renderer must decide
   * (bug-5): save all dirty documents, exit without saving, or cancel the
   * close. Reply via `resolveExitConfirm`. Returns an unsubscribe.
   */
  onExitConfirmRequest(listener: (request: ExitConfirmRequest) => void): () => void;

  /** The renderer's answer to an `ExitConfirmRequest`. */
  resolveExitConfirm(id: number, decision: ExitDecision): Promise<void>;

  /**
   * Commits an untitled buffer into the vault's hidden `.drafts/` folder as
   * the next free `unnamed-N.md` (bug-5). Runs the normal note-save
   * pipeline (frontmatter bump, save hooks; on-save Actions suppressed).
   * Resolves with the full save result -- `path` is the vault-relative path
   * the tab is re-keyed to. Rejects when there is no active vault.
   */
  saveDraftNote(request: DraftSaveRequest): Promise<NoteSaveResult>;

  /**
   * Asks main to close any native context-menu popup still popped over the
   * window and log the attempt (bug-6): a popup whose capture loop never
   * unwinds swallows every keystroke -- invisible to the renderer, so the
   * "Recover input focus" command forwards here as the escape hatch.
   * Resolves to `true` when a popup was actually closed.
   */
  recoverInputFocus(): Promise<boolean>;

  /**
   * Fires whenever the window is maximized or restored, so the titlebar's
   * maximize/restore glyph can follow along (main -> renderer push, same
   * shape as `onOpenDailyNote`). Returns an unsubscribe.
   */
  onWindowMaximizeChange(listener: (maximized: boolean) => void): () => void;

  /**
   * Runs a standard editing command against the focused editable element
   * (CodeMirror or a native field), via the window's `webContents`. Backs
   * the HTML Edit menu's Undo/Redo/Cut/Copy/Paste/Select all rows -- the
   * accelerators already work; this makes the menu clicks work too.
   */
  execEditCommand(command: EditCommand): Promise<void>;

  /**
   * Sets the whole renderer's zoom factor (`webContents.setZoomFactor`) --
   * the app-wide "Base font size" preset in Settings -> Appearance. `1` is
   * unscaled. Scales layout and pointer coordinates together, unlike a CSS
   * `zoom`, so drag gestures keep working. Resets on reload, so the renderer
   * re-applies it from config on startup.
   */
  setUiZoomFactor(factor: number): Promise<void>;

  /**
   * Opens an external URL in the OS default handler (`shell.openExternal`).
   * Only `http:`, `https:` and `mailto:` are honoured -- anything else is
   * ignored in the main process. Backs a `Ctrl`/`Cmd`-click on a link in
   * the editor.
   */
  openExternal(url: string): Promise<void>;

  /**
   * Appends a line to the main process's log file
   * (`<userData>/logs/drey.log`). Best-effort, fire-and-forget -- the
   * renderer mirrors `console.error` / `window.onerror` /
   * `unhandledrejection` and the input-recovery snapshot here so a field
   * problem in the packaged build (no DevTools) leaves a trace.
   */
  logMessage(entry: LogEntry): Promise<void>;

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
   * Streamed LLM text (ADR-0047): one push per delta, tagged with the
   * renderer-minted `taskId` of the chat that produced it. A provider
   * that cannot stream sends its full text as exactly one event.
   */
  onLlmDelta(listener: (event: LlmDeltaEvent) => void): () => void;

  /**
   * The ACTIVE provider's capabilities, re-pushed after every app-config
   * write (a provider switch changes them). Lets plugins keep a
   * synchronously-readable capability cache for UI gating.
   */
  onLlmCapabilitiesChanged(listener: (capabilities: LlmCapabilities) => void): () => void;

  /**
   * Aborts a running generation. `taskId` is minted by the **renderer**
   * (`crypto.randomUUID`) and passed into the call being started, because
   * the UI has to be able to offer Cancel before that call returns.
   * Resolves `true` when something was actually aborted.
   *
   * This is why `/chat/completions` carries no timeout: a local model can
   * legitimately think for minutes, so the user decides when waiting is
   * over, not a constant (`electron/llm-tasks.ts`). The registry is base
   * even after the assistant conversion (ADR-0044 stage 7): any surface
   * that passed a `taskId` can cancel it.
   */
  cancelLlmTask(taskId: string): Promise<boolean>;

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

  /**
   * Adds `word` to the spellchecker's accepted words -- to the active
   * dictionary's list (`target: 'language'`) or the global personal list
   * (`target: 'personal'`) -- persists it, and reloads the checker so the
   * squiggle clears immediately (no Settings round-trip). Returns the
   * stored config so an open Settings screen can reconcile.
   */
  addSpellWord(word: string, target: 'language' | 'personal'): Promise<AppConfig>;

  /** Currently active vault path, or null if none is active. */
  getActiveVault(): Promise<string | null>;

  // --- Vault registry (ADR-0051) ----------------------------------------

  /** Every registered vault with live status, in registration order. */
  listVaults(): Promise<VaultStatus[]>;

  /** The active vault's id, or null when none is active. */
  getActiveVaultId(): Promise<string | null>;

  /**
   * Opens a native folder picker and registers the chosen folder as a new
   * vault (display name defaults to the folder basename). Resolves to the
   * new registration, or null when the user cancelled. Rejects when the
   * folder is already registered.
   */
  addVault(): Promise<VaultRegistration | null>;

  /**
   * Removes a vault from the registry -- never touches the folder on disk.
   * Removing the active vault promotes the first remaining one (or none).
   */
  removeVault(vaultId: string): Promise<void>;

  /** Renames a vault's display name (the id and folder are untouched). */
  renameVault(vaultId: string, name: string): Promise<VaultRegistration>;

  /** Makes `vaultId` the active vault (the default target for new content). */
  setActiveVault(vaultId: string): Promise<void>;

  /** Shows the vault's folder in the OS file manager. */
  revealVaultFolder(vaultId: string): Promise<void>;

  /**
   * Reveals a vault-relative file/folder in the OS file manager (selected
   * in its parent folder). Throws when the path resolves outside the
   * vault -- the absolute path never crosses the bridge.
   */
  revealVaultPath(relativePath: string, vaultId: string): Promise<void>;

  /**
   * Opens the OS terminal with its working directory at the vault-relative
   * folder. Throws when no terminal can be launched (Linux best effort).
   */
  openVaultFolderInTerminal(dirRelativePath: string, vaultId: string): Promise<void>;

  /**
   * Recursively lists a vault's contents. `vaultId` defaults to the active
   * vault. Rejects if that vault's folder can't be read (e.g. moved/deleted
   * since it was registered -- plausible given a vault can live on
   * OneDrive, see specs/roadmap.md).
   */
  listVaultFiles(vaultId?: string): Promise<VaultFileEntry[]>;

  /**
   * Runs one full vault refresh round in main (ADR-0045): the plugins'
   * indexes rebuild and a `vault:changed` push follows, so the tree,
   * plugin panels and clean open tabs all reload from it. This is what
   * the Files panel's refresh button invokes -- it fixes the old gap
   * where a manual refresh re-pulled the tree but left the tag/task
   * indexes stale. Harmless with no vault active.
   */
  refreshVault(): Promise<void>;

  /**
   * Reads one file inside a vault. `relativePath` is a forward-slash path
   * relative to the vault root (as delivered by `listVaultFiles`);
   * `vaultId` defaults to the active vault. Rejects if the path resolves
   * outside the vault, or if the file can't be read.
   */
  readVaultFile(relativePath: string, vaultId?: string): Promise<VaultFileContent>;

  /**
   * Overwrites one file inside a vault with `content` (UTF-8). Same
   * `relativePath` rules and rejection conditions as `readVaultFile`;
   * `vaultId` defaults to the active vault. Resolves to the file's new
   * `modifiedMs` after the write.
   */
  writeVaultFile(relativePath: string, content: string, vaultId?: string): Promise<number>;

  /**
   * Saves a binary asset -- a pasted or dropped image -- into an
   * `attachments/` folder beside the note that references it (ADR-0024).
   * `noteRelPath` is the open document's vault-relative path (a bare name /
   * empty string falls back to the vault root's `attachments/`); `ext` is
   * the file extension without a dot (`imageExtension()` from
   * `shared/asset-name.ts`); `vaultId` defaults to the active vault.
   * Resolves to the path to drop into the `![](...)` -- relative to the
   * note's own folder, so `resolveVaultImageUrl` turns it straight back
   * into a `drey-asset://` URL. Rejects if the resolved folder escapes the
   * vault.
   */
  saveVaultAsset(
    bytes: Uint8Array,
    ext: string,
    noteRelPath: string,
    vaultId?: string,
    preferredName?: string,
  ): Promise<string>;

  /**
   * Downloads a web image and saves it like `saveVaultAsset` (ADR-0028) --
   * the main process `fetch`es `url` (http(s) only, redirects followed
   * with a final-protocol re-check, 15 s timeout, 25 MB cap, image
   * content-type / extension required), then writes the bytes into the
   * note's `attachments/`. Resolves to the note-relative path for
   * `![](...)`. Rejects with a short user-facing message on any of: not a
   * URL, non-http(s), HTTP error, timeout, too large, not an image.
   */
  saveVaultAssetFromUrl(url: string, noteRelPath: string, vaultId?: string): Promise<string>;

  /**
   * Creates an empty file inside a vault (any missing parent folders are
   * created too). `relativePath` follows the same forward-slash / no-escape
   * rules as `readVaultFile`; `vaultId` defaults to the active vault.
   * Rejects if a file or folder already exists at that path. Resolves to
   * the created file's vault-relative path (echoed back so the renderer
   * can open it in the editor).
   */
  createVaultFile(relativePath: string, vaultId?: string): Promise<string>;

  /**
   * Creates a directory inside a vault (missing parents included). Same
   * path rules as `createVaultFile`; `vaultId` defaults to the active
   * vault. Rejects if anything already exists at that path. Resolves to
   * the created directory's vault-relative path.
   */
  createVaultDirectory(relativePath: string, vaultId?: string): Promise<string>;

  /**
   * Renames / moves a file or folder. Both paths follow the
   * `readVaultFile` rules; refuses a vault root, a missing source and an
   * occupied target. When `fromVaultId` and `toVaultId` differ the entry
   * moves ACROSS vaults (copy + delete under the hood -- a `.md` note's
   * assistant sidecar comes along); both default to the active vault.
   * Resolves to the new vault-relative path (inside the target vault).
   */
  renameVaultEntry(
    fromRelativePath: string,
    toRelativePath: string,
    fromVaultId?: string,
    toVaultId?: string,
  ): Promise<string>;

  /**
   * Copies a file or folder (recursively) into `destDirRelativePath`
   * (`''` = vault root). Keeps the source name, or adds a `" copy"` /
   * `" copy N"` suffix on a collision. Refuses copying a folder into its
   * own subtree. A `.md` note's assistant sidecar is copied along.
   * `sourceVaultId`/`destVaultId` default to the active vault and may
   * differ (a cross-vault copy). Resolves to the new entry's
   * vault-relative path inside the destination vault.
   */
  copyVaultEntry(
    sourceRelativePath: string,
    destDirRelativePath: string,
    sourceVaultId?: string,
    destVaultId?: string,
  ): Promise<string>;

  /**
   * Copies an entry next to itself, always with a `" copy"` suffix.
   * `vaultId` defaults to the active vault. Resolves to the new entry's
   * vault-relative path.
   */
  duplicateVaultEntry(sourceRelativePath: string, vaultId?: string): Promise<string>;

  /**
   * Deletes a file or folder (recursively) inside a vault. Same path rules
   * as `readVaultFile`; `vaultId` defaults to the active vault; refuses
   * the vault root. Deleting a `.md` note also removes its assistant
   * sidecar (`.{name}.chat.json`) if present. A missing target is not an
   * error. Rejects only on a bad path or a real filesystem failure.
   */
  deleteVaultEntry(relativePath: string, vaultId?: string): Promise<void>;

  /**
   * Deletes several files / folders (recursively) inside one vault in a
   * single round trip -- the Files panel's multi-select delete (bug-8).
   * Same per-path rules as `deleteVaultEntry`; `vaultId` defaults to the
   * active vault; overlapping paths (a folder and a file inside it) are
   * fine because a missing target is not an error. One vault-change
   * re-index fires for the whole batch, not per path.
   */
  deleteVaultEntries(relativePaths: string[], vaultId?: string): Promise<void>;

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

  
  /**
   * The drawer's "Autotag" button: `entryText` plus the vault tag
   * vocabulary in, up to four suggested tags out. Only pre-fills the tag
   * field -- the user still confirms by saving. `taskId` makes it
   * cancellable. Rejects when LLM features are off.
   */
  suggestTags(entryText: string, taskId?: string): Promise<string[]>;

  /**
   * The tag vocabulary + configured prefix styles from the section-search
   * provider (the tags plugin registers it). Resolves to empty arrays when
   * no provider is registered — features degrade, never throw.
   */
  searchVocabulary(): Promise<TagVocabularyPayload>;

  /**
   * Fires when the section-search provider or its index changed (index
   * rebuild, settings change, plugin enable/disable). Returns an
   * unsubscribe.
   */
  onSearchChanged(listener: () => void): () => void;

  /** Current MCP vault server state for the Settings pane (ADR-0021). */
  getMcpStatus(): Promise<McpStatus>;

  /**
   * Subscribes to `vault_write` requests from an MCP client. The renderer
   * shows the shared confirmation diff and answers with
   * `resolveMcpWrite(request.id, approved)`. Never fires in YOLO mode.
   * Returns an unsubscribe; the raw IPC event is never forwarded.
   */
  onMcpWriteRequest(listener: (request: McpWriteRequest) => void): () => void;

  /** Answers an `onMcpWriteRequest` (approve / reject the write). */
  resolveMcpWrite(id: number, approved: boolean): Promise<void>;

  /**
   * Fires when vault changes have landed in main (ADR-0045): a watcher
   * batch of external edits, a manual refresh, or an MCP `vault_write`.
   * The payload's `paths` (when present) scope the reaction -- reload the
   * file tree, re-pull panel data, auto-reload the matching clean tabs.
   * Returns an unsubscribe.
   */
  onVaultChanged(listener: (push: VaultChangedPush) => void): () => void;

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

  // --- Plugin host (ADR-0044) ---------------------------------------------
  //
  // The renderer never talks to a plugin's IPC channels directly: it sees
  // the discovery report plus two generic primitives, and the plugin host
  // services build everything else on top.

  /** Every discovered plugin with its status (for the Settings → Plugins pane). */
  listPlugins(): Promise<PluginDescriptorForRenderer[]>;

  /** Invokes `method` on `pluginId`'s registered main-process handler. */
  invokePlugin(pluginId: string, method: string, payload?: unknown): Promise<unknown>;

  /**
   * Subscribes to the single plugin event push. `pluginOnEvent` receives
   * every plugin's events; the renderer plugin host fans them out by
   * `pluginId`. Returns an unsubscribe.
   */
  onPluginEvent(listener: (event: PluginIpcEventPayload) => void): () => void;
}

declare global {
  interface Window {
    dreyApi: DreyApi;
  }
}
