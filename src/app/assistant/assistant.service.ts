import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ActionContext, ChatCard, ChatThread } from '../../../shared/ipc-api';
import { emptyThread, hasSummary, historyForAsk } from '../../../shared/chat-thread';
import { ipcErrorMessage } from '../../../shared/ipc-error';
import { formatDateTime } from '../../../shared/timestamp';
import { ConfirmationService } from '../llm';
import { EditorService } from '../services/editor.service';
import { LlmTaskService } from '../llm';
import { SettingsService } from '../services/settings.service';

/** The text a cancelled generation reports. */
const CANCELLED = 'Generation cancelled.';

/**
 * Whether a rejection is "the user pressed Cancel". The abort surfaces as a
 * DOMException whose message ("The operation was aborted") would otherwise
 * be shown as a fault.
 */
function isCancellation(error: unknown): boolean {
  return /abort/i.test(ipcErrorMessage(error)) || ipcErrorMessage(error) === CANCELLED;
}

/** `crypto.randomUUID` in the app; a cheap fallback for test contexts. */
function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The note assistant panel's state: one chat thread per note, persisted as
 * a sidecar file (`shared/chat-thread.ts`), plus the per-note
 * "Automatic summary" switch.
 *
 * The switch is deliberately *session state*, not config: it is seeded from
 * `assistant.autoSummaryDefault` when a note is first opened and overrides
 * it for that note only. Writing it back would turn a one-off "not for this
 * note" into a silent change of the global rule -- the spec is explicit
 * that only Settings changes the default.
 *
 * Auto-summary fires once per note per session and only when there is no
 * sidecar thread yet, so re-opening a note never re-bills an LLM call for
 * a summary that already exists.
 */
@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly llmTasks = inject(LlmTaskService);

  /** Loaded threads by note path. */
  private readonly threads = signal<Record<string, ChatThread>>({});
  /** Per-note override of the auto-summary default. */
  private readonly toggles = signal<Record<string, boolean>>({});
  /** Notes whose auto-summary attempt already happened this session. */
  private readonly attempted = new Set<string>();

  readonly summarizing = signal(false);
  readonly asking = signal(false);
  /** Something went wrong -- shown in the accent colour. */
  readonly error = signal<string | null>(null);
  /**
   * Something happened that is not a fault (the user cancelled) -- shown in
   * the same quiet grey as the timestamps, because it is a statement about
   * what they just did, not a problem to act on.
   */
  readonly notice = signal<string | null>(null);

  /** `Summarising · thinking 12s` while a generation runs, else null. */
  readonly runningLabel = this.llmTasks.currentLabel;
  readonly isRunning = this.llmTasks.isRunning;

  /** Cancels whatever generation this panel started. */
  async cancel(): Promise<void> {
    await this.llmTasks.cancel();
  }

  /** Clears whichever message is showing. */
  dismiss(): void {
    this.error.set(null);
    this.notice.set(null);
  }

  /**
   * The card's "insert into note" arrow: drops the card text into the
   * document editor at the caret (replacing any selection). The user saves
   * it like any other edit -- nothing is written here.
   */
  insertIntoNote(text: string): void {
    this.editor.requestInsertText(text);
  }

  /** Routes a rejection to the error line or the quiet notice line. */
  private report(err: unknown): void {
    if (isCancellation(err)) {
      this.notice.set(CANCELLED);
      this.error.set(null);
    } else {
      this.error.set(ipcErrorMessage(err));
      this.notice.set(null);
    }
  }

  /** `took 8s` for a finished card, or null when it cost no generation. */
  took(durationMs: number | undefined): string | null {
    return durationMs === undefined ? null : this.llmTasks.took(durationMs);
  }

  readonly notePath = computed<string | null>(() => this.editor.openPath());

  readonly thread = computed<ChatThread>(() => {
    const path = this.notePath();
    return path === null ? emptyThread('') : (this.threads()[path] ?? emptyThread(path));
  });

  readonly cards = computed<readonly ChatCard[]>(() => this.thread().cards);

  /** Effective state of the panel's switch for the active note. */
  readonly autoSummary = computed<boolean>(() => {
    const path = this.notePath();
    const override = path === null ? undefined : this.toggles()[path];
    return override ?? this.settings.config()?.assistant.autoSummaryDefault ?? false;
  });

  /** Whether the LLM master switch allows summaries / questions at all. */
  readonly llmEnabled = computed<boolean>(() => this.settings.llmEnabled());

  /** True when a manual "Summarise now" makes sense (no summary card yet). */
  readonly canSummarize = computed<boolean>(
    () => this.notePath() !== null && this.llmEnabled() && !hasSummary(this.thread()),
  );

  constructor() {
    // Load (and possibly auto-summarise) whenever the active tab changes.
    effect(() => {
      const path = this.editor.openPath();
      if (path !== null) {
        void this.openNote(path);
      }
    });
  }

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** The panel switch. Applies to this note only; the default is untouched. */
  setAutoSummary(on: boolean): void {
    const path = this.notePath();
    if (path === null) {
      return;
    }
    this.toggles.update((map) => ({ ...map, [path]: on }));
    if (on) {
      // Turning it on after the fact is the same ask as opening the note
      // with it on -- summarise now if nothing has been written yet.
      void this.maybeAutoSummarize(path);
    }
  }

  /** How many cards a "restart from here" at `cardId` would drop. */
  laterCount(cardId: string): number {
    const cards = this.cards();
    const index = cards.findIndex((card) => card.id === cardId);
    return index === -1 ? 0 : cards.length - index;
  }

  /**
   * Rewinds the thread to just before `cardId`: that card and every card
   * after it is dropped and the sidecar is rewritten. Returns the removed
   * card's text when it was a question, so the panel can drop it back into
   * the composer to edit and re-send; null otherwise.
   */
  async restartFrom(cardId: string): Promise<string | null> {
    const path = this.notePath();
    if (path === null || this.asking() || this.summarizing() || this.isRunning()) {
      return null;
    }
    const current = this.threads()[path];
    if (!current) {
      return null;
    }
    const index = current.cards.findIndex((card) => card.id === cardId);
    if (index === -1) {
      return null;
    }
    const removed = current.cards[index];
    const next: ChatThread = { ...current, cards: current.cards.slice(0, index) };
    this.threads.update((map) => ({ ...map, [path]: next }));
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.api?.writeChatThread?.(next);
    } catch (err) {
      this.error.set(ipcErrorMessage(err));
    }
    return removed.role === 'question' ? removed.text : null;
  }

  /** The panel's manual "Summarise now" button. */
  async summarizeNow(): Promise<void> {
    const path = this.notePath();
    if (path !== null) {
      this.attempted.add(path);
      await this.runSummary(path);
    }
  }

  /**
   * The panel composer: sends `question` plus the document to the LLM,
   * records the question and the answer as cards. A document-modifying
   * reply goes through the shared confirmation flow (ADR-0011) and is
   * recorded as an answer describing what was applied.
   */
  async ask(question: string): Promise<boolean> {
    const text = question.trim();
    const path = this.notePath();
    if (text === '' || path === null || !this.api || this.asking()) {
      return false;
    }

    this.asking.set(true);
    this.error.set(null);
    this.notice.set(null);
    // Snapshot the thread as chat turns *before* the new question is added
    // as a card, so the model gets the running conversation as context
    // rather than re-answering from the document alone.
    const history = historyForAsk(this.threads()[path] ?? emptyThread(path));
    await this.appendCard(path, 'question', text);
    try {
      const context: ActionContext = { path, body: this.editor.bufferContent() };
      const { value: outcome, durationMs } = await this.llmTasks.run('Thinking', (taskId) =>
        this.api!.askChat(context, text, taskId, history),
      );
      if (outcome.kind === 'answer') {
        await this.appendCard(path, 'answer', outcome.text, durationMs);
        return true;
      }
      const confirmed = await this.confirmation.request({
        title: 'Apply change from the assistant',
        summary: outcome.summary,
        previewStyle: outcome.previewStyle,
        before: outcome.before,
        after: outcome.after,
        triggerId: null,
      });
      if (confirmed) {
        await this.editor.applyRewrite(path, outcome.after);
      }
      await this.appendCard(path, 'answer', confirmed ? 'Change applied.' : 'Change discarded.');
      return true;
    } catch (err) {
      this.error.set(ipcErrorMessage(err));
      return false;
    } finally {
      this.asking.set(false);
    }
  }

  /** Loads the sidecar thread for `path` and runs the auto-summary rule. */
  private async openNote(path: string): Promise<void> {
    if (!(path in this.threads())) {
      let thread = emptyThread(path);
      try {
        // Feature-detected, not assumed: a renderer talking to an older
        // preload (the `npm run dev` staleness trap, docs/11) has no
        // `readChatThread`, and an unhandled rejection here would fire on
        // every tab switch. An empty thread is the correct fallback anyway.
        thread = (await this.api?.readChatThread?.(path)) ?? thread;
      } catch {
        this.error.set('Could not read the assistant thread for this note.');
      }
      // Another load may have finished first; keep whichever is there.
      if (!(path in this.threads())) {
        this.threads.update((map) => ({ ...map, [path]: thread }));
      }
    }
    await this.maybeAutoSummarize(path);
  }

  /**
   * The spec's rule: a note opened for the first time, with no sidecar
   * thread yet and the switch on, gets its summary generated automatically.
   * Everything else does nothing.
   */
  private async maybeAutoSummarize(path: string): Promise<void> {
    if (this.attempted.has(path) || !this.autoSummary() || !this.llmEnabled()) {
      return;
    }
    const thread = this.threads()[path];
    if (!thread || thread.cards.length > 0) {
      return;
    }
    this.attempted.add(path);
    await this.runSummary(path);
  }

  private async runSummary(path: string): Promise<void> {
    if (!this.api || this.summarizing()) {
      return;
    }
    this.summarizing.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const body = this.editor.bufferContent();
      const { value: text, durationMs } = await this.llmTasks.run('Summarising', (taskId) =>
        this.api!.summarizeNote?.({ path, body }, taskId),
      );
      if (typeof text !== 'string') {
        throw new Error('The summary service is unavailable (restart the app after an update).');
      }
      await this.appendCard(path, 'summary', text, durationMs);
    } catch (err) {
      this.report(err);
    } finally {
      this.summarizing.set(false);
    }
  }

  /** Adds a card to the note's thread and writes the sidecar. */
  private async appendCard(
    path: string,
    role: ChatCard['role'],
    text: string,
    durationMs?: number,
  ): Promise<void> {
    const current = this.threads()[path] ?? emptyThread(path);
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
    this.threads.update((map) => ({ ...map, [path]: next }));
    try {
      await this.api?.writeChatThread?.(next);
    } catch (err) {
      // The thread stays in memory for this session; only persistence failed.
      this.error.set(ipcErrorMessage(err));
    }
  }
}
