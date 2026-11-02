import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { McState, type McTab } from './api/state';
import { THEME_LABEL, Theme, type ThemeName } from '@mission-ui/theme';
import { Empty } from '@mission-ui/empty';
import { Toast } from '@mission-ui/toast';
import { Work } from '@mission-ui/work/work';
import { Chat } from '@mission-ui/chat/chat';
import { Team } from '@mission-ui/team/team';
import { PersonaDetail } from '@mission-ui/team/detail';
import { TicketView } from '@mission-ui/ticket/view';
import { TicketEdit } from '@mission-ui/ticket/edit';

export type { McTab };

/** A matchMedia query as a read-only signal, live via the change listener (the prototype's go()). */
function mediaSignal(query: string): Signal<boolean> {
  const mql = window.matchMedia(query);
  const value = signal(mql.matches);
  mql.addEventListener('change', () => value.set(mql.matches));
  return value.asReadonly();
}

/**
 * The shell (concept §7): one column on the phone; from 768 px the grid
 * grows — Work permanently in column 1, the active detail view in column
 * 2; from 1280 px the chat docks permanently in column 3, because it is
 * the regular intervention. The views stay mounted and are placed by the
 * grid — tab()/ticketOpen() only steer the detail slot (and the phone's
 * one-column pick); the ticket renders as a fullscreen overlay on the
 * phone and as the detail column from 768 px. The tab bar owns the tab
 * writes, the theme toggle sits beside it, and the toast pill rides
 * along on McState.
 */
@Component({
  selector: 'mc-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [Work, Chat, Team, PersonaDetail, TicketView, TicketEdit, Empty, Toast],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly state = inject(McState);
  private readonly themeService = inject(Theme);

  /** The shell's visible tab — McState owns it; the tabbar writes it. */
  protected readonly tab = this.state.tab;
  /** The ticket screen: fullscreen overlay on the phone, detail column from 768 px. */
  protected readonly ticketOpen = this.state.ticketOpen;
  /** The open persona 1:1 (same layering as the ticket). */
  protected readonly personaOpen = this.state.personaDetail;
  /** The tab bar's amber badge: the needs count. */
  protected readonly needsCount = computed(() => this.state.needs().length);

  /** The theme's name (the toggle's title reads it). */
  protected readonly theme = this.themeService.name;

  /** The two layout steps (the prototype's go()): tablet from 768, desktop from 1280. */
  protected readonly wide = mediaSignal('(min-width: 768px)');
  protected readonly xl = mediaSignal('(min-width: 1280px)');

  /**
   * What the wide layout's center column shows, by precedence: the ticket
   * screen, then the persona 1:1, then the tab's own detail — the team
   * list, the chat (tablet only; the desktop chat sits in column 3), or
   * the empty pane.
   */
  protected readonly detail = computed<'ticket' | 'persona' | 'team' | 'chat' | 'empty'>(() => {
    if (this.ticketOpen() !== null) {
      return 'ticket';
    }
    if (this.personaOpen() !== null) {
      return 'persona';
    }
    const tab = this.tab();
    if (tab === 'team') {
      return 'team';
    }
    if (tab === 'chat' && !this.xl()) {
      return 'chat';
    }
    return 'empty';
  });

  /** Work: the phone's active tab only; from 768 px permanently in column 1. */
  protected readonly showWork = computed(() => this.wide() || this.tab() === 'work');

  /** Chat: the active tab below 1280; permanently docked right from 1280. */
  protected readonly showChat = computed(() => this.xl() || this.tab() === 'chat');

  /** Team: the phone's active tab; on the wide grid only while it owns the center. */
  protected readonly showTeam = computed(() =>
    this.wide() ? this.detail() === 'team' : this.tab() === 'team',
  );

  /** The empty pane: only on the wide grid, while nothing else claims the center. */
  protected readonly showEmpty = computed(() => this.wide() && this.detail() === 'empty');

  /** The tab bar's theme toggle: flips the palette and reports it. */
  protected toggleTheme(): void {
    const name: ThemeName = this.themeService.toggle();
    this.state.toast(`Theme: ${THEME_LABEL[name]}`, 'ok');
  }
}
