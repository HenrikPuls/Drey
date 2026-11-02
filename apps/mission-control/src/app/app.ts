import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { Work } from './work/work';
import { Chat } from './chat/chat';
import { Team } from './team/team';

export type McTab = 'work' | 'chat' | 'team';

/**
 * The phone-first shell (concept §7): one column, the tab bar at the
 * bottom — Work left, Chat middle (raised: the regular intervention),
 * Team right. Tablet/Desktop widen the same views instead of replacing
 * them (E5b ships the phone layout; the two/three-column stage lands
 * with the ticket screen).
 */
@Component({
  selector: 'mc-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [Work, Chat, Team],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly tab = signal<McTab>('work');
}
