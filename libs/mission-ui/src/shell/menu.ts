import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { SessionMeta } from '../api/dto';
import { historyGroupsOf } from '../chat/chat';

/** The places the phone menu leads to (canvas decision 17). */
export type MenuPlace = 'notes' | 'work' | 'crew' | 'settings';

/** The age label of a chat row: minutes, hours or days since its last update. */
export function ageLabelOf(updatedAt: string, nowMs: number): string {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) {
    return '';
  }
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h`;
  }
  return `${Math.round(hours / 24)} d`;
}

/**
 * The phone's root screen (req-96, canvas decision 17, board 10b): the menu.
 * No back button, no hamburger — it is the top of the phone's navigation.
 * A search field at the top narrows the chat list, then the places
 * Notes (hidden until req-101), Work with the "Needs you" count, Crew and
 * Settings, then the chats with Mission Control newest first by day with
 * New chat above them. Every row is 52 px or more.
 */
// TODO(i18n): every label in menu.html and ageLabelOf's units are catalog keys once req-102 is merged.
@Component({
  selector: 'mc-menu',
  templateUrl: './menu.html',
  styleUrl: './menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Menu {
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
    return ageLabelOf(entry.updatedAt, this.now()());
  }
}
