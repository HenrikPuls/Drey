/**
 * The assistant panel's state — a plain-JS factory with its ports
 * injected, so the unit spec can drive it without a DOM (ADR-0044: plugin
 * logic stays framework-free; the DOM layer is `panel.ts`).
 *
 * Since ADR-0048 the conversation lives in a chat note under `chats/`
 * (the note IS the source of truth; the main-side engine persists every
 * turn and replays the full history). The renderer holds only *session*
 * state: which chat is active, the context chips (the open note — on by
 * default — extra files, images), a streaming buffer, and the per-note
 * auto-summary sidecar logic (ADR-0012, unchanged — summaries never
 * became conversations).
 *
 * The auto-summary switch is deliberately *session state*, not config: it
 * is seeded from `assistant.autoSummaryDefault` when a note is first
 * opened and overrides it for that note only. Auto-summary fires once per
 * note per session and only when there is no sidecar thread yet, so
 * re-opening a note never re-bills an LLM call for a summary that already
 * exists.
 */
import type { ActionOutcome } from '../../../shared/plugin-api';
import type { AskRequest, AssistantOutcome } from '../shared/ask';
import { MAX_EXTRA_FILES, MAX_IMAGES, truncateFileBody } from '../shared/ask.js';
import type { ChatCard, ChatThread } from '../shared/chat-thread';
import { emptyThread, hasSummary } from '../shared/chat-thread.js';
import type { ChatNoteView, ChatSummary } from '../shared/chat-note';
import { formatDateTime, ipcErrorMessage } from '../shared/format.js';
import { type RunningTasks } from './running-tasks.js';
import { uid } from './running-tasks.js';

/** The text a cancelled generation reports. */
const CANCELLED = 'Generation cancelled.';

/** Whether a rejection is "the user pressed Cancel" (not a fault). */
function isCancellation(error: unknown): boolean {
  return /abort/i.test(ipcErrorMessage(error)) || ipcErrorMessage(error) === CANCELLED;
}

/** Everything the state needs from the host API; injected for testability. */
export interface AssistantPorts {
  // -- chat notes (ADR-0048) ----------------------------------------------
  listChats(): Promise<ChatSummary[]>;
  readChat(path: string): Promise<ChatNoteView>;
  ask(request: AskRequest, taskId?: string): Promise<{ chatPath: string; outcome: AssistantOutcome }>;
  /** Persists the confirm outcome into the last assistant turn's fence. */
  appendEdit(path: string, applied: boolean, after?: string): Promise<void>;
  /** Drops every turn from `turnIndex` on (restart-from-here). */
  truncate(path: string, turnIndex: number): Promise<void>;
  /** One-shot sidecar import; returns the created chat note's path. */
  importSidecar(notePath: string): Promise<{ chatPath: string }>;
  /**
   * Native file dialog for files NOT yet in the vault; each pick is staged
   * into the vault (chat attachments convention) and returned as chip
   * paths. `skipped` names files that are neither text nor image.
   */
  attachExternal(referenceNote: string): Promise<{
    staged: { path: string; kind: 'file' | 'image' }[];
    skipped: string[];
  }>;
  /** Streamed answer text for a task this state started (`chat:delta`). */
  onDelta(listener: (event: { taskId: string; text: string }) => void): () => void;

  // -- summary sidecar (ADR-0012, unchanged) -------------------------------
  readThread(notePath: string): Promise<ChatThread>;
  writeThread(thread: ChatThread): Promise<void>;
  summarize(context: { path: string; body: string }, taskId?: string): Promise<string>;

  // -- shared --------------------------------------------------------------
  /**
   * A file's text for attachment: the live buffer when the file is open,
   * else its vault content; `null` when it is gone from the vault.
   */
  readVaultFile(path: string): Promise<string | null>;
  cancel(taskId?: string): Promise<void>;
  /** The active document's path + buffer, or null. */
  activeDoc(): { path: string; body: string } | null;
  /** LLM master switch (live). */
  llmEnabled(): boolean;
  /** Settings -> Assistant default. */
  autoSummaryDefault(): boolean;
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
}

/**
 * Live edit only ever targets a user note: never the app-owned auto-save
 * paths (`chats/`, `.drafts/`). Local copy — plugin renderers cannot
 * runtime-import the app's `shared/` (same reason as `format.ts`).
 */
function isLiveEditablePath(path: string): boolean {
  return (
    path !== 'chats' &&
    !path.startsWith('chats/') &&
    path !== '.drafts' &&
    !path.startsWith('.drafts/')
  );
}

export interface AssistantState {
  /** The active note's path (null = no text document open). */
  notePath(): string | null;
  /** The picker list (most recently updated chat first). */
  chats(): readonly ChatSummary[];
  /** The active chat's path, or null when the next ask starts a NEW chat. */
  activeChatPath(): string | null;
  /** The active chat's parsed note; null when none is loaded. */
  view(): ChatNoteView | null;
  /** The pinned auto-summary card of the active note, if any. */
  summaryCard(): ChatCard | null;
  /** True when the open note's sidecar has conversation cards to import. */
  canImportSidecar(): boolean;
  /** Effective state of the panel's switch for the active note. */
  autoSummary(): boolean;
  /** True when a manual "Summarise now" makes sense (no summary card yet). */
  canSummarize(): boolean;
  summarizing(): boolean;
  asking(): boolean;
  /** The in-flight generation's streamed text, when one is running. */
  streaming(): { taskId: string; text: string } | null;
  /** Something went wrong — shown in the accent colour. */
  error(): string | null;
  /** A cancellation or other non-fault — shown quiet. */
  notice(): string | null;
  /** A manual Action's noop/error message (was the editor meta-bar line). */
  actionMessage(): string | null;
  /** Clears the error/notice lines. */
  dismiss(): void;
  dismissActionMessage(): void;
  /** The panel switch. Applies to this note only; the default is untouched. */
  setAutoSummary(on: boolean): void;
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
  extraFiles(): readonly string[];
  /** Adds a file chip; resolves to a reason string when refused. */
  addFile(path: string): { ok: boolean; reason?: string };
  removeFile(path: string): void;
  images(): readonly string[];
  /** Adds an image chip (a vault-relative path); reason string when refused. */
  addImage(path: string): { ok: boolean; reason?: string };
  removeImage(path: string): void;
  /** Runs the openNote rule: load the summary sidecar, then maybe auto-summarise. */
  openNote(path: string): Promise<void>;
  /** Nothing text-shaped is active (a browser tab, or no pane). */
  closeNote(): void;
  /** Loads a chat into the panel (the picker's click). */
  openChat(path: string): Promise<void>;
  /** Next ask starts a new chat note. */
  newChat(): void;
  summarizeNow(): Promise<void>;
  /** One-shot, non-destructive sidecar import for the open note. */
  importSidecar(): Promise<void>;
  /** Native dialog; stages external files into the vault and adds chips. Returns how many landed. */
  attachExternal(): Promise<number>;
  /** Sends a question; resolves false when it was not sent (so the composer can keep the text). */
  ask(question: string): Promise<boolean>;
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

  /** The active NOTE (for chips + auto-summary) — independent of the chat. */
  let activePath: string | null = null;
  /** Per-note summary sidecars, loaded on open. */
  const threads = new Map<string, ChatThread>();
  const toggles = new Map<string, boolean>();
  const attempted = new Set<string>();

  /** Chips are keyed by the note path (or '' when no note is open). */
  const chipKey = (): string => activePath ?? '';
  const noteExcluded = new Set<string>();
  const filesByNote = new Map<string, string[]>();
  const imagesByKey = new Map<string, string[]>();

  let summarizing = false;
  let asking = false;
  /** Live edit (ADR-0049) — session flag, one toggle in the chips row. */
  let liveEdit = false;
  let streaming: { taskId: string; text: string } | null = null;
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
      streaming = { taskId: streaming.taskId, text: streaming.text + event.text };
      notifyThrottled();
    }
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
    } catch {
      // The picker keeps whatever it had; the error line stays reserved
      // for things the user can act on.
    }
    notify();
  };

  const loadView = async (path: string): Promise<void> => {
    view = await ports.readChat(path);
  };

  const appendCard = async (
    path: string,
    role: ChatCard['role'],
    text: string,
    durationMs?: number,
  ): Promise<void> => {
    const current = threads.get(path) ?? emptyThread(path);
    const next: ChatThread = {
      ...current,
      notePath: path,
      cards: [
        ...current.cards,
        {
          id: uid(),
          role,
          text,
          at: formatDateTime(new Date()),
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      ],
    };
    threads.set(path, next);
    notify();
    try {
      await ports.writeThread(next);
    } catch (err) {
      // The thread stays in memory for this session; only persistence failed.
      error = ipcErrorMessage(err);
      notify();
    }
  };

  const runSummary = async (path: string): Promise<void> => {
    if (summarizing) {
      return;
    }
    summarizing = true;
    error = null;
    notice = null;
    notify();
    try {
      const doc = ports.activeDoc();
      if (doc === null || doc.path !== path) {
        throw new Error('This note is not open.');
      }
      const { value: text, durationMs } = await tasks.run('Summarising', (taskId) =>
        ports.summarize({ path, body: doc.body }, taskId),
      );
      await appendCard(path, 'summary', text, durationMs);
    } catch (err) {
      report(err);
      notify();
    } finally {
      summarizing = false;
      notify();
    }
  };

  /**
   * The spec's rule: a note opened for the first time, with no sidecar
   * thread yet and the switch on, gets its summary generated automatically.
   * Everything else does nothing.
   */
  const maybeAutoSummarize = async (path: string): Promise<void> => {
    if (attempted.has(path) || !autoSummary() || !ports.llmEnabled()) {
      return;
    }
    const thread = threads.get(path);
    if (!thread || thread.cards.length > 0) {
      return;
    }
    attempted.add(path);
    await runSummary(path);
  };

  const autoSummary = (): boolean => {
    const override = activePath === null ? undefined : toggles.get(activePath);
    return override ?? ports.autoSummaryDefault();
  };

  return {
    notePath: () => activePath,
    chats: () => chats,
    activeChatPath: () => activeChat,
    view: () => view,
    summaryCard: () => {
      if (activePath === null) {
        return null;
      }
      const cards = (threads.get(activePath) ?? emptyThread(activePath)).cards;
      return [...cards].reverse().find((card) => card.role === 'summary') ?? null;
    },
    canImportSidecar: () => {
      if (activePath === null) {
        return false;
      }
      const cards = (threads.get(activePath) ?? emptyThread(activePath)).cards;
      return cards.some((card) => card.role === 'question' || card.role === 'answer');
    },

    autoSummary,
    canSummarize: () => activePath !== null && ports.llmEnabled() && !hasSummary(assistantThread()),
    summarizing: () => summarizing,
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

    setAutoSummary(on) {
      if (activePath === null) {
        return;
      }
      toggles.set(activePath, on);
      notify();
      if (on) {
        // Turning it on after the fact is the same ask as opening the note
        // with it on -- summarise now if nothing has been written yet.
        void maybeAutoSummarize(activePath);
      }
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
      if (!threads.has(path)) {
        let thread = emptyThread(path);
        try {
          thread = await ports.readThread(path);
        } catch {
          error = 'Could not read the assistant thread for this note.';
        }
        // Another load may have finished first; keep whichever is there.
        if (!threads.has(path)) {
          threads.set(path, thread);
        }
        notify();
      }
      await maybeAutoSummarize(path);
    },

    closeNote() {
      if (activePath !== null) {
        activePath = null;
        notify();
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

    async summarizeNow() {
      if (activePath === null) {
        return;
      }
      attempted.add(activePath);
      await runSummary(activePath);
    },

    async importSidecar() {
      if (activePath === null || asking) {
        return;
      }
      try {
        const { chatPath } = await ports.importSidecar(activePath);
        activeChat = chatPath;
        notify();
        await loadView(chatPath);
        await refreshChats();
      } catch (err) {
        report(err);
        notify();
      }
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

    async ask(question) {
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
        // The note chip rides with the live, unsaved buffer — the same
        // "what you see is what the model gets" rule as before chips.
        let note: AskRequest['note'] = null;
        if (includeNote) {
          const doc = ports.activeDoc();
          if (doc === null) {
            throw new Error('This note is not open.');
          }
          note = { path: doc.path, body: doc.body };
        }
        // Extra files are read at send time (open tabs as their live
        // buffer, the rest from disk); ones that vanished from the vault
        // are skipped with a quiet notice as long as context remains.
        const extraFiles: NonNullable<AskRequest['note']>[] = [];
        const missing: string[] = [];
        for (const file of attached) {
          const body = await ports.readVaultFile(file);
          if (body === null) {
            missing.push(file);
          } else {
            extraFiles.push({ path: file, body: truncateFileBody(body) });
          }
        }
        if (missing.length > 0) {
          if (note === null && extraFiles.length === 0 && images.length === 0) {
            throw new Error('The attached files are no longer in the vault.');
          }
          notice = `Skipped ${missing.join(', ')} — no longer in the vault.`;
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
            streaming = { taskId, text: '' };
            notify();
            return ports.ask(request, taskId);
          });
          streaming = null;
          activeChat = result.chatPath;
          await loadView(result.chatPath);
          notify();

          if (result.outcome.kind === 'answer') {
            await refreshChats();
            return true;
          }
          // A live turn's changes are already in the tab (pushed per tool
          // call) and in the chat note (the applied edit entry, persisted
          // main-side) — nothing to confirm, only to report (ADR-0049).
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
        notify();
      }
    },

    laterCount(turnIndex) {
      return view === null ? 0 : Math.max(0, view.turns.length - turnIndex);
    },

    async restartFrom(turnIndex) {
      if (activeChat === null || asking || summarizing || tasks.isRunning()) {
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
      }
      return () => listeners.delete(listener);
    },
  };

  /** The active note's thread ('' path when nothing is open). */
  function assistantThread(): ChatThread {
    return activePath === null ? emptyThread('') : (threads.get(activePath) ?? emptyThread(activePath));
  }
}
