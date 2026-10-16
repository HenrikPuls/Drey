/**
 * The assistant panel's state — a plain-JS factory with its ports
 * injected, so the unit spec can drive it without a DOM (ADR-0044: plugin
 * logic stays framework-free; the DOM layer is `panel.ts`).
 *
 * Since ADR-0048 the conversation lives in a chat note under `chats/`
 * (the note IS the source of truth; the main-side engine persists every
 * turn and replays the full history). The renderer holds only *session*
 * state: which chat is active and the context chips (the open note — on
 * by default — extra files, images), plus a streaming buffer.
 */
import type { ActionOutcome } from '../../../shared/plugin-api';
import type { AskRequest, AssistantOutcome } from '../shared/ask';
import { MAX_EXTRA_FILES, MAX_IMAGES, truncateFileBody } from '../shared/ask.js';
import { normalizeVaultScope, type VaultScope } from '../shared/vault-context.js';
import {
  isChatNotePath,
  isDailyNotePath,
  type ChatNoteView,
  type ChatSummary,
} from '../shared/chat-note.js';
import { ipcErrorMessage } from '../../../shared/ipc-error';
import { isAutoSavePath } from '../../../shared/structural-folders';
import { type RunningTasks } from './running-tasks.js';

/** The text a cancelled generation reports. */
const CANCELLED = 'Generation cancelled.';

/** localStorage key for the Vault chip's remembered scope. */
const VAULT_SCOPE_KEY = 'drey.assistant.vaultScope';
/** localStorage key for the custom selection's vault ids (JSON array). */
const VAULT_SCOPE_VAULTS_KEY = 'drey.assistant.vaultScopeVaults';

function loadVaultScope(): VaultScope {
  try {
    return normalizeVaultScope(globalThis.localStorage?.getItem(VAULT_SCOPE_KEY) ?? 'off');
  } catch {
    return 'off';
  }
}

function loadCustomVaultIds(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(VAULT_SCOPE_VAULTS_KEY);
    if (raw === undefined || raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function storeVaultScope(scope: VaultScope, vaultIds: readonly string[]): void {
  try {
    if (scope === 'off') {
      globalThis.localStorage?.removeItem(VAULT_SCOPE_KEY);
    } else {
      globalThis.localStorage?.setItem(VAULT_SCOPE_KEY, scope);
    }
    if (scope === 'custom') {
      globalThis.localStorage?.setItem(VAULT_SCOPE_VAULTS_KEY, JSON.stringify(vaultIds));
    } else {
      globalThis.localStorage?.removeItem(VAULT_SCOPE_VAULTS_KEY);
    }
  } catch {
    // Storage unavailable (tests, privacy mode) — session state only.
  }
}

/** localStorage key for the Web chip (present = on). */
const WEB_KEY = 'drey.assistant.web';

function loadWeb(): boolean {
  try {
    return globalThis.localStorage?.getItem(WEB_KEY) === 'on';
  } catch {
    return false;
  }
}

function storeWeb(on: boolean): void {
  try {
    if (on) {
      globalThis.localStorage?.setItem(WEB_KEY, 'on');
    } else {
      globalThis.localStorage?.removeItem(WEB_KEY);
    }
  } catch {
    // Storage unavailable (tests, privacy mode) — session state only.
  }
}

/**
 * An attached unsaved scratch tab (e.g. the search summary). The live
 * buffer rides at send time; each send also snapshots the current text
 * under `.drafts/` so follow-up replays — which re-read attachments from
 * the vault — keep the context after the tab is closed.
 */
export interface ScratchChip {
  /** The open tab's document path (e.g. `search-summary.md`). */
  docPath: string;
  /** The `.drafts/` snapshot written on the last send; null until then. */
  snapshotPath: string | null;
}

/** Whether a rejection is "the user pressed Cancel" (not a fault). */
function isCancellation(error: unknown): boolean {
  return /abort/i.test(ipcErrorMessage(error)) || ipcErrorMessage(error) === CANCELLED;
}

/** Everything the state needs from the host API; injected for testability. */
/** One step of a running tool loop as the plugin's main side pushes it. */
export interface ToolProgressEvent {
  taskId: string;
  phase: 'start' | 'end';
  id: string;
  name: string;
  argsJson: string;
  ok?: boolean;
}

/** A tool call of the generation in flight, as the panel shows it while it runs. */
export interface RunningTool {
  id: string;
  name: string;
  argsJson: string;
  state: 'running' | 'done' | 'failed';
}

export interface StreamingTurn {
  taskId: string;
  text: string;
  tools: readonly RunningTool[];
}

/** The running-tool list after one progress event (pure). */
export function applyToolProgress(
  tools: readonly RunningTool[],
  event: ToolProgressEvent,
): RunningTool[] {
  if (event.phase === 'start') {
    return [
      ...tools,
      { id: event.id, name: event.name, argsJson: event.argsJson, state: 'running' },
    ];
  }
  const state = event.ok === false ? 'failed' : 'done';
  // The last running call with this id: a model may reuse an id across rounds.
  const index = tools.map((tool) => tool.id === event.id && tool.state === 'running').lastIndexOf(true);
  return index < 0 ? [...tools] : tools.map((tool, i) => (i === index ? { ...tool, state } : tool));
}

export interface AssistantPorts {
  // -- chat notes (ADR-0048) ----------------------------------------------
  listChats(): Promise<ChatSummary[]>;
  readChat(path: string): Promise<ChatNoteView>;
  ask(
    request: AskRequest,
    taskId?: string,
  ): Promise<{
    chatPath: string;
    outcome: AssistantOutcome;
    contextCount: number;
    contextError?: string;
  }>;
  /** Persists the confirm outcome into the last assistant turn's fence. */
  appendEdit(path: string, applied: boolean, after?: string): Promise<void>;
  /** Drops every turn from `turnIndex` on (restart-from-here). */
  truncate(path: string, turnIndex: number): Promise<void>;
  /**
   * Native file dialog for files NOT yet in the vault; each pick is staged
   * into the vault (chat attachments convention) and returned as chip
   * paths. `skipped` names files that are neither text nor image.
   */
  attachExternal(referenceNote: string): Promise<{
    staged: { path: string; kind: 'file' | 'image' }[];
    skipped: string[];
  }>;
  /** An open scratch tab's live buffer; null when the tab is not open. */
  scratchBody(docPath: string): string | null;
  /**
   * Persists a scratch tab's current text under `.drafts/` (assistant
   * context snapshot) and returns the vault-relative path.
   */
  writeScratchSnapshot(docPath: string, body: string): Promise<string>;
  /** Streamed answer text for a task this state started (`chat:delta`). */
  onDelta(listener: (event: { taskId: string; text: string }) => void): () => void;
  /** One step of the running tool loop for a task this state started (`chat:toolEvent`). */
  onToolEvent(listener: (event: ToolProgressEvent) => void): () => void;

  // -- shared --------------------------------------------------------------
  /**
   * A file's text for attachment: the live buffer when the file is open,
   * else its vault content; `null` when it is gone from the vault.
   */
  readVaultFile(path: string): Promise<string | null>;
  cancel(taskId?: string): Promise<void>;
  /** The active document's path + buffer + owning vault, or null. */
  activeDoc(): { path: string; body: string; vaultId: string | null } | null;
  /** LLM master switch (live). */
  llmEnabled(): boolean;
  /** Confirm-then-apply a rewrite (shared dialog; the host applies on confirm). */
  requestRewrite(request: {
    path: string;
    before: string;
    after: string;
    title: string;
    summary?: string;
    previewStyle: 'localized' | 'document';
    triggerId?: string | null;
  }): Promise<boolean>;
  /**
   * Blocks user input on an open tab while the live-edit turn edits it
   * (ADR-0049). Released by this state in the ask's `finally`.
   */
  setEditLock(path: string, locked: boolean): void;
  /**
   * Whether Settings has anything switched on that leaves the machine —
   * web search, web fetch, an MCP server (live). The Web chip shows only
   * then.
   */
  externalTools(): Promise<boolean>;
  /**
   * The configured daily-notes root (AppConfig `daily.dir`, live) — the
   * decoupling anchor: a daily note never binds a chat and never pulls
   * one on focus (57c).
   */
  dailyDir(): Promise<string>;
  /** The registered vaults (id, name, active) — the Vault chip's picker. */
  listVaults(): Promise<readonly { id: string; name: string; active: boolean }[]>;
}

/** Live edit only ever targets a user note: never the app-owned auto-save paths (`chats/`, `.drafts/`). */
function isLiveEditablePath(path: string): boolean {
  return !isAutoSavePath(path);
}

/** The relative-path half of a doc key (`vaultId::relativePath`); null when malformed. */
function docKeyPath(noteKey: string): string | null {
  const sep = noteKey.indexOf('::');
  if (sep <= 0 || sep === noteKey.length - 2) {
    return null;
  }
  return noteKey.slice(sep + 2);
}

export interface AssistantState {
  /** The active note's path (null = no text document open). */
  notePath(): string | null;
  /** The picker list (most recently updated chat first). */
  chats(): readonly ChatSummary[];
  /**
   * True when the last chat-list attempt failed — the picker says so
   * instead of "No chats yet" (a silently empty list once hid a real
   * listing bug for weeks).
   */
  chatsFailed(): boolean;
  /** The active chat's path, or null when the next ask starts a NEW chat. */
  activeChatPath(): string | null;
  /** The active chat's parsed note; null when none is loaded. */
  view(): ChatNoteView | null;
  asking(): boolean;
  /** The in-flight generation: its streamed text and the tool calls made so far. */
  streaming(): StreamingTurn | null;
  /** Something went wrong — shown in the accent colour. */
  error(): string | null;
  /** A cancellation or other non-fault — shown quiet. */
  notice(): string | null;
  /** A manual Action's noop/error message (was the editor meta-bar line). */
  actionMessage(): string | null;
  /** Clears the error/notice lines. */
  dismiss(): void;
  dismissActionMessage(): void;
  /**
   * Context chips (session state like the switch): whether the open note
   * itself rides along (default on), which extra files and images are
   * attached. Not persisted — a per-question choice.
   */
  noteIncluded(): boolean;
  setNoteIncluded(on: boolean): void;
  /**
   * Live edit (ADR-0049): when on, the next ask lets the model edit the
   * open note directly — changes apply immediately, nothing is confirmed.
   * Session state like the chips; requires a live-editable open note.
   */
  liveEdit(): boolean;
  toggleLiveEdit(): void;
  /**
   * The Vault chip's scope (ADR-0072): `off` (chip dark) / `vault` /
   * `all` / `custom` (the picker's explicit subset — `customVaultIds`).
   * Session state persisted to localStorage; set through the chip's
   * picker. A `custom` selection whose vaults vanished from the registry
   * is pruned (and falls back to `off` when nothing survives).
   */
  vaultScope(): VaultScope;
  /** The `custom` selection's vault ids (registry order). */
  customVaultIds(): readonly string[];
  /** The vault registry as last seen (empty until the first refresh landed). */
  vaults(): readonly { id: string; name: string; active: boolean }[];
  setVaultScope(scope: VaultScope, vaultIds?: readonly string[]): void;
  /** Re-reads the registry and prunes a stale custom selection. */
  refreshVaults(): Promise<void>;
  /**
   * The Web chip (milestone 79): whether the next ask may reach outside
   * the machine — web search, web fetch, the user's MCP servers.
   * Remembered across sessions like the Vault chip; off until switched on.
   */
  web(): boolean;
  toggleWeb(): void;
  /** Whether Settings has any of those switched on; the chip shows only then. */
  webAvailable(): boolean;
  /** Re-reads that from the config (it changes in Settings, not here). */
  refreshWeb(): Promise<void>;
  extraFiles(): readonly string[];
  /** Adds a file chip; resolves to a reason string when refused. */
  addFile(path: string): { ok: boolean; reason?: string };
  removeFile(path: string): void;
  /** Attached unsaved scratch tabs (e.g. the search summary). */
  scratchFiles(): readonly ScratchChip[];
  /** Adds a scratch-tab chip; resolves to a reason string when refused. */
  addScratch(docPath: string): { ok: boolean; reason?: string };
  removeScratch(docPath: string): void;
  images(): readonly string[];
  /** Adds an image chip (a vault-relative path); reason string when refused. */
  addImage(path: string): { ok: boolean; reason?: string };
  removeImage(path: string): void;
  /** Runs the openNote rule: track the note for the chips. */
  openNote(path: string): Promise<void>;
  /** Nothing text-shaped is active (a browser tab, or no pane). */
  closeNote(): void;
  /**
   * Follows the active document (req: the panel is bound to the open
   * note): a chat-note tab opens that chat, a bound note opens its NEWEST
   * chat, and an unbound focus keeps the current chat (only the first
   * follow at activation falls back to the newest chat). Skipped while a
   * generation runs; a stale in-flight follow (superseded by a newer
   * switch) never lands.
   */
  followActiveDoc(noteKey: string | null): Promise<void>;
  /** Loads a chat into the panel (the picker's click). */
  openChat(path: string): Promise<void>;
  /** Next ask starts a new chat note. */
  newChat(): void;
  /** Native dialog; stages external files into the vault and adds chips. Returns how many landed. */
  attachExternal(): Promise<number>;
  /** Sends a question; resolves false when it was not sent (so the composer can keep the text). */
  ask(question: string, options?: { selection?: string }): Promise<boolean>;
  /** How many turns a "restart from here" at `turnIndex` would drop. */
  laterCount(turnIndex: number): number;
  /** Rewinds to just before `turnIndex`; returns the removed question's text. */
  restartFrom(turnIndex: number): Promise<string | null>;
  /** An Action run reported a noop/error — the panel shows it. */
  reportActionOutcome(outcome: ActionOutcome): void;
  /** Vault content changed — the chat list cache is stale. */
  invalidateChats(): void;
  cancelRunning(): Promise<void>;
  took(durationMs: number | undefined): string | null;
  /** Re-renders subscribe here. */
  subscribe(listener: () => void): () => void;
}

export function createAssistantState(ports: AssistantPorts, tasks: RunningTasks): AssistantState {
  /** The picker list cache; invalidated on vault changes. */
  let chats: ChatSummary[] = [];
  let chatsLoaded = false;
  /** The active chat note (parsed view cached; re-read after each mutation). */
  let activeChat: string | null = null;
  let view: ChatNoteView | null = null;

  /** The active NOTE (for chips + ask context) — independent of the chat. */
  let activePath: string | null = null;

  /** Chips are keyed by the note path (or '' when no note is open). */
  const chipKey = (): string => activePath ?? '';
  const noteExcluded = new Set<string>();
  const filesByNote = new Map<string, string[]>();
  const scratchByNote = new Map<string, ScratchChip[]>();
  const imagesByKey = new Map<string, string[]>();

  let asking = false;
  /** True after a failed chat-list attempt; cleared by the next success. */
  let chatsError = false;
  /** Counts followActiveDoc calls so a slow listChats can't clobber a newer switch. */
  let followSeq = 0;
  /**
   * True until the first follow completes: the panel then starts on the
   * newest chat instead of empty (app start, nothing restored). Only that
   * one call auto-opens — an explicit "New chat" afterwards must survive
   * tab switches.
   */
  let firstFollow = true;
  /**
   * The doc key a switch wanted followed while a generation was running —
   * re-run when the ask finishes, or the switch is lost and the panel
   * stays on the old document's chat until the NEXT tab switch.
   */
  let deferredFollowKey: string | null | undefined;
  /** Live edit (ADR-0049) — session flag, one toggle in the chips row. */
  let liveEdit = false;
  /** The Vault chip's scope (ADR-0072) — remembered across sessions. */
  let vaultScope: VaultScope = loadVaultScope();
  // Ids only ever matter to a custom scope; a stale key under another
  // scope starts empty rather than resurrecting an old selection.
  let customVaultIds: string[] = vaultScope === 'custom' ? loadCustomVaultIds() : [];
  /** The Web chip — remembered across sessions. */
  let web = loadWeb();
  /** Whether Settings offers anything for it; false until first read. */
  let webAvailable = false;
  /** The vault registry cache (drives the picker + selection sanitation). */
  let vaults: { id: string; name: string; active: boolean }[] = [];
  let streaming: StreamingTurn | null = null;
  let error: string | null = null;
  let notice: string | null = null;
  let actionMessage: string | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  /** Streaming deltas arrive per token — re-render at most every ~100 ms. */
  let lastStreamNotify = 0;
  const notifyThrottled = (): void => {
    const now = Date.now();
    if (now - lastStreamNotify >= 100) {
      lastStreamNotify = now;
      notify();
    }
  };

  ports.onDelta((event) => {
    if (streaming !== null && event.taskId === streaming.taskId) {
      streaming = { ...streaming, text: streaming.text + event.text };
      notifyThrottled();
    }
  });

  ports.onToolEvent((event) => {
    if (streaming === null || event.taskId !== streaming.taskId) {
      return;
    }
    streaming = { ...streaming, tools: applyToolProgress(streaming.tools, event) };
    notify();
  });

  /** Routes a rejection to the error line or the quiet notice line. */
  const report = (err: unknown): void => {
    if (isCancellation(err)) {
      notice = CANCELLED;
      error = null;
    } else {
      error = ipcErrorMessage(err);
      notice = null;
    }
  };

  const refreshChats = async (): Promise<void> => {
    try {
      chats = await ports.listChats();
      chatsLoaded = true;
      chatsError = false;
    } catch {
      // The picker keeps whatever it had; the error line stays reserved
      // for things the user can act on — the picker itself reports the
      // failure through `chatsFailed()` instead of reading as "no chats".
      chatsError = true;
    }
    notify();
  };

  const loadView = async (path: string): Promise<void> => {
    view = await ports.readChat(path);
  };

  return {
    notePath: () => activePath,
    chats: () => chats,
    chatsFailed: () => chatsError,
    activeChatPath: () => activeChat,
    view: () => view,
    asking: () => asking,
    streaming: () => streaming,
    error: () => error,
    notice: () => notice,
    actionMessage: () => actionMessage,
    dismiss: () => {
      error = null;
      notice = null;
      notify();
    },
    dismissActionMessage: () => {
      actionMessage = null;
      notify();
    },

    noteIncluded: () => activePath !== null && !noteExcluded.has(activePath),

    setNoteIncluded(on) {
      if (activePath === null) {
        return;
      }
      if (on) {
        noteExcluded.delete(activePath);
      } else {
        noteExcluded.add(activePath);
        // No note attached = no edit target; live edit cannot ride along.
        liveEdit = false;
      }
      notify();
    },

    liveEdit: () => liveEdit,

    toggleLiveEdit() {
      if (asking) {
        return;
      }
      if (activePath === null) {
        notice = 'Open a note to use live edit.';
        notify();
        return;
      }
      if (!isLiveEditablePath(activePath)) {
        notice = 'Live edit is not available for this document.';
        notify();
        return;
      }
      liveEdit = !liveEdit;
      // A live-edit ask needs its target: turning the chip on re-includes
      // the note; excluding the note turns live edit off.
      if (liveEdit) {
        noteExcluded.delete(activePath);
      }
      notify();
    },

    vaultScope: () => vaultScope,
    customVaultIds: () => customVaultIds,
    vaults: () => vaults,

    setVaultScope(scope, vaultIds) {
      vaultScope = scope;
      customVaultIds =
        scope === 'custom'
          ? [...new Set(vaultIds ?? customVaultIds)]
          : [];
      storeVaultScope(vaultScope, customVaultIds);
      notify();
    },

    async refreshVaults() {
      try {
        vaults = [...(await ports.listVaults())];
      } catch {
        return; // keep whatever we had; the picker re-tries on open
      }
      if (vaultScope === 'custom' && customVaultIds.length > 0) {
        const known = new Set(vaults.map((vault) => vault.id));
        const surviving = customVaultIds.filter((id) => known.has(id));
        if (surviving.length !== customVaultIds.length) {
          // Vaults were removed (rename keeps the id, remove+re-add mints
          // a new one): prune; an empty selection degrades to `off`
          // visibly rather than silently querying the active vault.
          customVaultIds = surviving;
          vaultScope = surviving.length > 0 ? 'custom' : 'off';
          storeVaultScope(vaultScope, customVaultIds);
        }
      }
      notify();
    },

    web: () => web,
    webAvailable: () => webAvailable,

    toggleWeb() {
      web = !web;
      storeWeb(web);
      notify();
    },

    async refreshWeb() {
      let next: boolean;
      try {
        next = await ports.externalTools();
      } catch {
        return; // keep whatever we had
      }
      if (next !== webAvailable) {
        webAvailable = next;
        notify();
      }
    },

    extraFiles: () => filesByNote.get(chipKey()) ?? [],

    addFile(path) {
      if (path === activePath) {
        // The note itself — @ or + found the open note: include it rather
        // than attaching it twice under two mechanisms.
        if (activePath !== null && noteExcluded.has(activePath)) {
          noteExcluded.delete(activePath);
          notify();
          return { ok: true };
        }
        return { ok: false, reason: 'This note is already attached.' };
      }
      const key = chipKey();
      const files = filesByNote.get(key) ?? [];
      if (files.includes(path)) {
        return { ok: false, reason: 'Already attached.' };
      }
      if (files.length >= MAX_EXTRA_FILES) {
        return { ok: false, reason: `At most ${MAX_EXTRA_FILES} files per question.` };
      }
      filesByNote.set(key, [...files, path]);
      notify();
      return { ok: true };
    },

    removeFile(path) {
      const files = filesByNote.get(chipKey());
      if (files !== undefined && files.includes(path)) {
        filesByNote.set(chipKey(), files.filter((entry) => entry !== path));
        notify();
      }
    },

    scratchFiles: () => scratchByNote.get(chipKey()) ?? [],

    addScratch(docPath) {
      if (docPath === activePath) {
        // The focused document IS this tab — the note chip already carries
        // its live buffer: re-include rather than attach twice.
        if (activePath !== null && noteExcluded.has(activePath)) {
          noteExcluded.delete(activePath);
          notify();
          return { ok: true };
        }
        return { ok: false, reason: 'This document is already attached.' };
      }
      const key = chipKey();
      const chips = scratchByNote.get(key) ?? [];
      if (chips.some((chip) => chip.docPath === docPath)) {
        return { ok: false, reason: 'Already attached.' };
      }
      // Files and scratch tabs share the per-question cap.
      const files = filesByNote.get(key) ?? [];
      if (files.length + chips.length >= MAX_EXTRA_FILES) {
        return { ok: false, reason: `At most ${MAX_EXTRA_FILES} files per question.` };
      }
      scratchByNote.set(key, [...chips, { docPath, snapshotPath: null }]);
      notify();
      return { ok: true };
    },

    removeScratch(docPath) {
      const chips = scratchByNote.get(chipKey());
      if (chips !== undefined && chips.some((chip) => chip.docPath === docPath)) {
        scratchByNote.set(
          chipKey(),
          chips.filter((chip) => chip.docPath !== docPath),
        );
        notify();
      }
    },

    images: () => imagesByKey.get(chipKey()) ?? [],

    addImage(path) {
      const key = chipKey();
      const images = imagesByKey.get(key) ?? [];
      if (images.includes(path)) {
        return { ok: false, reason: 'Already attached.' };
      }
      if (images.length >= MAX_IMAGES) {
        return { ok: false, reason: `At most ${MAX_IMAGES} images per question.` };
      }
      imagesByKey.set(key, [...images, path]);
      notify();
      return { ok: true };
    },

    removeImage(path) {
      const images = imagesByKey.get(chipKey());
      if (images !== undefined && images.includes(path)) {
        imagesByKey.set(chipKey(), images.filter((entry) => entry !== path));
        notify();
      }
    },

    async openNote(path) {
      activePath = path;
      notify();
    },

    closeNote() {
      if (activePath !== null) {
        activePath = null;
        notify();
      }
    },

    async followActiveDoc(noteKey) {
      if (asking) {
        // A running generation keeps its chat; remember the switch and
        // re-follow when the ask's finally releases `asking`.
        deferredFollowKey = noteKey;
        return;
      }
      const seq = ++followSeq;
      let candidates: ChatSummary[];
      try {
        candidates = await ports.listChats();
      } catch {
        chatsError = true;
        firstFollow = false;
        return; // the picker keeps whatever it had; nothing to follow against
      }
      if (seq !== followSeq || asking) {
        return; // superseded by a newer switch / a generation started meanwhile
      }
      chats = candidates;
      chatsLoaded = true;
      const activation = firstFollow;
      firstFollow = false;

      // The ONE implicit switch left (ADR-0048 later change): focusing a
      // chat note's own tab — or opening its Markdown from the vault —
      // hydrates the panel with THAT chat. The tab is the note's view,
      // the panel should agree with it.
      if (noteKey !== null) {
        const chatPath = docKeyPath(noteKey);
        if (chatPath !== null && isChatNotePath(chatPath)) {
          const focused = chats.find((chat) => chat.path === chatPath);
          if (focused !== undefined && focused.path !== activeChat) {
            await this.openChat(focused.path);
          }
          return;
        }
      }

      // Anything else — a daily note, a meeting, a topic note, a
      // non-document focus — keeps EXACTLY the current chat. The old
      // "a bound note opens its newest bound chat" rule is gone: with
      // several same-titled chats it silently yanked the panel to the
      // newest bound one (rarely the conversation the user was in), and
      // day/meeting switches flapped the panel. A chat changes now only
      // through the picker, "New chat", or a chat-note tab. Only the very
      // first follow (app start) continues the newest conversation
      // instead of showing an empty panel.
      if (activation && activeChat === null && chats.length > 0) {
        await this.openChat(chats[0].path);
      }
    },

    async openChat(path) {
      if (asking) {
        return;
      }
      error = null;
      notice = null;
      activeChat = path;
      notify();
      try {
        await loadView(path);
      } catch (err) {
        view = null;
        report(err);
      }
      notify();
    },

    newChat() {
      if (asking) {
        return;
      }
      activeChat = null;
      view = null;
      error = null;
      notice = null;
      notify();
    },

    async attachExternal() {
      // The reference decides where the staged copies land (its
      // attachments/ folder): the chat being built, else the open note.
      const reference = activeChat ?? activePath ?? 'chats/scratch.md';
      let landed = 0;
      try {
        const { staged, skipped } = await ports.attachExternal(reference);
        landed = staged.length;
        for (const item of staged) {
          if (item.kind === 'image') {
            this.addImage(item.path);
          } else {
            this.addFile(item.path);
          }
        }
        if (skipped.length > 0) {
          notice = `Skipped ${skipped.join(', ')} — not a text or image file.`;
        }
      } catch (err) {
        report(err);
      }
      notify();
      return landed;
    },

    async ask(question, options) {
      const text = question.trim();
      if (text === '' || asking) {
        return false;
      }
      if (!ports.llmEnabled()) {
        error = 'LLM features are disabled.';
        notify();
        return false;
      }
      const includeNote = activePath !== null && !noteExcluded.has(activePath);
      const attached = filesByNote.get(chipKey()) ?? [];
      const images = imagesByKey.get(chipKey()) ?? [];

      asking = true;
      error = null;
      notice = null;
      notify();
      try {
        // The focused document decides both context and binding: the note
        // chip rides with the live, unsaved buffer (the same "what you see
        // is what the model gets" rule as before chips), and the chat's
        // `note:` binding is the focused doc key — even when the chip is
        // off, the chat belongs to the workspace it was started in.
        const active = ports.activeDoc();
        // A focused chat-note tab must never become a chat's binding —
        // asking with a chat tab focused continues THAT chat (it is the
        // panel's active chat), and a fresh one stays unbound instead of
        // chaining chat → chat. The note chip still rides as context.
        // A daily note binds nothing either (57c decoupling): days flip
        // constantly — a conversation is not "about" a day the way it is
        // about a topic note, so chats started under daily focus stay
        // unbound (picker-reachable, never auto-opened).
        const dailyDir = await ports.dailyDir();
        const noteKey =
          active !== null &&
          active.vaultId !== null &&
          !isChatNotePath(active.path) &&
          !isDailyNotePath(active.path, dailyDir)
            ? `${active.vaultId}::${active.path}`
            : null;
        let note: AskRequest['note'] = null;
        if (includeNote) {
          if (active === null) {
            throw new Error('This note is not open.');
          }
          note = {
            path: active.path,
            body: active.body,
            ...(active.vaultId !== null ? { vaultId: active.vaultId } : {}),
          };
        }
        // Extra files are read at send time (open tabs as their live
        // buffer, the rest from disk); ones that vanished from the vault
        // are skipped with a quiet notice as long as context remains.
        const extraFiles: NonNullable<AskRequest['note']>[] = [];
        const missing: string[] = [];
        // Scratch tabs (the search summary) ride as their live buffer, and
        // every send re-snapshots the current text under `.drafts/` — that
        // vault path is what the turn cites and what later replays re-read,
        // so the context survives the tab being closed. A closed tab falls
        // back to its last snapshot.
        const unavailable: string[] = [];
        for (const chip of scratchByNote.get(chipKey()) ?? []) {
          const live = ports.scratchBody(chip.docPath);
          if (live !== null) {
            try {
              chip.snapshotPath = await ports.writeScratchSnapshot(chip.docPath, live);
              extraFiles.push({ path: chip.snapshotPath, body: truncateFileBody(live) });
              continue;
            } catch {
              // Snapshot failed — without a prior one there is nothing to send.
            }
          }
          if (chip.snapshotPath !== null) {
            const body = await ports.readVaultFile(chip.snapshotPath);
            if (body === null) {
              unavailable.push(chip.docPath);
            } else {
              extraFiles.push({ path: chip.snapshotPath, body: truncateFileBody(body) });
            }
          } else {
            unavailable.push(chip.docPath);
          }
        }
        for (const file of attached) {
          const body = await ports.readVaultFile(file);
          if (body === null) {
            missing.push(file);
          } else {
            extraFiles.push({ path: file, body: truncateFileBody(body) });
          }
        }
        if (missing.length > 0 || unavailable.length > 0) {
          if (note === null && extraFiles.length === 0 && images.length === 0) {
            throw new Error('The attached files are no longer in the vault.');
          }
          const notes: string[] = [];
          if (missing.length > 0) {
            notes.push(`Skipped ${missing.join(', ')} — no longer in the vault.`);
          }
          if (unavailable.length > 0) {
            notes.push(
              `Skipped ${unavailable.join(', ')} — tab not open and not sent before.`,
            );
          }
          notice = notes.join(' ');
        }

        const request: AskRequest = {
          question: text,
          note,
          extraFiles,
          images: [...images],
          chatPath: activeChat,
          // The flag alone is not enough: after a tab switch the attached
          // note could be a chats/ auto-save note — never a live target.
          liveEdit: liveEdit && note !== null && isLiveEditablePath(note.path),
          noteKey,
          vaultScope,
          vaultIds: [...customVaultIds],
          // Only what the chip shows: with nothing switched on in Settings
          // it is hidden, and a remembered "on" must not ride unseen.
          web: web && webAvailable,
          ...(options?.selection !== undefined && options.selection.trim() !== ''
            ? { selection: options.selection }
            : {}),
        };
        // While the model edits the document, the user cannot: the lock
        // covers the whole turn and releases on success, error AND cancel.
        const lockedPath = request.liveEdit ? (note?.path ?? null) : null;
        if (lockedPath !== null) {
          ports.setEditLock(lockedPath, true);
        }
        try {
          // The task id is minted inside `run` (Cancel must exist while the
          // call is outstanding); `streaming` is keyed by it so the delta
          // push lands on the right partial card.
          const { value: result } = await tasks.run('Thinking', (taskId) => {
            streaming = { taskId, text: '', tools: [] };
            notify();
            return ports.ask(request, taskId);
          });
          streaming = null;
          activeChat = result.chatPath;
          await loadView(result.chatPath);
          if (result.contextError !== undefined) {
            notice = `Vault context unavailable: ${result.contextError}`;
          }
          notify();

          if (result.outcome.kind === 'answer') {
            await refreshChats();
            return true;
          }
          // A live turn's changes are already in the tab (the vault tools
          // put each one there) and in the chat note (the applied edit
          // entry, persisted main-side) — nothing to confirm, only to
          // report (ADR-0049).
          if (result.outcome.kind === 'liveEdit') {
            notice =
              result.outcome.applied > 0
                ? `Applied ${result.outcome.applied} edit(s) to ${result.outcome.path}.`
                : 'No changes were needed.';
            await refreshChats();
            return true;
          }
          // The host's requestRewrite shows the shared dialog and applies the
          // rewrite itself when confirmed (ADR-0011, one flow). The outcome —
          // applied document or discarded marker — persists into the turn's
          // fence so the next replay knows what happened (bug-10(b)).
          const confirmed = await ports.requestRewrite({
            path: note !== null ? note.path : activePath ?? '',
            before: result.outcome.before,
            after: result.outcome.after,
            title: 'Apply change from the assistant',
            summary: result.outcome.summary,
            previewStyle: result.outcome.previewStyle,
            triggerId: null,
          });
          await ports.appendEdit(
            result.chatPath,
            confirmed,
            confirmed ? result.outcome.after : undefined,
          );
          await loadView(result.chatPath);
          notify();
          await refreshChats();
          return true;
        } finally {
          if (lockedPath !== null) {
            ports.setEditLock(lockedPath, false);
          }
        }
      } catch (err) {
        streaming = null;
        report(err);
        notify();
        return false;
      } finally {
        asking = false;
        const followKey = deferredFollowKey;
        deferredFollowKey = undefined;
        if (followKey !== undefined) {
          // Catch up on a doc switch that arrived mid-generation.
          void this.followActiveDoc(followKey);
        }
        notify();
      }
    },

    laterCount(turnIndex) {
      return view === null ? 0 : Math.max(0, view.turns.length - turnIndex);
    },

    async restartFrom(turnIndex) {
      if (activeChat === null || asking || tasks.isRunning()) {
        return null;
      }
      const removed = view?.turns[turnIndex] ?? null;
      error = null;
      notice = null;
      try {
        await ports.truncate(activeChat, turnIndex);
        await loadView(activeChat);
        notify();
        await refreshChats();
      } catch (err) {
        report(err);
        notify();
        return null;
      }
      return removed !== null && removed.role === 'user' ? removed.text : null;
    },

    reportActionOutcome(outcome) {
      if (outcome.kind === 'error' || outcome.kind === 'noop') {
        actionMessage = `${outcome.name}: ${outcome.message}`;
        notify();
      }
    },

    invalidateChats() {
      void refreshChats();
    },

    cancelRunning: () => tasks.cancel(),

    took: (durationMs) => (durationMs === undefined ? null : tasks.took(durationMs)),

    subscribe(listener) {
      listeners.add(listener);
      if (!chatsLoaded) {
        chatsLoaded = true; // only the first subscriber triggers the load
        void refreshChats();
        void this.refreshVaults();
      }
      return () => listeners.delete(listener);
    },
  };
}
