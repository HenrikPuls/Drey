import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { McState, type McTab } from './api/state';
import { Empty } from '@mission-ui/empty';
import { Toast } from '@mission-ui/toast';
import { Pairing } from '@mission-ui/pairing/pairing';
import { Work } from '@mission-ui/work/work';
import { Chat } from '@mission-ui/chat/chat';
import { Capacity } from '@mission-ui/capacity/capacity';
import { Settings } from '@mission-ui/settings/settings';
import { Team } from '@mission-ui/team/team';
import { PersonaDetail } from '@mission-ui/team/detail';
import { TicketView } from '@mission-ui/ticket/view';
import { TicketEdit } from '@mission-ui/ticket/edit';
import { PlanPane } from '@mission-ui/plan/plan-pane';
import { PlanApprove } from '@mission-ui/plan/approve';

export type { McTab };

/** What the right dock shows (E12-2): the chat, or the capacity. */
export type DockTab = 'chat' | 'capacity';

/** A matchMedia query as a read-only signal, live via the change listener (the prototype's go()). */
function mediaSignal(query: string): Signal<boolean> {
  const mql = window.matchMedia(query);
  const value = signal(mql.matches);
  mql.addEventListener('change', () => value.set(mql.matches));
  return value.asReadonly();
}

/**
 * The shell (concept v2 §7, design boards 5a / 6a–6d). Phone: one column
 * and no tab bar — the chat is home, its menu button opens the chat
 * history with the places Work, Team and Settings; every other screen
 * carries a menu button that leads back to it. From 768 px a top tab
 * bar (Work with the needs counter, Chat, Team, Settings) and Work
 * permanently in column 1 with the active detail in column 2; from
 * 1024 px the chat docks on the right (Chat | Capacity), and the Chat
 * tab folds or unfolds the dock instead of switching the center. The
 * views stay mounted and are placed by the grid.
 */
@Component({
  selector: 'mc-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [
    Work,
    Chat,
    Capacity,
    Settings,
    Team,
    PersonaDetail,
    TicketView,
    TicketEdit,
    PlanPane,
    PlanApprove,
    Empty,
    Toast,
    Pairing,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly state = inject(McState);

  /** The shell's visible tab — McState owns it; the nav writes it. */
  protected readonly tab = this.state.tab;
  /** The ticket screen: fullscreen overlay on the phone, detail column from 768 px. */
  protected readonly ticketOpen = this.state.ticketOpen;
  /** The plan to approve (E10-4): a layer under the ticket screen, so a part's ticket opens over it. */
  protected readonly approveOpen = this.state.approvalTicket;
  /** The open persona 1:1 (same layering as the ticket). */
  protected readonly personaOpen = this.state.personaDetail;
  /** The Work tab's amber counter: the needs count. */
  protected readonly needsCount = computed(() => this.state.needs().length);

  /** The pairing gate: 'ready' = the app; anything else = the pairing screen. */
  protected readonly pairing = this.state.pairing;

  /** The pairing screen's exchange binding (the state owns the token store). */
  protected readonly pairCode = (code: string) => this.state.pair(code);

  /** The layout steps: tablet from 768, the dock from 1024. */
  protected readonly wide = mediaSignal('(min-width: 768px)');
  protected readonly docked = mediaSignal('(min-width: 1024px)');

  /** The dock is folded by the top bar's Chat button; open by default. */
  protected readonly dockOpen = signal(true);
  protected readonly dockTab = signal<DockTab>('chat');

  constructor() {
    // The chat is the phone's home.
    if (!this.wide() && this.tab() === 'work') {
      this.tab.set('chat');
    }
  }

  /**
   * What the wide layout's center column shows, by precedence: the ticket
   * screen, then the persona 1:1, then the tab's own detail — the team
   * list, settings, the chat (tablet only; with the dock it sits right),
   * or the empty pane.
   */
  protected readonly detail = computed<'ticket' | 'persona' | 'plan' | 'team' | 'settings' | 'chat' | 'empty'>(
    () => {
      if (this.ticketOpen() !== null) {
        return 'ticket';
      }
      if (this.personaOpen() !== null) {
        return 'persona';
      }
      const tab = this.tab();
      if (tab === 'team' || tab === 'settings') {
        return tab;
      }
      // Shape mode (E10-3, board "iPad: Shape the plan"): with the chat docked
      // beside it, the shared plan takes the center. Narrower, it is a sheet
      // inside the chat.
      if (this.docked() && this.showDock() && this.dockTab() === 'chat' && this.state.shapedTicket() !== null) {
        return 'plan';
      }
      if (tab === 'chat' && !this.docked()) {
        return 'chat';
      }
      return 'empty';
    },
  );

  /** Work: the phone's active tab only; from 768 px permanently in column 1. */
  protected readonly showWork = computed(() => this.wide() || this.tab() === 'work');

  /** The dock (column 3): wide enough and not folded. */
  protected readonly showDock = computed(() => this.docked() && this.dockOpen());

  /** Chat: the dock's chat tab, else the active tab (phone, tablet). */
  protected readonly showChat = computed(() =>
    this.docked() ? this.showDock() && this.dockTab() === 'chat' : this.tab() === 'chat',
  );

  /** Capacity: the dock's second tab. */
  protected readonly showCapacity = computed(() => this.showDock() && this.dockTab() === 'capacity');

  /** Team: the phone's active tab; on the wide grid only while it owns the center. */
  protected readonly showTeam = computed(() =>
    this.wide() ? this.detail() === 'team' : this.tab() === 'team',
  );

  /** Settings: same placement rule as Team. */
  protected readonly showSettings = computed(() =>
    this.wide() ? this.detail() === 'settings' : this.tab() === 'settings',
  );

  /** The shared plan: the center column while a shape session is open beside the docked chat. */
  protected readonly showPlan = computed(() => this.wide() && this.detail() === 'plan');

  /** The empty pane: only on the wide grid, while nothing else claims the center. */
  protected readonly showEmpty = computed(() => this.wide() && this.detail() === 'empty');

  /** The phone's menu button shows on every screen but the chat itself. */
  protected readonly showPhoneBar = computed(() => !this.wide() && this.tab() !== 'chat');

  /** A top-bar tab: sets the center tab (Work is permanent, so it clears any detail). */
  protected goTab(tab: McTab): void {
    this.state.ticketOpen.set(null);
    this.state.personaDetail.set(null);
    this.tab.set(tab);
  }

  /** The top bar's Chat button: folds the dock, or on a narrower screen switches to the chat. */
  protected onChatTab(): void {
    if (this.docked()) {
      this.dockOpen.update((open) => !open);
      this.dockTab.set('chat');
      return;
    }
    this.goTab('chat');
  }

  /** The phone menu button on another screen: back to the chat, history open. */
  protected openMenu(): void {
    this.state.chatMenu.set(true);
    this.goTab('chat');
  }
}
