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
import type { ActionOutcome, ChatMessage, LlmCapabilities, LlmDebugEntry } from '../llm';
import type { AppConfig } from '../app-config';
import type { SectionSearchScope, VaultOpOptions } from './main-plugin-api';
import type { TagSearchHit, TagSearchQuery } from './search-types';
import type { TagEntry, VaultFileEntry, VaultStatus } from '../ipc-api';
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
  /**
   * The doc's vault id (ADR-0051); null for non-vault docs (a
   * contributed kind like `browser://…`, or a never-located scratch tab).
   */
  readonly vaultId: string | null;
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
 * `pending-actions` is a handover, not a broadcast: the host consumes the
 * save pipeline's queue when it fires, so exactly the listening plugins
 * own the outcomes afterwards (the assistant plugin drains them into the
 * confirmation dialog).
 */
export type DocumentChangeEvent =
  /** `path` is the BARE vault-relative path (the `OpenDocumentInfo.path`
   * identity), with the owning vault in `vaultId` — not the internal
   * `vaultId::path` doc key. */
  | { type: 'active-changed'; path: string | null; vaultId: string | null }
  | { type: 'buffer-changed'; path: string; vaultId: string | null; content: string }
  | { type: 'dirty-changed'; path: string; vaultId: string | null; dirty: boolean }
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
  /**
   * The Action trigger this rewrite came from, if any — enables the
   * dialog's "don't ask again for this action" checkbox (it flips that
   * trigger's `confirm` in the app config). Omit/null for ad-hoc rewrites.
   */
  readonly triggerId?: string | null;
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
  /**
   * Builds the panel's own control row into the shared 32px header
   * (right-aligned before the grip, e.g. a refresh button). The element is
   * styled by the shell; return cleanup. Rendered only while expanded.
   */
  headerActions?(el: HTMLElement): () => void;
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
 * session history; `mount` builds the pane body. Recreate tabs from a
 * snapshot with `documents.addDoc(kind, path, name)` inside `restore`.
 */
export interface PluginDocKindContrib {
  readonly kind: string;
  /** Session-snapshot data for one open doc of this kind, or null for stateless kinds. */
  serialize(path: string): unknown;
  /** Recreate one doc of this kind from its snapshot data. */
  restore(path: string, data: unknown): void;
  /** Build the pane body; return cleanup (called when the tab unmounts). */
  mount(el: HTMLElement, path: string): () => void;
  /** Tab-strip favicon (any img-able URL), or null for the fallback glyph. */
  favicon?(path: string): string | null;
  /** Tab-strip fallback glyph — an icon name from the host's vendored set. */
  icon?: string;
  /** Status-bar text for the active doc of this kind, or null. */
  statusText?(path: string): string | null;
  /** The doc's pane gained/lost focus (e.g. to gate a find-in-page chord). */
  onFocused?(path: string, focused: boolean): void;
}

/** One menu row. Either run a registered command or pass a closure. */
export interface MenuContribution {
  /**
   * `file`/`edit`/`selection`/`view` are the titlebar menus;
   * `editor-more` is the per-pane editor meta-bar `⋯` menu, where the
   * rows render after "Save as…" (the manual Actions rows' home since
   * the assistant conversion, ADR-0044 stage 7).
   */
  readonly menu: 'file' | 'edit' | 'selection' | 'view' | 'editor-more';
  readonly label: string;
  readonly hint?: string;
  readonly commandId?: string;
  run?(): void;
}

/**
 * One row in the renderer-owned editor context menu (ADR-0030). No `menu`
 * field — this is not a titlebar menu; items are appended after the
 * built-in clipboard/template rows.
 */
export interface ContextMenuItem {
  readonly label: string;
  /** Grayed out, unclickable — for "this exists, but not right now". */
  readonly disabled?: boolean;
  run(): void;
}

/**
 * What the editor context menu was opened on (where the click landed).
 * `image` is the `kind: 'image'` tab surface; `editor` is any CodeMirror
 * surface — `docPath` is null unless the surface IS an open pane text
 * document (the entry drawer's and plugin composers' editors pass null, so
 * document-scoped rows stay away from non-document surfaces).
 */
export type EditorContextMenuTarget =
  | {
      readonly surface: 'editor';
      /** Vault-relative path of the clicked pane's document, else null. */
      readonly docPath: string | null;
      /** The DOM node the click landed on (e.g. an `<img>` inside a widget). */
      readonly target: Element;
      /** 1-based line number at the click, when the position maps. */
      readonly lineNumber: number | null;
      /** That line's text (LF, no break) — raw source even under a widget. */
      readonly lineText: string | null;
    }
  | {
      readonly surface: 'image';
      /** Vault-relative path of the image the tab shows. */
      readonly imagePath: string;
    };

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
  /**
   * `payload` carries optional context from the invoker (SDK 1.9 — e.g.
   * base tag pills run the Search panel's `search.open` with `{ tag }`);
   * keyboard invocations pass none.
   */
  run(payload?: unknown): void;
}

/** Options for `ui.createTagField` (SDK 1.9). */
export interface TagFieldOptions {
  /** Initial (already normalized) chip values. */
  readonly values?: readonly string[];
  /** Fires with the normalized (lower-cased, de-duplicated) values on every change. */
  readonly onChange: (values: string[]) => void;
  /** Input placeholder; default `+ tag`. */
  readonly placeholder?: string;
  /** Accessible label for the input; default `Tags`. */
  readonly ariaLabel?: string;
  /** Vocabulary completion dropdown; default true. `false` = plain chip field. */
  readonly completions?: boolean;
}

/** Handle to a mounted tag field (see `ui.createTagField`). */
export interface TagFieldHandle {
  /** The field root — append it into your panel DOM. */
  readonly element: HTMLElement;
  /** Focuses the field's input (also opens the completion dropdown when applicable). */
  focus(): void;
  /** Replaces the chips without firing `onChange`. */
  setValues(values: readonly string[]): void;
  /** Detaches the field and releases listeners; call when the panel unmounts. */
  dispose(): void;
}

/** Options for the LLM chat facade. `taskId` enables `llm.cancelTask(taskId)`. */
export interface PluginChatOptions {
  readonly temperature?: number;
  readonly taskId?: string;
  /**
   * Opts this ONE call into the vault tool loop (ADR-0021): the model may
   * call `vault_search`/`vault_read`/`vault_write` before its final answer
   * (a write still goes through the user's confirmation). Only meaningful
   * when the base MCP switch is on.
   */
  readonly vaultTools?: boolean;
}

/**
 * One streamed-text push (ADR-0047): the delta belongs to the chat task
 * with this renderer-minted `taskId`. A provider that cannot stream
 * delivers its full text as exactly one event. Shape lives in
 * `shared/ipc-api.ts` (the push channel's payload); re-exported here so
 * plugin code has one import point.
 */
export type { LlmDeltaEvent } from '../ipc-api';
import type { LlmDeltaEvent } from '../ipc-api';
export type { LlmModelListing } from '../llm';
import type { LlmModelListing } from '../llm';

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
    /**
     * Open a vault file as a tab; `line` places the caret (1-based);
     * `opts.vaultId` names the vault (ADR-0051), defaulting to the active
     * vault.
     */
    open(path: string, line?: number, opts?: VaultOpOptions): Promise<void>;
    /** Open an unsaved, dirty-from-the-start scratch tab (Save-as on first save). */
    openScratch(path: string, content: string): void;
    /**
     * Register a tab of a contributed doc kind (`kind` as given to
     * `ui.registerDocKind`). `key` must not collide with a vault path — a
     * scheme key like `browser://1` is safe. Focuses the tab if the key is
     * already open. Throws when the kind is not registered.
     */
    addDoc(kind: string, key: string, name: string): void;
    /**
     * Rename a contributed doc's tab label (e.g. the browser tab following
     * the page title). No-op for text docs.
     */
    rename(path: string, name: string): void;
    /** Insert at the caret of the FOCUSED pane. False when nothing is focused/editable. */
    insertAtCursor(text: string): boolean;
    /** Patch an open tab's buffer (unsaved edit, exactly as if typed). False when not open. */
    setBuffer(path: string, content: string): boolean;
    /**
     * Block user input on an open tab while a flow (the live-edit turn,
     * ADR-0049) edits it programmatically. Advisory: programmatic
     * `setBuffer` calls keep working. False when the tab is not open.
     */
    setEditLock(path: string, locked: boolean): boolean;
    save(path?: string, options?: { runOnSaveActions?: boolean }): Promise<void>;
    /** Confirm-then-apply a rewrite (shared confirmation dialog). Resolves to the user's choice. */
    requestRewrite(request: RewriteRequest): Promise<boolean>;
    selection(): PluginSelection | null;
    onChange(listener: (event: DocumentChangeEvent) => void): Unsubscribe;
  };

  readonly vault: {
    /** Every registered vault with its live status (ADR-0051). */
    listVaults(): Promise<readonly VaultStatus[]>;
    readFile(path: string, opts?: VaultOpOptions): Promise<{ content: string; modifiedMs: number }>;
    writeFile(path: string, content: string, opts?: VaultOpOptions): Promise<number>;
    /**
     * Stage binary bytes as a vault asset (ADR-0024): saved under
     * `attachments/` beside `noteRelPath`, hash-named, collisions
     * suffixed. Returns the vault-relative path to reference. Structured
     * clone carries the bytes over the IPC bridge.
     */
    saveAsset(bytes: Uint8Array, ext: string, noteRelPath: string, opts?: VaultOpOptions): Promise<string>;
    listFiles(opts?: VaultOpOptions): Promise<readonly VaultFileEntry[]>;
    /** Vault content changed (refresh/external write/MCP write) — re-read anything cached. */
    onChanged(listener: () => void): Unsubscribe;
  };

  readonly commands: {
    register(command: PluginCommand): Unsubscribe;
    /** Invoke a command by id; unknown ids are a no-op. `payload` passes through. */
    run(id: string, payload?: unknown): void;
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
    /**
     * Modal overlay inside the shell's overlay container (guards still
     * apply). Backdrop click closes it; the returned function closes it
     * programmatically (picker Enter/Esc). Idempotent.
     */
    showModal(mount: (el: HTMLElement) => void): () => void;
    /**
     * An OK-only acknowledgement dialog in the app's own UI — the safe
     * replacement for `window.alert()`, whose native dialog breaks Windows
     * keyboard focus after dismissal (electron#41602). Resolves once
     * acknowledged; sequential calls queue like the native dialogs did.
     */
    showMessage(message: string, title?: string): Promise<void>;
    /**
     * The shared tag chip field (SDK 1.9): colored chips with a completion
     * dropdown fed by the section-search provider's vocabulary — the same
     * component the base entry drawer uses. Mount `handle.element`, sync
     * via `setValues`, dispose with the panel.
     */
    createTagField(opts: TagFieldOptions): TagFieldHandle;
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
    /**
     * Items appended to the editor context menu, re-evaluated per open.
     * The callback receives the click target (embedded image vs image tab
     * vs plain editor position) so rows can be surface-scoped.
     */
    registerContextMenuItems(
      items: (target: EditorContextMenuTarget) => readonly ContextMenuItem[],
    ): Unsubscribe;
  };

  /** Section search + vocabulary, backed by whichever plugin registered the provider. */
  readonly search: {
    vocabulary(): Promise<readonly TagEntry[]>;
    /** `scope` defaults to the active vault; `{ kind: 'all' }` spans every vault. */
    searchSections(query: TagSearchQuery, scope?: SectionSearchScope): Promise<readonly TagSearchHit[]>;
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

  /**
   * LLM transport facade. Feature logic (actions, Ask, summaries) is
   * plugin-side since ADR-0044 stage 7 — the assistant plugin exposes its
   * own `backend.invoke` methods — so the facade is the completion call
   * (with the optional vault tool loop), the master switch, task cancel
   * and the debug feed.
   */
  readonly llm: {
    enabled(): boolean;
    chat(messages: readonly ChatMessage[], options?: PluginChatOptions): Promise<string>;
    /**
     * The ACTIVE provider's label, listing capability and best-effort model
     * list (ADR-0047). Never rejects -- a failed listing lands in `error`,
     * a provider without a listing endpoint resolves `models: []` +
     * `modelListing: false`; the model id stays hand-enterable either way.
     */
    listModels(): Promise<LlmModelListing>;
    /** What the ACTIVE provider can and cannot do (ADR-0047) — gate UI, don't hardcode provider ids. */
    capabilities(): Promise<LlmCapabilities>;
    cancelTask(taskId: string): Promise<boolean>;
    onDebugEntry(listener: (entry: LlmDebugEntry) => void): Unsubscribe;
    /**
     * The ACTIVE provider's capabilities re-pushed after every app-config
     * write (a provider switch changes them) — keeps synchronously-readable
     * UI caches (context-menu gating) fresh without re-polling.
     */
    onCapabilitiesChanged(listener: (capabilities: LlmCapabilities) => void): Unsubscribe;
    /**
     * Streamed-text pushes (ADR-0047) for tasks this renderer started with
     * a matching `taskId`. Serialised IPC cannot carry a callback in the
     * call, so streaming arrives here instead of through `chat`.
     */
    onDelta(listener: (event: LlmDeltaEvent) => void): Unsubscribe;
  };

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
