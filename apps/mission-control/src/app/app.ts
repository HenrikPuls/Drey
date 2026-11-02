import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { McState, type McTab } from './api/state';
import { Work } from './work/work';
import { Chat } from './chat/chat';
import { Team } from './team/team';
import { PersonaDetail } from './team/detail';
import { TicketView } from './ticket/view';
import { TicketEdit } from './ticket/edit';

export type { McTab };

/**
 * The phone-first shell (concept §7): one column, the tab bar at the
 * bottom — Work left, Chat middle (raised: the regular intervention),
 * Team right. The visible tab lives on McState (not here) so any surface
 * can switch to the chat — the report card's promote does. The ticket
 * screen is the destination every card points to: it renders as a
 * full-height overlay above the tabs.
 */
@Component({
  selector: 'mc-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [Work, Chat, Team, PersonaDetail, TicketView, TicketEdit],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly state = inject(McState);
  /** The shell's visible tab — McState owns it; the tabbar writes it. */
  protected readonly tab = this.state.tab;
  /** The ticket overlay renders while a ticket is open. */
  protected readonly ticketOpen = this.state.ticketOpen;
}
