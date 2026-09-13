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
  ToolSpec,
} from '../llm';
import type { AppConfig } from '../app-config';
import type { TagEntry, TagSearchHit, TagSearchQuery } from './search-types';
import type { VaultFileEntry } from '../ipc-api';
import type { PluginManifest } from './manifest';

/** Fired after a note save has been written to disk (ADR-0044 rule 4). */
export interface NoteSavedEvent {
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

/** What a plugin registers so base surfaces (MCP `vault_search`) can query sections. */
export interface SectionSearchProvider {
  /** Tags AND + free-text AND over heading-tagged sections. */
  search(query: TagSearchQuery): Promise<readonly TagSearchHit[]>;
  /** The vault-wide tag vocabulary with occurrence counts. */
  vocabulary(): readonly TagEntry[];
}

export type VaultChangeEventKind = 'refresh' | 'write' | 'delete' | 'rename';

export interface VaultChangeEvent {
  readonly kind: VaultChangeEventKind;
  /** Vault-relative path, when the kind is specific to one (`write`/`delete`/`rename`). */
  readonly path?: string;
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
   * Opts this ONE call into the vault tool loop (ADR-0021): the model may
   * call `vault_search`/`vault_read`/`vault_write` before its final answer
   * (a write still goes through the user's confirmation). Only meaningful
   * when the base MCP switch is on; the tools stay base — the plugin never
   * gets the `VaultTools` instance itself.
   */
  readonly vaultTools?: boolean;
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
   * the tool result. Return error TEXT rather than throwing — a throw
   * fails the whole chat call. In-process only (same boundary as `onDelta`).
   */
  readonly onToolCall?: (name: string, argsJson: string) => Promise<string>;
  /**
   * Loop cap when the model keeps calling tools; the provider default is 5.
   * A multi-step editing turn (ADR-0049) needs more rounds.
   */
  readonly maxToolRounds?: number;
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
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<number>;
    /**
     * A write the app must SEE immediately: after writing, the same
     * external-change round an MCP write runs fires (per-file plugin index
     * events + one scoped `vault:changed` renderer push) — the Files tree,
     * the tag index and any clean open tab of that path refresh. Use for
     * app-generated first-class notes (the assistant's chat notes); use
     * plain `write` for hidden bookkeeping (sidecars) where the churn is
     * unwanted.
     */
    writeAnnounced(path: string, content: string): Promise<number>;
    /**
     * Stage binary bytes as a vault asset (the editor's ADR-0024 path):
     * hash-named under `attachments/` beside `noteRelPath`, collisions
     * suffixed. Returns the vault-relative path to reference.
     */
    saveAsset(bytes: Uint8Array, ext: string, noteRelPath: string): Promise<string>;
    list(): Promise<readonly VaultFileEntry[]>;
    /** Absolute path of a vault-relative asset, or null when it escapes the vault. */
    resolveAssetPath(relativePath: string): string | null;
    onChanged(cb: (event: VaultChangeEvent) => void): Unsubscribe;
    /** Native save dialog rooted at the vault (Save-as), vault-relative result or null. */
    pickSavePath(suggestedName: string): Promise<string | null>;
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
  readonly search: { registerSectionSearch(provider: SectionSearchProvider): Unsubscribe };

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
