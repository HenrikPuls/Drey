import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { autopilotToneOf } from '../../../../shared/autopilot';
import { McI18n } from '../i18n/i18n.service';
import { MC_AUTOPILOT } from './autopilot-state';
import { AutopilotPanel } from './panel';

/**
 * The iPad header's Autopilot chip (req-95b, board 10t): a 44 px chip
 * "● Autopilot · On" in the shell header's `[autopilot]` slot; a tap opens
 * the popover with the three states, the resume time and Stop-now. Hidden
 * while the desk reports no chain.
 */
@Component({
  selector: 'mc-autopilot-chip',
  imports: [AutopilotPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chip.html',
  styleUrl: './chip.css',
})
export class AutopilotChip {
  private readonly state = inject(MC_AUTOPILOT);
  private readonly i18n = inject(McI18n);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly open = signal(false);
  protected readonly view = computed(() => this.state?.autopilot() ?? null);
  protected readonly tone = computed(() => autopilotToneOf(this.view()?.state ?? 'off'));
  protected readonly title = computed(() => this.i18n.t('autopilot.title'));
  private readonly stateWord = computed(() => this.i18n.t(`autopilot.state.${this.view()?.state ?? 'off'}`));
  protected readonly word = this.stateWord;
  protected readonly text = computed(() => this.i18n.t('status.autopilot', { state: this.stateWord() }));
  protected readonly label = computed(() => this.i18n.t('autopilot.aria', { state: this.stateWord() }));

  @HostListener('document:pointerdown', ['$event'])
  protected onOutside(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  @HostListener('keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
  }
}
