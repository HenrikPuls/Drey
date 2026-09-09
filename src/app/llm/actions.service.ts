import { Injectable, effect, inject, signal } from '@angular/core';
import { ActionContext, ActionOutcome } from '../../../shared/ipc-api';
import { ConfirmationService } from './confirmation.service';
import { EditorService } from '../services/editor.service';

/**
 * Orchestrates running an Action: call `runAction` in the main process,
 * route an `'edit'` outcome through the shared confirmation flow
 * (ADR-0011), and -- on confirm -- apply the rewrite to the open document.
 *
 * Also drains `EditorService.pendingActions` (the `'edit'` outcomes an
 * `on-save` trigger produced) through the exact same path, via an effect
 * so `EditorService` doesn't have to depend on this service.
 *
 * Component-free logic per CLAUDE.md; the editor's run menu and `App` only
 * call `run()` / read `busy` / `message`.
 */
@Injectable({ providedIn: 'root' })
export class ActionsService {
  private readonly editor = inject(EditorService);
  private readonly confirmation = inject(ConfirmationService);

  /** Trigger id currently running, or null. */
  readonly busy = signal<string | null>(null);
  /** Last non-edit result to surface (a `'noop'` reason or an error). */
  readonly message = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.editor.pendingActions().length > 0) {
        void this.drainPending();
      }
    });
  }

  /** Run a manual action against `context` (the active document + selection). */
  async run(triggerId: string, context: ActionContext): Promise<void> {
    const api = typeof window !== 'undefined' ? window.dreyApi : undefined;
    if (!api || this.busy()) {
      return;
    }
    this.busy.set(triggerId);
    this.message.set(null);
    try {
      const outcome = await api.runAction(triggerId, context);
      await this.handleOutcome(outcome);
    } catch (err) {
      this.message.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }

  private async drainPending(): Promise<void> {
    for (const outcome of this.editor.consumePendingActions()) {
      await this.handleOutcome(outcome);
    }
  }

  private async handleOutcome(outcome: ActionOutcome): Promise<void> {
    if (outcome.kind === 'error') {
      this.message.set(`${outcome.name}: ${outcome.message}`);
      return;
    }
    if (outcome.kind === 'noop') {
      this.message.set(`${outcome.name}: ${outcome.message}`);
      return;
    }
    const confirmed = await this.confirmation.request({
      title: outcome.name,
      summary: outcome.summary,
      previewStyle: outcome.previewStyle,
      before: outcome.before,
      after: outcome.after,
      triggerId: outcome.triggerId,
    });
    if (confirmed) {
      await this.editor.applyRewrite(outcome.path, outcome.after);
    }
  }
}
