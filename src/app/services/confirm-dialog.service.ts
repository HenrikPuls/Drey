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

/**
 * Request for a three-way "save changes?" prompt: the confirm button is
 * "Save", plus a middle "Don't save" and a "Cancel" that aborts whatever the
 * user was doing.
 */
export interface DecideRequest {
  readonly title?: string;
  readonly message: string;
  /** Default "Save". */
  readonly saveLabel?: string;
  /** Default "Don't save". */
  readonly discardLabel?: string;
  /** Default "Cancel". */
  readonly cancelLabel?: string;
}

/** The answer to a {@link DecideRequest}. */
export type SaveDecision = 'save' | 'discard' | 'cancel';

/** Request for an acknowledgement dialog (replaces the native `alert()`). */
export interface MessageRequest {
  readonly title?: string;
  readonly message: string;
}

/** Which button answered a dialog. */
type DialogChoice = 'accept' | 'discard' | 'cancel';

/** One dialog's state plus the resolver its buttons answer through. */
interface DialogState {
  readonly title?: string;
  readonly message: string;
  readonly confirmLabel: string;
  /** Absent on a message dialog -- only "OK" shows. */
  readonly cancelLabel: string | null;
  /** Present only on a three-way dialog: the middle "Don't save" button. */
  readonly discardLabel: string | null;
  readonly danger: boolean;
  resolve: (choice: DialogChoice) => void;
}

type AnyRequest = ConfirmRequest | MessageRequest | (DecideRequest & { readonly kind: 'decide' });

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
    request: AnyRequest;
    resolve: (choice: DialogChoice) => void;
  }> = [];

  /** Two-button dialog; resolves `true` on confirm, `false` on cancel/Escape/backdrop. */
  async confirm(request: ConfirmRequest): Promise<boolean> {
    return (await this.show(request)) === 'accept';
  }

  /**
   * Three-way "save changes?" dialog; Escape / backdrop count as "cancel",
   * so an accidental dismissal never discards or writes anything.
   */
  async decide(request: DecideRequest): Promise<SaveDecision> {
    const choice = await this.show({ ...request, kind: 'decide' });
    return choice === 'accept' ? 'save' : choice;
  }

  /** OK-only dialog; resolves once acknowledged. */
  async message(request: MessageRequest): Promise<void> {
    await this.show(request);
  }

  private show(request: AnyRequest): Promise<DialogChoice> {
    return new Promise<DialogChoice>((resolve) => {
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
    if ('kind' in req) {
      this.current.set({
        title: req.title,
        message: req.message,
        confirmLabel: req.saveLabel ?? 'Save',
        cancelLabel: req.cancelLabel ?? 'Cancel',
        discardLabel: req.discardLabel ?? "Don't save",
        danger: false,
        resolve: next.resolve,
      });
      return;
    }
    this.current.set({
      title: req.title,
      message: req.message,
      confirmLabel: ('confirmLabel' in req ? req.confirmLabel : undefined) ?? 'OK',
      cancelLabel: 'cancelLabel' in req ? (req.cancelLabel ?? 'Cancel') : null,
      discardLabel: null,
      danger: 'danger' in req && req.danger === true,
      resolve: next.resolve,
    });
  }

  /** The confirm (or OK, or Save) button. Resolves it, then shows the next queued dialog. */
  accept(): void {
    this.settle('accept');
  }

  /** The three-way dialog's "Don't save" button. */
  discard(): void {
    this.settle('discard');
  }

  /** The cancel button, Escape or a backdrop click -- resolves `false` (or closes a message dialog). */
  cancel(): void {
    this.settle('cancel');
  }

  private settle(choice: DialogChoice): void {
    const dialog = this.current();
    if (!dialog) {
      return;
    }
    this.current.set(null);
    dialog.resolve(choice);
    this.pump();
  }
}
