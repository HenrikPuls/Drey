import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { MessageKey, MessageParams } from '../../../../shared/i18n';
import type { SessionMeta } from '../api/dto';
import { historyGroupsOf } from '../chat/chat';
import { MC_AUTOPILOT } from '../autopilot/autopilot-state';
import { autopilotToneOf } from '../../../../shared/autopilot';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { AppBar } from '../app-bar/app-bar';
import { PhoneIcon } from '../phone/icon';
import { shortDayOf } from '../phone/phone';

/** The places the phone menu leads to (canvas decision 17). */
export type MenuPlace = 'notes' | 'work' | 'crew' | 'settings';

/** The age label of a chat row: minutes, hours or days since its last update. */
export function ageLabelOf(
  updatedAt: string,
  nowMs: number,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) {
    return '';
  }
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (minutes < 60) {
    return t('menu.age.minutes', { n: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t('menu.age.hours', { n: hours });
  }
  return t('menu.age.days', { n: Math.round(hours / 24) });
}

/** A chat row's time (board 10b): `14:02` today, `Mon` within the week, else the short date. */
export function chatTimeOf(
  updatedAt: string,
  nowMs: number,
  i18n: McI18n,
): string {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) {
    return '';
  }
  const date = new Date(then);
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(nowMs) - day(then)) / 86_400_000);
  if (days <= 0) {
    return i18n.formatTime(date);
  }
  return shortDayOf(date, days, i18n);
}

/**
 * The phone's root screen (req-96, canvas decision 17, board 10b): the menu.
 * No back button, no hamburger — it is the top of the phone's navigation.
 * A search field narrows the chat list; then the places Autopilot (with its
 * state, the row opens Settings where the switch is), Notes, Work with the
 * "Needs you" dot and count, Crew with what is stuck and Settings; then the
 * chats with Mission Control newest first by day.
 */
@Component({
  selector: 'mc-menu',
  imports: [McI18nPipe, AppBar, PhoneIcon],
  templateUrl: './menu.html',
  styleUrls: ['../phone/kit.css', './menu.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Menu {
  private readonly i18n = inject(McI18n);
  private readonly autopilotState = inject(MC_AUTOPILOT);

  readonly notesEnabled = input(false);
  readonly needsCount = input(0);
  /** Runs the watchdog flagged: the Crew row's right side. */
  readonly stuckCount = input(0);
  readonly sessions = input<readonly SessionMeta[]>([]);
  /** The chat session open in the pane; its row is marked. */
  readonly activeFile = input<string | null>(null);
  /** The clock, injectable for the specs; the component reads it once per render of the list. */
  readonly now = input<() => number>(() => Date.now());

  readonly place = output<MenuPlace>();
  readonly openChat = output<SessionMeta>();
  readonly newChat = output<void>();

  protected readonly query = signal('');

  /** The Autopilot row (req-95b): the state in words and its dot; null hides the row. */
  protected readonly autopilot = computed(() => {
    const view = this.autopilotState?.autopilot() ?? null;
    if (view === null) {
      return null;
    }
    const state = this.i18n.t(`autopilot.state.${view.state}`);
    return { state, label: this.i18n.t('autopilot.aria', { state }), tone: autopilotToneOf(view.state) };
  });

  protected readonly groups = computed(() => historyGroupsOf(this.sessions(), this.now()(), this.query()));

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** A chat row's time: the clock today, the weekday this week, else the short date. */
  protected age(entry: SessionMeta): string {
    return chatTimeOf(entry.updatedAt, this.now()(), this.i18n);
  }

  protected groupLabel(label: string): string {
    return this.i18n.t(`menu.group.${label.toLowerCase() as 'today' | 'yesterday' | 'earlier'}`);
  }
}
