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
  ActionContext,
  ActionOutcome,
  AskOutcome,
  ChatMessage,
  LlmDebugEntry,
} from '../llm';
import type { AppConfig } from '../app-config';
import type { TagSearchHit, TagSearchQuery } from '../tags';
import type { TagEntry, VaultFileEntry } from '../ipc-api';
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
 * adopts `NoteSaveResult.content` today); `pendingActions` are confirmations
 * queued for the renderer's dialog.
 */
export interface SaveHookResult {
  content?: string;
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

  /** The LLM transport facade (transport stays base; feature logic is plugin-side). */
  readonly llm: {
    enabled(): boolean;
    /** One non-streamed completion; rejects when disabled (ADR-0014: no timeout — cancel via taskId). */
    chat(messages: readonly ChatMessage[], options?: MainChatOptions): Promise<string>;
    /** The enabled `on-save` triggers (id + confirm), so a save hook can run them. */
    actionsForEvent(event: 'on-save'): readonly { triggerId: string; confirm: boolean }[];
    runAction(triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome>;
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
