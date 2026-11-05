import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Markdown } from '../markdown/markdown';
import type { MdMode } from '../markdown/mode';
import { TicketEditMode, TicketModeSwitch } from './mode-switch';
import { MC_TICKET } from './ticket.model';

// ---------------------------------------------------------------------------
// Pure view logic (spec'd in edit.spec.ts)
// ---------------------------------------------------------------------------

/**
 * Dirty tracking: any byte of difference between the text the editor was
 * seeded with and the current draft counts — a raw file is parsed
 * byte-for-byte, so a trailing-newline slip is a real change.
 */
export function isDirtyOf(initial: string, current: string): boolean {
  return initial !== current;
}

/**
 * The save gate (concept §5.5): saving is offered only when the draft both
 * differs from the loaded file and still holds content — an empty file is
 * not a ticket and the desk would refuse it anyway.
 */
export function canSaveOf(initial: string, current: string): boolean {
  return isDirtyOf(initial, current) && current.trim() !== '';
}

/**
 * The discard-arm reducer — the same armed pattern as the view's accept:
 * the first tap arms the plain inline 'Discard changes?' question, the
 * second tap confirms. Any edit resets to idle; confirming disarms too
 * (the editor closes behind it).
 */
export type DiscardArm = 'idle' | 'armed';

export type DiscardArmAction = 'tap' | 'reset';

export interface DiscardArmResult {
  readonly state: DiscardArm;
  readonly confirmed: boolean;
}

export function discardArmOf(state: DiscardArm, action: DiscardArmAction): DiscardArmResult {
  if (action === 'reset') {
    return { state: 'idle', confirmed: false };
  }
  return state === 'idle'
    ? { state: 'armed', confirmed: false }
    : { state: 'idle', confirmed: true };
}

// ---------------------------------------------------------------------------
// The raw edit mode (concept §5.5)
// ---------------------------------------------------------------------------

/**
 * The exception path over the ticket screen: a full-height raw editor the
 * machine file can be changed through when the chat is not the way. The
 * warning banner leads, the monospace textarea holds the full file text
 * and grows to the viewport, the footer actions sit in the thumb's reach.
 * Cancel discards (asking only when the draft is dirty), Save lands one
 * commit on the desk, a refused save surfaces the vm's error with a
 * Reload that re-fetches, and success returns to view mode where the vm's
 * saved flash shows the dim 'Saved — one commit on the desk' line.
 */
@Component({
  selector: 'mc-ticket-edit',
  templateUrl: './edit.html',
  styleUrl: './edit.css',
  imports: [Markdown, TicketModeSwitch],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketEdit {
  protected readonly vm = inject(MC_TICKET);
  protected readonly editMode = inject(TicketEditMode);

  /** The typed draft; null until the owner types — the textarea then seeds from the vm's doc. */
  private readonly draft = signal<string | null>(null);
  private readonly discardArm = signal<DiscardArm>('idle');
  private readonly saveError = signal<string | null>(null);
  private readonly busy = signal(false);

  protected readonly initial = computed(() => this.vm.doc()?.text ?? '');
  protected readonly text = computed(() => this.draft() ?? this.initial());
  protected readonly dirty = computed(() => isDirtyOf(this.initial(), this.text()));
  protected readonly armed = computed(() => this.discardArm() === 'armed');
  protected readonly canSave = computed(
    () => canSaveOf(this.initial(), this.text()) && !this.busy(),
  );

  /** A fresh edit session starts clean, unarmed and error-free whenever the mode opens. */
  private readonly resetOnOpen = effect(() => {
    if (this.vm.editing()) {
      this.draft.set(null);
      this.discardArm.set('idle');
      this.saveError.set(null);
    }
  });

  protected onText(value: string): void {
    this.draft.set(value);
    this.discardArm.set('idle');
  }

  /**
   * The header switch while editing: Live and Source change the editor's mode in
   * place; View leaves editing — Cancel's meaning, so unsaved text asks first (E13-23).
   */
  protected onModePick(mode: MdMode): void {
    if (mode === 'view') {
      this.onCancel();
    } else {
      this.editMode.mode.set(mode);
    }
  }

  protected onCancel(): void {
    if (!this.dirty()) {
      this.vm.exitEdit();
      return;
    }
    const result = discardArmOf(this.discardArm(), 'tap');
    this.discardArm.set(result.state);
    if (result.confirmed) {
      this.vm.exitEdit();
    }
  }

  protected async onSave(): Promise<void> {
    if (!this.canSave()) {
      return;
    }
    this.busy.set(true);
    this.saveError.set(null);
    try {
      const reply = await this.vm.save(this.text());
      if (!reply.ok) {
        this.saveError.set(reply.error);
        return;
      }
      this.vm.flashSaved();
      this.vm.exitEdit();
    } catch {
      this.saveError.set('Something went wrong — try again.');
    } finally {
      this.busy.set(false);
    }
  }

  /** The conflict Reload: re-fetch the ticket, then reseed the editor from the fresh doc. */
  protected async onReload(): Promise<void> {
    this.busy.set(true);
    try {
      await this.vm.reload();
      this.draft.set(null);
      this.discardArm.set('idle');
      this.saveError.set(null);
    } finally {
      this.busy.set(false);
    }
  }
}
