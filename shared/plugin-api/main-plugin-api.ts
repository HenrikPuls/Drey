/**
 * The main-process plugin context: what a plugin's `main` entry receives
 * from `activate(ctx)`.
 *
 * Constraints on this file:
 * - it runs in the Electron main process, so `electron` types are fine
 *   (`import type` only — the import erases, nothing is required);
 * - it must stay free of DOM types (electron/tsconfig.json compiles all of
 *   `shared/` with `lib: ["ES2022"]`, no DOM — the DOM-typed renderer API
 *   lives in `plugin-api.ts` and is excluded from that compile);
 * - no Angular types (main has none, and plugins are framework-agnostic).
 */
import type { BrowserWindow, WebContents } from 'electron';
import type {
  ActionOutcome,
  ChatAttachment,
  ChatMessage,
  LlmCapabilities,
  LlmChatResult,
  LlmDebugEntry,
  ToolCallEvent,
  ToolSpec,
} from '../llm';
import type { AppConfig } from '../app-config';
import type {
  TagEntry,
  TagPrefixStyle,
  TagSearchHit,
  TagSearchQuery,
} from './search-types';
import type { VaultFileEntry, VaultStatus } from '../ipc-api';
import type { PluginManifest } from './manifest';

/** Fired after a note save has been written to disk (ADR-0044 rule 4). */
export interface NoteSavedEvent {
  /** The saved note's vault id (ADR-0051). */
  readonly vaultId: string;
  /** Vault-relative path. */
  readonly path: string;
  /** The content as written (frontmatter already bumped), LF. */
  readonly content: string;
  readonly modifiedMs: number;
  readonly eol: '\n' | '\r\n';
  /**
   * True when this save is itself applying a confirmed rewrite
   * (`runOnSaveActions: false` semantics) — hooks must not react to it, or
   * an applied rewrite re-triggers the hook that proposed it.
   */
  readonly applyingAction: boolean;
}

/**
 * What a save hook may return. `content` replaces the note's final content
 * (the hook rewrites, the pipeline adopts — mirroring how the renderer
 * adopts `NoteSaveResult.content` today); `modifiedMs` is the hook's own
 * write time for that rewrite (the pipeline hands it to the renderer as the
 * save result); `pendingActions` are confirmations queued for the renderer's
 * dialog.
 */
export interface SaveHookResult {
  content?: string;
  modifiedMs?: number;
  pendingActions?: readonly ActionOutcome[];
}

export type SaveHook = (
  event: NoteSavedEvent,
) => Promise<SaveHookResult | void> | SaveHookResult | void;

/**
 * Scope for a section search (ADR-0051). Omitted = the active vault (the
 * pre-multi-vault behavior); `{ kind: 'vault' }` = exactly one registered
 * vault; `{ kind: 'all' }` = every registered vault, hits stamped with
 * their `vaultId`.
 */
export type SectionSearchScope =
  | { readonly kind: 'vault'; readonly vaultId: string }
  | { readonly kind: 'all' };

/** What a plugin registers so base surfaces (MCP `vault_search`) can query sections. */
export interface SectionSearchProvider {
  /** Tags AND + free-text AND over heading-tagged sections, optionally scoped. */
  search(query: TagSearchQuery, scope?: SectionSearchScope): Promise<readonly TagSearchHit[]>;
  /** The tag vocabulary with occurrence counts, aggregated across all vaults. */
  vocabulary(): readonly TagEntry[];
  /**
   * Optional prefix styles (SDK 1.9): the configured tag-prefix colors the
   * provider knows about. Base surfaces merge these with the auto palette;
   * absent = no configured prefixes.
   */
  styles?(): { readonly prefixes: readonly TagPrefixStyle[] };
}

export type VaultChangeEventKind = 'refresh' | 'write' | 'delete' | 'rename';

/**
 * One task line, as the base's task surfaces (the assistant's `tasks_list`
 * tool, MCP `tasks_list`) see it — SDK 1.11. A structural twin of the
 * tasks plugin's internal record; the tasks plugin owns the grammar and
 * satisfies this shape.
 */
export interface SdkTaskRecord {
  /** Vault-relative path of the note. */
  readonly path: string;
  /** Owning vault id (ADR-0051). */
  readonly vaultId: string;
  /** 1-based line the task sits on. */
  readonly line: number;
  /** The task text: list marker, checkbox, `#task*` markers and metadata stripped. */
  readonly text: string;
  readonly done: boolean;
  readonly kind: 'checkbox' | 'tag';
  /** Nearest heading above the task, or `null` before the first one. */
  readonly heading: string | null;
  /** Distinct inline `#tags` of the task's heading section, lower-cased. */
  readonly tags: readonly string[];
  /** Due date as written (`YYYY-MM-DD`), or `null`. */
  readonly due: string | null;
  /** The line's priority glyph, or `null` (= normal). */
  readonly priority: 'highest' | 'high' | 'low' | null;
  /**
   * Completion date as written (`YYYY-MM-DD`), or `null` (SDK 1.13).
   * Absent on records persisted before 1.13.
   */
  readonly completed?: string | null;
}

/**
 * The deterministic list orders a `TaskQueryProvider` offers (SDK 1.12;
 * `completed` since 1.13).
 */
export type TaskQuerySort = 'file' | 'due' | 'priority' | 'importance' | 'completed';

/** Which tasks a query returns by done state (SDK 1.13). */
export type TaskQueryStatus = 'open' | 'done' | 'all';

/** Options for `TaskQueryProvider.query`; omitted fields mean "no restriction". */
export interface TaskQueryOptions {
  /** Only this vault's tasks (ADR-0051); omitted = every registered vault. */
  readonly vaultId?: string;
  /** Include completed tasks; default `false` (open tasks only). */
  readonly includeDone?: boolean;
  /**
   * Open tasks, completed tasks, or both (SDK 1.13). Wins over
   * `includeDone` when set; omitted = `includeDone`'s answer.
   */
  readonly status?: TaskQueryStatus;
  /**
   * Only tasks completed on or after this `YYYY-MM-DD` (SDK 1.13). The
   * date is the line's completion date, else the date in the note's file
   * name; a task with neither never matches.
   */
  readonly completedSince?: string;
  /**
   * The list order, applied by the provider (the data owner). `file` =
   * path + line; `due` = due date ascending, undated last; `priority` =
   * highest > high > normal > low; `importance` (the assistant block's
   * default) = due asc → priority → path/line; `completed` = completion
   * date newest first, undated last. Ties always fall back to
   * path + line. Default `file`.
   */
  readonly sort?: TaskQuerySort;
  /** Whitespace-split terms every task's text + heading must contain (AND). */
  readonly text?: string;
  /** One tag the task's section must carry — exact or namespace ancestor. */
  readonly tag?: string;
  /** Only tasks whose due date is before today (overdue). */
  readonly overdue?: boolean;
}

/**
 * What a plugin registers so base surfaces (the assistant's `tasks_list`
 * tool, MCP `tasks_list`) can query — and complete — tasks. SDK 1.11,
 * query filters/order since 1.12. The tasks plugin is the data owner:
 * the grammar (scanner, line resolution, the done toggle) lives there,
 * never in a consumer.
 */
export interface TaskQueryProvider {
  query(opts?: TaskQueryOptions): Promise<readonly SdkTaskRecord[]>;
  /**
   * Completes (or re-opens) one task line. The recorded `line` may be
   * stale — the provider re-resolves it against the current file content
   * and throws when the task cannot be located unambiguously. Returns the
   * updated record.
   */
  setDone(task: SdkTaskRecord, done: boolean): Promise<SdkTaskRecord>;
}

export interface VaultChangeEvent {
  readonly kind: VaultChangeEventKind;
  /** Vault-relative path, when the kind is specific to one (`write`/`delete`/`rename`). */
  readonly path?: string;
  /**
   * The vault the event concerns (ADR-0051). Absent on `refresh` means ALL
   * registered vaults must rebuild (a registry mutation or a full refresh
   * round); a present vaultId scopes the event to that one vault.
   */
  readonly vaultId?: string;
}

/** Optional vault targeting for a `ctx.vault` operation; omitted = the active vault. */
export interface VaultOpOptions {
  readonly vaultId?: string;
}

/** Unsubscribe function handed out by every `on*` registration. */
export type Unsubscribe = () => void;

/** Options for the LLM chat facade. `taskId` enables `llm.cancelTask(taskId)`. */
export interface MainChatOptions {
  readonly temperature?: number;
  readonly taskId?: string;
  /**
   * Incremental text (ADR-0047). A provider that cannot stream delivers
   * the full text through exactly one call, so consumers never branch.
   * In-process only -- the renderer-side facade (`api.llm`) cannot take a
   * callback across the IPC boundary and grows an `onDelta` push instead.
   */
  readonly onDelta?: (delta: string) => void;
  /**
   * Continue a provider-side session (Claude Code's `--resume`). Only
   * honoured by providers with the `sessions` capability; the result's
   * `sessionRef` is the handle to pass back here.
   */
  readonly sessionRef?: string;
  /**
   * Opts this ONE call into the vault tools (ADR-0021, recut in ADR-0071):
   * the model may list, search and read the vault (`vault_list`,
   * `vault_search`, `vault_read`) and — unless the user's vault write rule
   * (`tools.vault.write`) is `off` — change it (`vault_edit`,
   * `vault_write`, `vault_move`, `vault_delete`; a write is confirmed in
   * the diff dialog or applied directly, per that rule). The app's own
   * folders (`chats/`, `.drafts/`) stay out. The tools stay base — the
   * plugin never gets the `VaultTools` instance itself.
   */
  readonly vaultTools?: boolean;
  /**
   * The vaults this ONE call's vault tools may touch (SDK 1.20; since
   * SDK 1.24 the scope of reading AND writing, enforced where a tool
   * runs, ADR-0071): vault ids — the assistant passes its Vault chip's
   * selection. A `vault` argument outside it is refused; without the
   * argument a listing or search covers all of them. Absent: every
   * registered vault.
   */
  readonly vaultToolsScope?: readonly string[];
  /**
   * Files this ONE call's vault tools may read and change beside the
   * vaults of `vaultToolsScope` (SDK 1.25, ADR-0071) — the assistant
   * passes the note attached to the question, so the model changes it
   * with `vault_edit` even while the Vault chip is off (an empty scope
   * then offers `vault_read`, `vault_edit` and `vault_write` for these
   * files only). `vaultId` absent: the active vault; `null`: a tab that
   * belongs to no vault (never saved) — `path` is then the tab's name, and
   * the file is read and changed in the editor only, never saved by a
   * tool. Such a file can always be changed: where the user's write rule is `off`, the change is
   * asked in the diff dialog. `live` (ADR-0049) puts every change into the
   * file's open tab at once — no dialog, not saved.
   */
  readonly vaultToolsFiles?: readonly {
    readonly vaultId?: string | null;
    readonly path: string;
    readonly live?: boolean;
  }[];
  /**
   * Called after a vault tool of this call changed a file (SDK 1.25):
   * the text before and after, `\n` line ends; `vaultId` is `''` for a
   * tab outside every vault. In-process only.
   */
  readonly onVaultChange?: (change: {
    vaultId: string;
    path: string;
    before: string;
    after: string;
  }) => void;
  /**
   * Opts this ONE call into the EXTERNAL tool set (SDK 1.15, ADR-0063):
   * the built-in `web_fetch` and the tools of the user's MCP servers
   * (`mcp__<serverId>__<tool>`), as far as `tools` config enables them.
   * Each call passes its source's approval rule in the host. Plugin tools
   * and the vault set win a name collision.
   */
  readonly externalTools?: boolean;
  /**
   * The plugin's OWN tool specs for this ONE call (ADR-0049): the model may
   * call them before its final answer, and `onToolCall` runs each one.
   * Merged with the vault tool set when `vaultTools` is also set — on a
   * name collision the plugin's tool wins. Ignored by providers with the
   * `tools: false` capability (the CLI providers).
   */
  readonly tools?: readonly ToolSpec[];
  /**
   * Runs one plugin tool call; the resolved text goes back to the model as
   * the tool result. The arguments were checked against the tool's
   * `parameters` before this runs (SDK 1.23). Report a failure as text
   * starting with `Error:` and say how to correct the call; a throw is
   * turned into such a text and no longer fails the chat call. In-process
   * only (same boundary as `onDelta`).
   */
  readonly onToolCall?: (name: string, argsJson: string) => Promise<string>;
  /**
   * How many rounds of tool calls this call may take. Absent: the user's
   * setting (`tools.maxRounds`, SDK 1.23). When the budget is used up the
   * model is asked once for its answer without tools and the result
   * carries `toolBudgetExhausted`.
   */
  readonly maxToolRounds?: number;
  /**
   * Progress of the tool loop (SDK 1.23, ADR-0071): one `start` before a
   * tool runs and one `end` after it, for every tool of the call — the
   * plugin's own, the vault set and the external ones. In-process only.
   */
  readonly onToolEvent?: (event: ToolCallEvent) => void;
  /**
   * Images embedded into the LAST user message of this one call
   * (`ChatAttachment` is bytes — the caller resolves them; the provider
   * stays vault-ignorant). Ignored unless the active provider declares the
   * `imageAttachments` capability.
   */
  readonly attachments?: readonly ChatAttachment[];
  /**
   * Hard output cap for this one call (a transcription can run long).
   * Providers without such an option (the OpenAI-compatible dialect) ignore
   * it; the Anthropic dialect needs it to raise its default.
   */
  readonly maxOutputTokens?: number;
}

/**
 * The context handed to a plugin's main entry. Everything is scoped to the
 * activating plugin: `ipc.handle` registers into that plugin's method
 * allowlist, `config` reads that plugin's own config file, `log` prefixes
 * the plugin id.
 */
export interface MainPluginContext {
  readonly pluginId: string;
  readonly manifest: PluginManifest;

  readonly app: {
    /** The main window is created after plugins activate — subscribe, don't poll. */
    onMainWindowCreated(cb: (win: BrowserWindow) => void): Unsubscribe;
    getMainWindow(): BrowserWindow | null;
    onWillQuit(cb: () => void): Unsubscribe;
    readonly appVersion: string;
  };

  readonly vault: {
    /** Every registered vault with its live status (ADR-0051). */
    listVaults(): Promise<readonly VaultStatus[]>;
    read(path: string, opts?: VaultOpOptions): Promise<string>;
    write(path: string, content: string, opts?: VaultOpOptions): Promise<number>;
    /**
     * A write the app must SEE immediately: after writing, the same
     * external-change round an MCP write runs fires (per-file plugin index
     * events + one scoped `vault:changed` renderer push) — the Files tree,
     * the tag index and any clean open tab of that path refresh. Use for
     * app-generated first-class notes (the assistant's chat notes); use
     * plain `write` for hidden bookkeeping (sidecars) where the churn is
     * unwanted.
     */
    writeAnnounced(path: string, content: string, opts?: VaultOpOptions): Promise<number>;
    /**
     * Deletes a vault file or folder over the app's delete path (milestone
     * 52): to the OS recycle bin by default, permanently on volumes
     * without a bin — never silently unrecoverable. Returns whether the
     * target landed in the bin. Announced like `writeAnnounced`, so tree
     * and indexes follow immediately. (SDK 1.14 — the assistant's
     * template_delete is the first consumer.)
     */
    delete(path: string, opts?: VaultOpOptions): Promise<boolean>;
    /**
     * Shows the user a change in the shared confirmation diff (ADR-0011)
     * and resolves whether they approved it. Nothing is written -- the
     * caller writes after a `true`. (SDK 1.15: a tool group whose write
     * rule is `confirm`.)
     */
    confirmWrite(request: { path: string; before: string; after: string }): Promise<boolean>;
    /**
     * Tells the app that files of one vault changed on disk behind its
     * back (SDK 1.17 -- a plugin ran a tool that rewrites the working
     * tree, e.g. a git checkout). Runs the external-change round: the
     * Files tree reloads, the indexes follow and clean open tabs reload.
     * With paths the round is scoped to them; without, the whole vault is
     * re-read.
     */
    announceChanges(changes: {
      vaultId: string;
      changedPaths?: readonly string[];
      deletedPaths?: readonly string[];
    }): void;
    /**
     * Stage binary bytes as a vault asset (the editor's ADR-0024 path):
     * hash-named under `attachments/` beside `noteRelPath`, collisions
     * suffixed. Returns the vault-relative path to reference.
     */
    saveAsset(bytes: Uint8Array, ext: string, noteRelPath: string, opts?: VaultOpOptions): Promise<string>;
    list(opts?: VaultOpOptions): Promise<readonly VaultFileEntry[]>;
    /**
     * Flat walk of the vault's `.md` files, vault-relative and
     * forward-slash, dotfolders skipped. Feeds index scans (tags, tasks) —
     * much cheaper than `list`, which builds the full tree.
     */
    listMarkdownFiles(opts?: VaultOpOptions): Promise<readonly string[]>;
    /** Absolute path of a vault-relative asset, or null when it escapes the vault. */
    resolveAssetPath(relativePath: string, opts?: VaultOpOptions): string | null;
    onChanged(cb: (event: VaultChangeEvent) => void): Unsubscribe;
    /** Native save dialog rooted at the vault (Save-as), vault-relative result or null. */
    pickSavePath(suggestedName: string, opts?: VaultOpOptions): Promise<string | null>;
  };

  /** The base app config (ADR-0010). Read-only from a plugin — no patching from main. */
  readonly appConfig: { get(): AppConfig };

  /** The plugin's own config (`<userData>/plugins/<id>/config.json`). */
  readonly config: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };

  /** The note save pipeline (ADR-0044 rule 4). */
  readonly save: { onNoteSaved(hook: SaveHook): Unsubscribe };

  /** The section-search seam MCP's `vault_search` reads; null provider = tool degrades. */
  readonly search: {
    registerSectionSearch(provider: SectionSearchProvider): Unsubscribe;
    /**
     * The registered section-search provider (SDK 1.21) — the seam's read
     * side, mirroring `tasks.queryProvider()`: e.g. the assistant's action
     * engine embeds the provider's tag vocabulary into a prompt through it.
     * `null` when no plugin registered one.
     */
    sectionSearchProvider(): SectionSearchProvider | null;
    /**
     * Pushes `search:changed` to the renderer (SDK 1.9): call after the
     * provider's index or styles changed so base surfaces (tag completion,
     * prefix colors) re-pull. Also fired by the host when a provider
     * registers or unregisters.
     */
    notifyChanged(): void;
  };

  /**
   * The task-index seam (SDK 1.11): one plugin owns the task grammar and
   * registers the provider here; base surfaces (the assistant's
   * `tasks_list` tool, MCP `tasks_list`) read through `queryProvider()`.
   * `null` = no task provider registered (the tools degrade or stay
   * unattached).
   */
  readonly tasks: {
    registerTaskQuery(provider: TaskQueryProvider): Unsubscribe;
    queryProvider(): TaskQueryProvider | null;
  };

  /**
   * The LLM transport facade (transport stays base; feature logic is
   * plugin-side since ADR-0044 stage 7 — a plugin enumerates triggers from
   * `appConfig` via the shared `resolveActions` and runs them through
   * `chat`, which is exactly what the assistant plugin's engine does).
   */
  readonly llm: {
    enabled(): boolean;
    /**
     * One completion through the active provider (ADR-0047); rejects when
     * disabled (ADR-0014: no timeout — cancel via the renderer's
     * `llm.cancelTask(taskId)`). Returns the result shape so a provider's
     * session handle / usage / tool trace can flow through; the text is
     * `.text`.
     */
    chat(messages: readonly ChatMessage[], options?: MainChatOptions): Promise<LlmChatResult>;
    /** What the ACTIVE provider can and cannot do (ADR-0047 capability descriptor). */
    capabilities(): LlmCapabilities;
    /** The vocabulary-carrying tag suggestion (the `autotag` prompt); plugin supplies its vocabulary. */
    suggestTags(entryText: string, vocabulary: readonly string[], taskId?: string): Promise<string[]>;
    onDebugEntry(cb: (entry: LlmDebugEntry) => void): Unsubscribe;
  };

  /**
   * The plugin's namespaced renderer bridge. `handle(method, fn)` registers
   * into this plugin's allowlist (one name — re-registering replaces);
   * `emit(event, data)` pushes to the plugin's renderer side.
   */
  readonly ipc: {
    handle(method: string, fn: (payload: unknown, sender: WebContents) => unknown): void;
    emit(event: string, data?: unknown): void;
  };

  /** Structured log line into the field log, prefixed with the plugin id. */
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/** The shape a plugin's `main` entry must default-export. */
export interface MainPluginModule {
  activate(context: MainPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
