/**
 * The assistant panel's state — the pre-conversion `AssistantService`
 * (`src/app/assistant/assistant.service.ts`) as a plain-JS factory with its
 * ports injected, so the unit spec can drive it without a DOM (ADR-0044:
 * plugin logic stays framework-free; the DOM layer is `panel.ts`).
 *
 * One chat thread per note, persisted as a sidecar file
 * (`shared/chat-thread.ts`), plus the per-note "Automatic summary" switch.
 *
 * The switch is deliberately *session state*, not config: it is seeded from
 * `assistant.autoSummaryDefault` when a note is first opened and overrides
 * it for that note only. Writing it back would turn a one-off "not for this
 * note" into a silent change of the global rule.
 *
 * Auto-summary fires once per note per session and only when there is no
 * sidecar thread yet, so re-opening a note never re-bills an LLM call for
 * a summary that already exists.
 */
import type { ActionOutcome } from '../../../shared/plugin-api';
import type { ChatCard, ChatThread } from '../shared/chat-thread';
import { emptyThread, hasSummary, historyForAsk } from '../shared/chat-thread.js';
import { formatDateTime, ipcErrorMessage } from '../shared/format.js';
import { uid, type RunningTasks } from './running-tasks.js';

/** The text a cancelled generation reports. */
const CANCELLED = 'Generation cancelled.';

/** Whether a rejection is "the user pressed Cancel" (not a fault). */
function isCancellation(error: unknown): boolean {
  return /abort/i.test(ipcErrorMessage(error)) || ipcErrorMessage(error) === CANCELLED;
}

/** Everything the state needs from the host API; injected for testability. */
export interface AssistantPorts {
  readThread(notePath: string): Promise<ChatThread>;
  writeThread(thread: ChatThread): Promise<void>;
  summarize(context: { path: string; body: string }, taskId?: string): Promise<string>;
  ask(
    context: { path: string; body: string },
    question: string,
    taskId?: string,
    history?: ReturnType<typeof historyForAsk>,
  ): Promise<{ kind: 'answer'; text: string } | { kind: 'edit'; before: string; after: string; previewStyle: 'localized' | 'document'; summary: string }>;
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
}

export interface AssistantState {
  /** The active note's path (null = no text document open). */
  notePath(): string | null;
  cards(): readonly ChatCard[];
  thread(): ChatThread;
  /** Effective state of the panel's switch for the active note. */
  autoSummary(): boolean;
  /** True when a manual "Summarise now" makes sense (no summary card yet). */
  canSummarize(): boolean;
  summarizing(): boolean;
  asking(): boolean;
  /** Something went wrong — shown in the accent colour. */
  error(): string | null;
  /** A cancellation or other non-fault — shown quiet. */
  notice(): string | null;
  /** A manual Action's noop/error message (was the editor meta-bar line). */
  actionMessage(): string | null;
  /** Clears the error/notice lines (the old `dismiss()`). */
  dismiss(): void;
  dismissActionMessage(): void;
  /** The panel switch. Applies to this note only; the default is untouched. */
  setAutoSummary(on: boolean): void;
  /** Runs the openNote rule: load the sidecar, then maybe auto-summarise. */
  openNote(path: string): Promise<void>;
  /** Nothing text-shaped is active (a browser tab, or no pane). */
  closeNote(): void;
  summarizeNow(): Promise<void>;
  /** Sends a question; resolves false when it was not sent (so the composer can keep the text). */
  ask(question: string): Promise<boolean>;
  /** How many cards a "restart from here" at `cardId` would drop. */
  laterCount(cardId: string): number;
  /** Rewinds to just before `cardId`; returns a removed question's text for the composer. */
  restartFrom(cardId: string): Promise<string | null>;
  /** An Action run reported a noop/error — the panel shows it. */
  reportActionOutcome(outcome: ActionOutcome): void;
  cancelRunning(): Promise<void>;
  took(durationMs: number | undefined): string | null;
  /** Re-renders subscribe here. */
  subscribe(listener: () => void): () => void;
}

export function createAssistantState(ports: AssistantPorts, tasks: RunningTasks): AssistantState {
  /** Loaded threads by note path. */
  const threads = new Map<string, ChatThread>();
  /** Per-note override of the auto-summary default. */
  const toggles = new Map<string, boolean>();
  /** Notes whose auto-summary attempt already happened this session. */
  const attempted = new Set<string>();

  let activePath: string | null = null;
  let summarizing = false;
  let asking = false;
  let error: string | null = null;
  let notice: string | null = null;
  let actionMessage: string | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

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
    cards: () => (activePath === null ? [] : (threads.get(activePath) ?? emptyThread('')).cards),
    thread: () => (activePath === null ? emptyThread('') : (threads.get(activePath) ?? emptyThread(activePath))),

    autoSummary,
    canSummarize: () => activePath !== null && ports.llmEnabled() && !hasSummary(assistantThread()),
    summarizing: () => summarizing,
    asking: () => asking,
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

    async summarizeNow() {
      if (activePath === null) {
        return;
      }
      attempted.add(activePath);
      await runSummary(activePath);
    },

    async ask(question) {
      const text = question.trim();
      const path = activePath;
      if (text === '' || path === null || asking) {
        return false;
      }
      asking = true;
      error = null;
      notice = null;
      notify();
      // Snapshot the thread as chat turns *before* the new question is added
      // as a card, so the model gets the running conversation as context
      // rather than re-answering from the document alone.
      const history = historyForAsk(threads.get(path) ?? emptyThread(path));
      await appendCard(path, 'question', text);
      try {
        const doc = ports.activeDoc();
        if (doc === null || doc.path !== path) {
          throw new Error('This note is not open.');
        }
        const { value: outcome, durationMs } = await tasks.run('Thinking', (taskId) =>
          ports.ask({ path, body: doc.body }, text, taskId, history),
        );
        if (outcome.kind === 'answer') {
          await appendCard(path, 'answer', outcome.text, durationMs);
          return true;
        }
        // The host's requestRewrite shows the shared dialog and applies the
        // rewrite itself when confirmed (ADR-0011, one flow).
        const confirmed = await ports.requestRewrite({
          path,
          before: outcome.before,
          after: outcome.after,
          title: 'Apply change from the assistant',
          summary: outcome.summary,
          previewStyle: outcome.previewStyle,
          triggerId: null,
        });
        await appendCard(path, 'answer', confirmed ? 'Change applied.' : 'Change discarded.');
        return true;
      } catch (err) {
        error = ipcErrorMessage(err);
        notify();
        return false;
      } finally {
        asking = false;
        notify();
      }
    },

    laterCount(cardId) {
      const cards = assistantThread().cards;
      const index = cards.findIndex((card) => card.id === cardId);
      return index === -1 ? 0 : cards.length - index;
    },

    async restartFrom(cardId) {
      const path = activePath;
      if (path === null || asking || summarizing || tasks.isRunning()) {
        return null;
      }
      const current = threads.get(path);
      if (!current) {
        return null;
      }
      const index = current.cards.findIndex((card) => card.id === cardId);
      if (index === -1) {
        return null;
      }
      const removed = current.cards[index];
      const next: ChatThread = { ...current, cards: current.cards.slice(0, index) };
      threads.set(path, next);
      error = null;
      notice = null;
      notify();
      try {
        await ports.writeThread(next);
      } catch (err) {
        error = ipcErrorMessage(err);
        notify();
      }
      return removed.role === 'question' ? removed.text : null;
    },

    reportActionOutcome(outcome) {
      if (outcome.kind === 'error' || outcome.kind === 'noop') {
        actionMessage = `${outcome.name}: ${outcome.message}`;
        notify();
      }
    },

    cancelRunning: () => tasks.cancel(),

    took: (durationMs) => (durationMs === undefined ? null : tasks.took(durationMs)),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  /** The active note's thread ('' path when nothing is open). */
  function assistantThread(): ChatThread {
    return activePath === null ? emptyThread('') : (threads.get(activePath) ?? emptyThread(activePath));
  }
}
