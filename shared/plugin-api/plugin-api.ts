/**
 * The renderer-side plugin API: what a plugin's `renderer` entry receives
 * from `activate(api)`.
 *
 * Constraints on this file:
 * - it is DOM-typed (HTMLElement / DataTransfer): plugins contribute UI as
 *   plain DOM, not Angular (ADR-0044 rule 2). The main process must never
 *   import this file — `electron/tsconfig.json` compiles `shared/` without
 *   the DOM lib and explicitly excludes it, so an accidental main-side
 *   import is a compile error, not silent leakage;
 * - async/callback only, no framework types: a plugin takes no Angular
 *   version dependency, and a future out-of-process host stays possible;
 * - `CodeMirrorModules` hands out the HOST's `@codemirror/*` module
 *   instances (ADR-0044 rule 1): plugins must never import `@codemirror/*`
 *   at runtime — a second copy composes wrong, silently. `import type` for
 *   CM types is fine.
 */
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
import type { Unsubscribe } from './main-plugin-api';

/** The text selection in the focused editor surface, as offsets into the buffer. */
export interface PluginSelection {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** One open document (open tab), text or contributed kind. */
export interface OpenDocumentInfo {
  /** Vault-relative path, or the synthetic key of a contributed doc (`browser://…`). */
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly dirty: boolean;
  /** Live editor buffer, LF. */
  readonly buffer: string;
  /** Content as last saved / loaded from disk, LF. */
  readonly saved: string;
}

/** The active (focused-pane) document, plus its selection. */
export interface ActiveDocument extends OpenDocumentInfo {
  readonly selection: PluginSelection | null;
}

/**
 * Document events. `buffer-changed` is debounced (~150 ms) by the host —
 * per-keystroke callbacks would make every plugin a perf hazard.
 */
export type DocumentChangeEvent =
  | { type: 'active-changed'; path: string | null }
  | { type: 'buffer-changed'; path: string; content: string }
  | { type: 'dirty-changed'; path: string; dirty: boolean }
  | { type: 'docs-changed' }
  /** Confirmed-rewrite outcomes the save pipeline queued (on-save actions). */
  | { type: 'pending-actions'; actions: readonly ActionOutcome[] };

/** A proposed rewrite, routed through the shared confirmation dialog (ADR-0011). */
export interface RewriteRequest {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** Dialog header, e.g. "Meeting log". */
  readonly title: string;
  /** One-line description shown under the title. */
  readonly summary?: string;
  /** `'document'` renders the aligned side-by-side diff, `'localized'` the line diff. */
  readonly previewStyle: 'localized' | 'document';
}

/** Where a widget docks. Same three sides the shell has. */
export type PluginDockSide = 'left' | 'right' | 'bottom';

/** What a widget's header-status callback may read. */
export interface PluginStatusContext {
  /** True while the panel is collapsed to its 32px header. */
  readonly collapsed: boolean;
}

/**
 * A dock panel contribution. `id` is dock-state identity
 * (`localStorage['drey.dock']` + `widgets.disabled` key on it) — a plugin
 * replacing a built-in widget MUST reuse the built-in's id or every user's
 * layout resets (ADR-0044 rule 5).
 */
export interface PluginWidgetContrib {
  readonly id: string;
  /** Header label (mono-uppercase styling is the shell's). */
  readonly title: string;
  readonly defaultDock: PluginDockSide;
  readonly defaultOpen: boolean;
  readonly defaultFlex: number;
  /** Size to content instead of a flex share (no splitters on its edges). */
  readonly contentHeight?: boolean;
  /** Body fills the frame instead of scrolling (no second scrollbar). */
  readonly flush?: boolean;
  /** Header status value (right-aligned, dimmed) — recomputed on shell change detection. */
  status?(context: PluginStatusContext): string | null;
  /** Build the panel body; return cleanup (called on unregister). */
  mount(el: HTMLElement): () => void;
}

/** A Settings category contributed by a plugin. Its edits save immediately (rule 3). */
export interface PluginSettingsPageContrib {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  mount(el: HTMLElement): () => void;
}

/**
 * A contributed document kind — a tab that is not a text or image file
 * (the browser tab is the built-in example). `serialize`/`restore` back the
 * session history; `mount` builds the pane body.
 */
export interface PluginDocKindContrib {
  readonly kind: string;
  /** Session-snapshot data for one open doc of this kind, or null for stateless kinds. */
  serialize(path: string): unknown;
  /** Recreate one doc of this kind from its snapshot data. */
  restore(path: string, data: unknown): void;
  mount(el: HTMLElement, path: string): () => void;
  /** Tab-strip favicon (any img-able URL), or null for the fallback glyph. */
  favicon?(path: string): string | null;
  /** Status-bar text for the active doc of this kind, or null. */
  statusText?(path: string): string | null;
}

/** One menu row. Either run a registered command or pass a closure. */
export interface MenuContribution {
  readonly menu: 'file' | 'edit' | 'selection' | 'view';
  readonly label: string;
  readonly hint?: string;
  readonly commandId?: string;
  run?(): void;
}

/**
 * A drop decoder: consulted BEFORE the base file/image handling, so a
 * plugin can own a MIME family (`.ics`/`.msg` meetings, template drags).
 */
export interface DropDecoderContrib {
  /** Return true to claim this drop (first match wins; order = registration). */
  match(data: DataTransfer): boolean;
  /** Produce the Markdown/text to insert at the drop point. Reject with a user-facing message. */
  decode(data: DataTransfer): Promise<string>;
}

/** Which editor surfaces an extension applies to. */
export type EditorExtensionSlot = 'document' | 'composer' | 'both';

/** Where the surface is (document editor vs compact composer) and what it is editing. */
export interface EditorSurfaceContext {
  readonly slot: Exclude<EditorExtensionSlot, 'both'>;
  /** Active vault-relative path, or null (composer surfaces may be pathless). */
  readonly path: () => string | null;
  readonly filename: () => string | null;
}

/**
 * The host's CodeMirror module instances. Type-only imports
 * (`import type { EditorView } from '@codemirror/view'`) are fine and
 * encouraged; VALUE imports are forbidden — see the file header.
 */
export interface CodeMirrorModules {
  readonly state: typeof import('@codemirror/state');
  readonly view: typeof import('@codemirror/view');
  readonly autocomplete: typeof import('@codemirror/autocomplete');
  readonly language: typeof import('@codemirror/language');
  readonly langMarkdown: typeof import('@codemirror/lang-markdown');
}

/** A command: registered with the shell's keybinding service, listed for menus. */
export interface PluginCommand {
  readonly id: string;
  readonly label: string;
  /** Chord string, e.g. `Mod+Shift+K` (`Mod` = Ctrl/Cmd). Conflicts: first registration wins. */
  readonly keybinding?: string;
  run(): void;
}

/** Options for the LLM chat facade. `taskId` enables `llm.cancelTask(taskId)`. */
export interface PluginChatOptions {
  readonly temperature?: number;
  readonly taskId?: string;
}

/**
 * The object handed to a plugin's renderer entry. Every registration
 * returns an `Unsubscribe`; `deactivate()` runs them all plus the module's
 * own `deactivate`.
 */
export interface DreyPluginApi {
  readonly pluginId: string;
  readonly manifest: PluginManifest;

  /** The active/open documents: read, observe, navigate, insert, rewrite, save. */
  readonly documents: {
    active(): ActiveDocument | null;
    get(path: string): OpenDocumentInfo | null;
    list(): readonly OpenDocumentInfo[];
    /** Open a vault file as a tab; `line` places the caret (1-based). */
    open(path: string, line?: number): Promise<void>;
    /** Open an unsaved, dirty-from-the-start scratch tab (Save-as on first save). */
    openScratch(path: string, content: string): void;
    /** Insert at the caret of the FOCUSED pane. False when nothing is focused/editable. */
    insertAtCursor(text: string): boolean;
    /** Patch an open tab's buffer (unsaved edit, exactly as if typed). False when not open. */
    setBuffer(path: string, content: string): boolean;
    save(path?: string, options?: { runOnSaveActions?: boolean }): Promise<void>;
    /** Confirm-then-apply a rewrite (shared confirmation dialog). Resolves to the user's choice. */
    requestRewrite(request: RewriteRequest): Promise<boolean>;
    selection(): PluginSelection | null;
    onChange(listener: (event: DocumentChangeEvent) => void): Unsubscribe;
  };

  readonly vault: {
    readFile(path: string): Promise<{ content: string; modifiedMs: number }>;
    writeFile(path: string, content: string): Promise<number>;
    listFiles(): Promise<readonly VaultFileEntry[]>;
    /** Vault content changed (refresh/external write/MCP write) — re-read anything cached. */
    onChanged(listener: () => void): Unsubscribe;
  };

  readonly commands: {
    register(command: PluginCommand): Unsubscribe;
    run(id: string): void;
  };

  readonly ui: {
    registerWidget(widget: PluginWidgetContrib): Unsubscribe;
    registerSettingsPage(page: PluginSettingsPageContrib): Unsubscribe;
    registerDocKind(kind: PluginDocKindContrib): Unsubscribe;
    registerMenuContributions(items: readonly MenuContribution[]): Unsubscribe;
    /** A mount in the "Add entry" drawer (chip rows, helper buttons). */
    registerComposerContribution(mount: (el: HTMLElement) => () => void): Unsubscribe;
    /** Un-hide, open and focus a dock widget (e.g. a tag pill click revealing Search). */
    revealWidget(id: string): void;
    /** Modal overlay inside the shell's overlay container (guards still apply). */
    showModal(mount: (el: HTMLElement) => () => void): void;
  };

  readonly editor: {
    readonly cm: CodeMirrorModules;
    /**
     * Contribute CodeMirror extensions to the Markdown surfaces. `factory`
     * runs per surface (lazily, and again if the registry changes); return
     * an `Extension` built from `api.editor.cm.*` modules ONLY.
     */
    registerExtension(
      slot: EditorExtensionSlot,
      factory: (context: EditorSurfaceContext) => unknown,
    ): Unsubscribe;
    registerDropDecoder(decoder: DropDecoderContrib): Unsubscribe;
    /** Items appended to the editor context menu, re-evaluated per open. */
    registerContextMenuItems(items: () => readonly MenuContribution[]): Unsubscribe;
  };

  /** Section search + vocabulary, backed by whichever plugin registered the provider. */
  readonly search: {
    vocabulary(): Promise<readonly TagEntry[]>;
    searchSections(query: TagSearchQuery): Promise<readonly TagSearchHit[]>;
  };

  /** The plugin's own config (`<userData>/plugins/<id>/config.json`). Saves immediately. */
  readonly settings: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };

  /** Read the base app config; narrow, immediate patch (e.g. `templates.dir`). */
  readonly appConfig: {
    get(): Promise<AppConfig>;
    patch(partial: Partial<AppConfig>): Promise<void>;
  };

  /** This plugin's main-process bridge (`ctx.ipc.handle` / `ctx.ipc.emit`). */
  readonly backend: {
    invoke(method: string, payload?: unknown): Promise<unknown>;
    on(event: string, listener: (data: unknown) => void): Unsubscribe;
  };

  /** LLM facade; `null` while the master switch is off (the surface hides itself). */
  readonly llm: {
    enabled(): boolean;
    chat(messages: readonly ChatMessage[], options?: PluginChatOptions): Promise<string>;
    ask(context: ActionContext, question: string, taskId?: string): Promise<AskOutcome>;
    runAction(triggerId: string, context: ActionContext, taskId?: string): Promise<ActionOutcome>;
    cancelTask(taskId: string): Promise<boolean>;
    onDebugEntry(listener: (entry: LlmDebugEntry) => void): Unsubscribe;
  } | null;

  readonly env: {
    /** True while an overlay is up or a dock/split drag runs (native surfaces must hide). */
    onNativeSurfaceVisibility(listener: (hidden: boolean) => void): Unsubscribe;
    appVersion(): Promise<string>;
  };
}

/** The shape a plugin's `renderer` entry must default-export. */
export interface PluginRendererModule {
  activate(api: DreyPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
