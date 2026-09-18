import { Injectable, signal } from '@angular/core';

/** Request for a two-button confirmation (replaces the native `confirm()`). */
export interface ConfirmRequest {
  /** Optional heading; without one the message carries the whole text. */
  readonly title?: string;
  readonly message: string;
  /** Confirm button label (default "OK"). */
  readonly confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  readonly cancelLabel?: string;
  /** Styles the confirm button as destructive (a delete). */
  readonly danger?: boolean;
}

/** Request for an acknowledgement dialog (replaces the native `alert()`). */
export interface MessageRequest {
  readonly title?: string;
  readonly message: string;
}

/** One dialog's state plus the resolver its buttons answer through. */
interface DialogState {
  readonly title?: string;
  readonly message: string;
  readonly confirmLabel: string;
  /** Absent on a message dialog -- only "OK" shows. */
  readonly cancelLabel: string | null;
  readonly danger: boolean;
  resolve: (accepted: boolean) => void;
}

/**
 * The in-renderer replacement for the native `confirm()`/`alert()`:
 * Electron on Windows leaves the window without keyboard focus after one
 * is dismissed (electron#41602 -- no caret, typing dead, mouse alive,
 * an Alt+Tab round trip clears it), so every native dialog in the
 * renderer goes through this HTML dialog instead. The Exit prompt and
 * the Settings dirty bar set the same in-renderer pattern.
 *
 * One dialog shows at a time; later requests queue and are answered in
 * order, so sequential `await` chains (delete -> dirty-tab prompts)
 * behave exactly like their blocking ancestors -- minus the focus bug
 * and without freezing the renderer (streams keep running behind the
 * modal).
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  /** The dialog currently showing, if any (the component's `@if` gate). */
  readonly current = signal<DialogState | null>(null);

  private readonly queue: Array<{
    request: ConfirmRequest | MessageRequest;
    resolve: (accepted: boolean) => void;
  }> = [];

  /** Two-button dialog; resolves `true` on confirm, `false` on cancel/Escape/backdrop. */
  confirm(request: ConfirmRequest): Promise<boolean> {
    return this.show(request);
  }

  /** OK-only dialog; resolves once acknowledged. */
  async message(request: MessageRequest): Promise<void> {
    await this.show(request);
  }

  private show(request: ConfirmRequest | MessageRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue.push({ request, resolve });
      this.pump();
    });
  }

  /** Shows the next queued dialog; a no-op while one is up. */
  private pump(): void {
    if (this.current() !== null) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    const req = next.request;
    this.current.set({
      title: req.title,
      message: req.message,
      confirmLabel: ('confirmLabel' in req ? req.confirmLabel : undefined) ?? 'OK',
      cancelLabel: 'cancelLabel' in req ? (req.cancelLabel ?? 'Cancel') : null,
      danger: 'danger' in req && req.danger === true,
      resolve: next.resolve,
    });
  }

  /** The confirm (or OK) button. Resolves `true`, then shows the next queued dialog. */
  accept(): void {
    this.settle(true);
  }

  /** The cancel button, Escape or a backdrop click -- resolves `false` (or closes a message dialog). */
  cancel(): void {
    this.settle(false);
  }

  private settle(accepted: boolean): void {
    const dialog = this.current();
    if (!dialog) {
      return;
    }
    this.current.set(null);
    dialog.resolve(accepted);
    this.pump();
  }
}
