import { Injectable, computed, inject, signal } from '@angular/core';
import { ExitConfirmRequest, ExitDecision } from '../../../shared/ipc-api';
import { SessionService } from '../session';
import { EditorService } from './editor.service';
import { LogService } from './log.service';

/**
 * The renderer side of the save-before-exit prompt (bug-5), started once
 * from `App` next to `McpBridgeService`.
 *
 * Main intercepts every window close, pushes an `exit:confirm-request`, and
 * waits (no timeout -- see `ExitBridge`) for this service's decision:
 * - **No dirty text documents** -> the request is answered `'discard'`
 *   (proceed) immediately, without showing anything. A clean exit costs one
 *   IPC round trip and zero UI.
 * - **Dirty documents** -> the exit dialog shows ("Save all" / "Exit
 *   without saving" / "Cancel").
 *   - *Save all* runs `saveAll({ drafts: true, runOnSaveActions: false })`:
 *     real files write straight through; untitled scratch tabs commit into
 *     the vault's hidden `.drafts/` folder as `unnamed-N.md` (the
 *     Notepad++ model -- never a Save-As dialog on exit; a later explicit
 *     "Save as…" away from `.drafts/` moves the file out). On-save Actions
 *     are suppressed: an LLM round trip must not block shutdown. If
 *     anything is *still* dirty afterwards (a failed write, a concurrent
 *     save swallowing the window), the answer is `'cancel'` and the app
 *     stays open with the error visible.
 *   - *Exit without saving* flushes the session backups first (ADR-0043
 *     already keeps the buffers restorable) and answers `'discard'`.
 *   - *Cancel* answers `'cancel'`; nothing changes.
 */
@Injectable({ providedIn: 'root' })
export class ExitConfirmService {
  private readonly editor = inject(EditorService);
  private readonly session = inject(SessionService);
  private readonly log = inject(LogService);

  private readonly _pending = signal<number | null>(null);
  /** The `ExitConfirmRequest.id` whose dialog is showing, if any. */
  readonly pending = this._pending.asReadonly();

  /** True while "Save all" is running -- the button disables, cancel is ignored. */
  readonly busy = signal(false);

  /** Text documents whose buffer differs from what's on disk. */
  private readonly dirtyDocs = computed(
    () =>
      this.editor
        .openDocs()
        .filter((d) => d.kind === 'text' && d.bufferContent !== d.savedContent),
  );

  /** How many documents the exit prompt would talk about (0 -> no dialog). */
  readonly dirtyCount = computed(() => this.dirtyDocs().length);

  private started = false;

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** Idempotent; called once from `App`'s constructor. */
  start(): void {
    if (this.started || typeof window === 'undefined') {
      return;
    }
    this.started = true;
    this.api?.onExitConfirmRequest?.((request) => this.handle(request));
  }

  private handle(request: ExitConfirmRequest): void {
    if (this._pending() !== null) {
      // A second close request while the dialog is up; main ignores those
      // too -- this is just belt and braces.
      void this.api?.resolveExitConfirm(request.id, 'cancel');
      return;
    }
    if (this.dirtyDocs().length === 0) {
      void this.api?.resolveExitConfirm(request.id, 'discard');
      return;
    }
    this.log.record('info', `exit prompt: ${this.dirtyDocs().length} dirty document(s)`);
    this._pending.set(request.id);
  }


  /** The dialog's buttons. Resolves the pending request and closes it. */
  async choose(decision: Exclude<ExitDecision, 'cancel'> | 'cancel'): Promise<void> {
    const id = this._pending();
    if (id === null || this.busy()) {
      return;
    }
    if (decision === 'cancel') {
      this._pending.set(null);
      await this.api?.resolveExitConfirm(id, 'cancel');
      return;
    }
    if (decision === 'save') {
      this.busy.set(true);
      try {
        await this.editor.saveAll({ runOnSaveActions: false, drafts: true });
        const remaining = this.dirtyDocs().length;
        if (remaining > 0) {
          // A save failed (see editor.error) -- keep the app open rather
          // than exit with the user's text uncommitted.
          this.log.record('warn', `exit save all left ${remaining} document(s) dirty`);
          this._pending.set(null);
          await this.api?.resolveExitConfirm(id, 'cancel');
          return;
        }
      } finally {
        this.busy.set(false);
      }
    }
    this._pending.set(null);
    await this.session.flushNow();
    await this.api?.resolveExitConfirm(id, decision);
  }

  /** Escape-key / backdrop affordance -- same as the Cancel button. */
  cancel(): void {
    void this.choose('cancel');
  }
}
