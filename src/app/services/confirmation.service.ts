import { Injectable, inject, signal } from '@angular/core';
import { ActionResultKind } from '../../../shared/app-config';
import { SettingsService } from './settings.service';

/**
 * One change awaiting the user's yes/no, for the shared confirmation
 * dialog. `previewStyle` picks the view: `'localized'` -> inline line diff
 * of the affected lines; `'document'` -> side-by-side before/after
 * (`docs/09_architecture_decisions/0011-unified-confirmation-flow.md`).
 */
export interface ConfirmationRequest {
  title: string;
  /** Sub-line under the title, e.g. "Add tags: #foo, #bar". */
  summary?: string;
  previewStyle: ActionResultKind;
  before: string;
  after: string;
  /**
   * The Action trigger this change came from. The dialog's "don't ask
   * again for this action" checkbox flips that trigger's `confirm` toggle
   * in Settings -- one piece of state, reachable from both places. `null`
   * for an ad-hoc change (a chat Ask edit), which hides the checkbox.
   */
  triggerId: string | null;
}

/**
 * The single confirmation mechanism shared by the Actions system and chat
 * Ask-mode edits (ADR-0011) -- one dialog, one "don't ask again" path, no
 * parallel implementations. `request()` shows the dialog and resolves to
 * the user's choice; callers `await` it and apply the change (or not).
 * Requests are handled one at a time: a caller with several (the on-save
 * queue) just awaits them in a loop.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmationService {
  private readonly settings = inject(SettingsService);

  private readonly _pending = signal<ConfirmationRequest | null>(null);
  readonly pending = this._pending.asReadonly();

  private resolver: ((confirmed: boolean) => void) | null = null;

  request(req: ConfirmationRequest): Promise<boolean> {
    // An earlier unresolved request should never be silently dropped.
    this.resolver?.(false);
    this._pending.set(req);
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Accept. `dontAskAgain` (only offered for trigger-bound changes) disables that trigger's confirm. */
  confirm(dontAskAgain = false): void {
    const req = this._pending();
    if (dontAskAgain && req?.triggerId) {
      // Persisted immediately -- this is not part of a Settings editing
      // session, and the next run of that action must already skip the prompt.
      void this.settings.setTriggerConfirmImmediate(req.triggerId, false);
    }
    this.settle(true);
  }

  cancel(): void {
    this.settle(false);
  }

  private settle(confirmed: boolean): void {
    this._pending.set(null);
    const resolve = this.resolver;
    this.resolver = null;
    resolve?.(confirmed);
  }
}
