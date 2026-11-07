import { Injectable, signal, type Signal } from '@angular/core';
import type { AnswerOption } from '../phone/answer-card';

/**
 * The card of the open ticket in the iPad's Assistant (boards 10e, 10q, 5b, 5c;
 * Q9 of the row's measure sheet): the surface that owns the decision publishes
 * it, with the very calls the phone's card makes; the chat only draws it.
 */
export interface PadCard {
  readonly question: string;
  readonly why: string | null;
  readonly options: readonly AnswerOption[];
  readonly selected: Signal<number | null>;
  readonly busy: Signal<boolean>;
  readonly error: Signal<string | null>;
  /** The line that replaces the card once it is decided; null while open. */
  readonly done: Signal<string | null>;
  /** The selected option asks for a note (Send back): the card shows the field. */
  readonly noteOpen?: Signal<boolean>;
  readonly note?: Signal<string>;
  readonly noteLabel?: string;
  setNote?(text: string): void;
  pick(index: number): void;
  send(): void;
}

@Injectable({ providedIn: 'root' })
export class PadCards {
  readonly card = signal<PadCard | null>(null);
}
