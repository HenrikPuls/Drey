import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { MessageKey, MessageParams } from '../../../../shared/i18n';
import type { SessionMeta } from '../api/dto';
import { historyGroupsOf } from '../chat/chat';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';

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

/**
 * The phone's root screen (req-96, canvas decision 17, board 10b): the menu.
 * No back button, no hamburger — it is the top of the phone's navigation.
 * A search field at the top narrows the chat list, then the places
 * Notes (hidden until req-101), Work with the "Needs you" count, Crew and
 * Settings, then the chats with Mission Control newest first by day with
 * New chat above them. Every row is 52 px or more.
 */
@Component({
  selector: 'mc-menu',
  imports: [McI18nPipe],
  templateUrl: './menu.html',
  styleUrl: './menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Menu {
  private readonly i18n = inject(McI18n);

  readonly notesEnabled = input(false);
  readonly needsCount = input(0);
  readonly sessions = input<readonly SessionMeta[]>([]);
  /** The chat session open in the pane; its row is marked. */
  readonly activeFile = input<string | null>(null);
  /** The clock, injectable for the specs; the component reads it once per render of the list. */
  readonly now = input<() => number>(() => Date.now());

  readonly place = output<MenuPlace>();
  readonly openChat = output<SessionMeta>();
  readonly newChat = output<void>();

  protected readonly query = signal('');

  protected readonly groups = computed(() => historyGroupsOf(this.sessions(), this.now()(), this.query()));

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected age(entry: SessionMeta): string {
    return ageLabelOf(entry.updatedAt, this.now()(), (key, params) => this.i18n.t(key, params));
  }
}
