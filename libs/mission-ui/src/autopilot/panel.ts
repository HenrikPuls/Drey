import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import {
  AUTOPILOT_KINDS,
  autopilotRefusalCodeOf,
  autopilotRefusalKeyOf,
  autopilotToneOf,
  resumeAtOfTime,
  timeFieldOfResume,
  type AutopilotKind,
  type AutopilotView,
} from '../../../../shared/autopilot';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { MC_AUTOPILOT, type McAutopilotReply } from './autopilot-state';

/**
 * The three Autopilot states as rows (On / Paused / Off), the resume time
 * under Paused and "Stop all running steps now…" below (canvas board 10t).
 * The iPad chip shows it as a popover, the phone as a sheet (56 px rows
 * there). A read-only device sees the state and every control is disabled;
 * a refused write says why in words from the catalog, never a code.
 */
@Component({
  selector: 'mc-autopilot-panel',
  imports: [McI18nPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './panel.html',
  styleUrl: './panel.css',
})
export class AutopilotPanel {
  private readonly state = inject(MC_AUTOPILOT);
  private readonly i18n = inject(McI18n);

  /** The clock, injectable for the specs. */
  readonly now = input<() => Date>(() => new Date());
  /** A state was taken (On or Off): the host closes its popover or sheet. */
  readonly done = output<void>();

  protected readonly kinds = AUTOPILOT_KINDS;
  protected readonly view = computed(() => this.state?.autopilot() ?? null);
  protected readonly disabled = computed(() => this.state === null || this.state.readOnly());
  protected readonly error = signal<string | null>(null);
  protected readonly armed = signal(false);
  protected readonly resumeValue = computed(() => timeFieldOfResume(this.view()?.resumeAt));
  protected readonly resumeText = computed((): string | null => {
    const at = this.view()?.resumeAt;
    return at === undefined
      ? null
      : this.i18n.t('autopilot.resume_at', { time: this.i18n.formatTime(new Date(at)) });
  });

  protected tone(kind: AutopilotKind): string {
    return autopilotToneOf(kind);
  }

  protected async pick(kind: AutopilotKind): Promise<void> {
    if (this.view()?.state === kind) {
      return;
    }
    const taken = await this.send({ state: kind });
    if (taken && kind !== 'paused') {
      this.done.emit();
    }
  }

  protected async onTime(event: Event): Promise<void> {
    const at = resumeAtOfTime((event.target as HTMLInputElement).value, this.now()());
    if (at === null) {
      return;
    }
    await this.send({ state: 'paused', resumeAt: at });
  }

  protected async stop(): Promise<void> {
    if (!this.armed()) {
      this.armed.set(true);
      return;
    }
    this.armed.set(false);
    this.error.set(null);
    const reply = await this.state?.stopAll();
    if (reply !== undefined && !reply.ok) {
      this.error.set(this.wordsOf(reply));
      return;
    }
    this.done.emit();
  }

  private async send(record: AutopilotView): Promise<boolean> {
    if (this.state === null) {
      return false;
    }
    this.error.set(null);
    const reply = await this.state.set(record);
    if (!reply.ok) {
      this.error.set(this.wordsOf(reply));
    }
    return reply.ok;
  }

  private wordsOf(reply: Extract<McAutopilotReply, { ok: false }>): string {
    return this.i18n.t(autopilotRefusalKeyOf(reply.code ?? autopilotRefusalCodeOf(reply)));
  }
}
