import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { autopilotToneOf } from '../../../../shared/autopilot';
import { McI18n } from '../i18n/i18n.service';
import { MC_AUTOPILOT } from './autopilot-state';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { AutopilotPanel } from './panel';
import { PhoneIcon, type PhoneIconName } from '../phone/icon';

/**
 * The phone's Autopilot control (req-95b, board 10t): a 44 px icon naming the
 * state, with its dot, in the app bar of Work, Crew and Mission Control chat;
 * a tap opens a bottom sheet of three rows (On / Paused / Off, each with its
 * sentence) with "Stop all running steps now…" below. Hidden while the desk reports no
 * chain; from 768 px the iPad chip and the desktop status item take over.
 */
@Component({
  selector: 'mc-autopilot-button',
  imports: [AutopilotPanel, McI18nPipe, PhoneIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './button.html',
  styleUrl: './button.css',
})
export class AutopilotButton {
  private readonly state = inject(MC_AUTOPILOT);
  private readonly i18n = inject(McI18n);

  protected readonly open = signal(false);
  protected readonly view = computed(() => this.state?.autopilot() ?? null);
  protected readonly tone = computed(() => autopilotToneOf(this.view()?.state ?? 'off'));
  /** The bar's glyph names the state (board 10t): play, two bars, a rounded square. */
  protected readonly glyph = computed<PhoneIconName>(() => {
    const state = this.view()?.state ?? 'off';
    return state === 'on' ? 'play' : state === 'paused' ? 'pause' : 'stop';
  });
  protected readonly label = computed(() =>
    this.i18n.t('autopilot.aria', { state: this.i18n.t(`autopilot.state.${this.view()?.state ?? 'off'}`) }),
  );

  @HostListener('keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
  }
}
