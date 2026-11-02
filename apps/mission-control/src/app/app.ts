import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { McState } from './api/state';
import { Work } from './work/work';
import { Chat } from './chat/chat';
import { Team } from './team/team';
import { TicketView } from './ticket/view';
import { TicketEdit } from './ticket/edit';

export type McTab = 'work' | 'chat' | 'team';

/**
 * The phone-first shell (concept §7): one column, the tab bar at the
 * bottom — Work left, Chat middle (raised: the regular intervention),
 * Team right. The ticket screen is the destination every card points
 * to: it renders as a full-height overlay above the tabs.
 */
@Component({
  selector: 'mc-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [Work, Chat, Team, TicketView, TicketEdit],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly state = inject(McState);
  protected readonly tab = signal<McTab>('work');
  /** The ticket overlay renders while a ticket is open. */
  protected readonly ticketOpen = this.state.ticketOpen;
}
