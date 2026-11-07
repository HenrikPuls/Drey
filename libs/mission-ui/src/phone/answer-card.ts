import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { McI18nPipe } from '../i18n/i18n.pipe';

/** One choice of the answer card. */
export interface AnswerOption {
  readonly label: string;
  /** What the option concretely does; null = the question names none. */
  readonly consequence: string | null;
  readonly recommended: boolean;
}

/**
 * The phone's answer card (boards 10a, 10d, 10j): the question, big touch
 * targets, and a tap only marks. Nothing is sent until the Send button under
 * the options fires, which names the marked choice.
 */
@Component({
  selector: 'mc-answer-card',
  imports: [McI18nPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './answer-card.css',
  templateUrl: './answer-card.html',
})
export class AnswerCard {
  readonly question = input.required<string>();
  /** The line under the question that says why it is asked; null = none. */
  readonly why = input<string | null>(null);
  readonly options = input.required<readonly AnswerOption[]>();
  /** The marked option's index; null = none yet (the Send button waits). */
  readonly selected = input<number | null>(null);
  readonly busy = input(false);
  readonly error = input<string | null>(null);

  readonly pick = output<number>();
  readonly send = output<void>();

  protected readonly marked = computed(() => {
    const at = this.selected();
    return at === null ? null : (this.options()[at]?.label ?? null);
  });
}
