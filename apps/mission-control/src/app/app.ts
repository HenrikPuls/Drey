import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { McState, type McTab } from './api/state';
import { Empty } from '@mission-ui/empty';
import { Toast } from '@mission-ui/toast';
import { Pairing } from '@mission-ui/pairing/pairing';
import { Work } from '@mission-ui/work/work';
import { Notes } from '@mission-ui/notes/notes';
import { Note } from '@mission-ui/notes/note';
import { NotesStore } from '@mission-ui/notes/notes.store';
import { Chat } from '@mission-ui/chat/chat';
import { Capacity } from '@mission-ui/capacity/capacity';
import { McI18nPipe } from '@mission-ui/i18n/i18n.pipe';
import { Settings } from '@mission-ui/settings/settings';
import { Theme } from '@mission-ui/theme';
import { Team } from '@mission-ui/team/team';
import { PersonaDetail } from '@mission-ui/team/detail';
import { TicketView } from '@mission-ui/ticket/view';
import { TicketEdit } from '@mission-ui/ticket/edit';
import { PlanPane } from '@mission-ui/plan/plan-pane';
import { PlanApprove } from '@mission-ui/plan/approve';
import { FlowEditor } from '@mission-ui/flow/flow';
import { MC_APP_NAV, type McAppNav } from '@mission-ui/app-bar/app-bar';
import { ShellHeader, type ShellArea } from '@mission-ui/shell/header';
import { Menu, type MenuPlace } from '@mission-ui/shell/menu';
import { Panes } from '@mission-ui/shell/panes';
import type { SessionMeta } from '@mission-ui/api/dto';

export type { McTab };

/** What the desktop web's right dock shows (E12-2): the chat, or the capacity. */
export type DockTab = 'chat' | 'capacity';

/** The three shells (concept §7): one column, the desktop-like iPad, the desktop web with its tab bar. */
export type ShellKind = 'phone' | 'ipad' | 'desktop';

/**
 * The Notes area on phone and iPad (req-101): the menu row, the header
 * segment, the list and the note. Kept as a switch so the area can be
 * hidden again without touching the screens.
 */
export const NOTES_ENABLED = true;

/** A matchMedia query as a read-only signal, live via the change listener (the prototype's go()). */
function mediaSignal(query: string): Signal<boolean> {
  const mql = window.matchMedia(query);
  const value = signal(mql.matches);
  mql.addEventListener('change', () => value.set(mql.matches));
  return value.asReadonly();
}

/**
 * The shell kind from the width and the pointer (req-96): below 768 px the
 * phone; from 768 px a touch device (coarse pointer, no hover — the iPad)
 * gets the desktop-like iPad shell, a mouse device the desktop web with
 * its top tab bar (G-37, canvas decision 13).
 */
export function shellKindOf(wide: boolean, touch: boolean): ShellKind {
  if (!wide) {
    return 'phone';
  }
  return touch ? 'ipad' : 'desktop';
}

/** The tab a wide layout shows for the state's tab: the phone-only `menu` reads as Work. */
export function wideTabOf(tab: McTab): Exclude<McTab, 'menu'> {
  return tab === 'menu' ? 'work' : tab;
}

/** The iPad header's area for a tab; null for the tabs that are not an area (chat, settings, menu). */
export function areaOf(tab: McTab): ShellArea | null {
  switch (tab) {
    case 'notes':
      return 'notes';
    case 'work':
      return 'work';
    case 'team':
      return 'crew';
    default:
      return null;
  }
}

/** The tab an iPad header area or a phone menu place leads to. */
export function tabOfPlace(place: ShellArea | MenuPlace): McTab {
  switch (place) {
    case 'crew':
      return 'team';
    case 'notes':
      return 'notes';
    case 'settings':
      return 'settings';
    default:
      return 'work';
  }
}

/**
 * The shell (concept §7, canvas decisions 12, 13 and 17; req-96).
 *
 * **Phone** (below 768 px): one column. The **menu is the root screen**
 * (search, the places Notes · Work · Crew · Settings, then the chats with
 * Mission Control); it has no back button and nothing has a hamburger —
 * every other screen's app bar carries one labelled back control to its
 * parent (Work / Crew / Settings / Chat → "Menu", Ticket → "Work", Plan →
 * "Ticket", Appearance → "Settings").
 *
 * **iPad** (from 768 px on a touch device): works like the desktop — a
 * 52 px header with the left-sidebar toggle, the Notes · Work · Crew
 * switch, the Autopilot slot (req-95b), Settings and the right-sidebar
 * toggle. Left = the list of the area (Work: tickets; Crew: personas),
 * centre = the document (the ticket, the persona, the plan, Settings or
 * the empty pane), right = the Mission Control conversation. Landscape
 * opens all three, portrait the left and the centre with the right one as
 * an overlay; the open state is saved per orientation on this device
 * (`Panes`, decision 31, D10) and restored on start.
 *
 * **Desktop web** (from 768 px with a mouse): the top tab bar (Work with
 * the needs counter, Chat, Crew, Settings), Work permanently in column 1,
 * the detail in column 2; from 1024 px the chat docks on the right
 * (Chat | Capacity) and the Chat tab folds or unfolds the dock. Unchanged
 * by req-96 (G-37). The views stay mounted and are placed by the grid.
 */
@Component({
  selector: 'mc-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [
    McI18nPipe,
    Work,
    Notes,
    Note,
    Chat,
    Capacity,
    Settings,
    Team,
    PersonaDetail,
    TicketView,
    TicketEdit,
    PlanPane,
    PlanApprove,
    FlowEditor,
    Empty,
    Toast,
    Pairing,
    ShellHeader,
    Menu,
  ],
  providers: [
    {
      // The app bar's "Menu" back control on every phone page leads to the
      // root menu (req-96). Provided here, on the shell's own element, so
      // it wins over the root-level provider in app.config.ts, which still
      // describes the pre-req-96 "chat is home" rule.
      provide: MC_APP_NAV,
      useFactory: (): McAppNav => {
        const state = inject(McState);
        return {
          openMenu: () => {
            state.ticketOpen.set(null);
            state.personaDetail.set(null);
            state.tab.set('menu');
          },
        };
      },
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly state = inject(McState);
  /** Constructed at boot so the stored theme, accent and text size apply before Settings is ever opened. */
  private readonly theme = inject(Theme);
  /** The iPad's pane state per orientation (req-96). */
  protected readonly panes = inject(Panes);

  /** The shell's visible tab — McState owns it; the nav writes it. */
  protected readonly tab = this.state.tab;
  /** The ticket screen: fullscreen overlay on the phone, the centre from 768 px. */
  protected readonly ticketOpen = this.state.ticketOpen;
  /** The plan to accept (E10-4): a layer under the ticket screen, so a part's ticket opens over it. */
  protected readonly approveOpen = this.state.approvalTicket;
  /** The flow editor (E10-5): a layer above the ticket screen and the plan to accept. */
  protected readonly flowOpen = this.state.flowTarget;
  /** The open persona 1:1 (same layering as the ticket). */
  protected readonly personaOpen = this.state.personaDetail;
  /** The Work tab's needs counter: the needs count. */
  protected readonly needsCount = computed(() => this.state.needs().length);
  /** The chats with Mission Control, for the phone menu. */
  protected readonly sessions = computed(() => this.state.chat().sessions);
  protected readonly activeSessionFile = computed(() => this.state.chat().active?.file ?? null);

  /** The pairing gate: 'ready' = the app; anything else = the pairing screen. */
  protected readonly pairing = this.state.pairing;

  /** The pairing screen's exchange binding (the state owns the token store). */
  protected readonly pairCode = (code: string) => this.state.pair(code);

  /** The layout steps: wide from 768, the desktop dock from 1024; touch = coarse pointer without hover. */
  protected readonly wide = mediaSignal('(min-width: 768px)');
  protected readonly docked = mediaSignal('(min-width: 1024px)');
  protected readonly touch = mediaSignal('(hover: none) and (pointer: coarse)');

  protected readonly shell = computed<ShellKind>(() => shellKindOf(this.wide(), this.touch()));
  protected readonly isPhone = computed(() => this.shell() === 'phone');
  protected readonly isPad = computed(() => this.shell() === 'ipad');
  protected readonly isDesktop = computed(() => this.shell() === 'desktop');

  protected readonly notesEnabled = NOTES_ENABLED;
  /** The Notes screens' state: which note is open decides the phone's screen and the iPad's centre. */
  private readonly notes = inject(NotesStore);

  /** The desktop dock is folded by the top bar's Chat button; open by default. */
  protected readonly dockOpen = signal(true);
  protected readonly dockTab = signal<DockTab>('chat');

  /** The iPad header's area: the tab's own, or the last area while the chat or Settings owns the tab. */
  private readonly lastArea = signal<ShellArea>('work');
  protected readonly area = computed<ShellArea>(() => areaOf(this.tab()) ?? this.lastArea());

  constructor() {
    // The menu is the phone's root screen; the wide layouts open on Work.
    if (this.isPhone() && this.tab() === 'work') {
      this.tab.set('menu');
    }
    effect(() => {
      const area = areaOf(this.tab());
      if (area !== null) {
        untracked(() => this.lastArea.set(area));
      }
    });
    // On the iPad the chat is the right pane, never the centre: a switch to
    // the chat tab (a promote, "Ask Mission Control") opens that pane and
    // leaves the area where it was.
    effect(() => {
      if (this.isPad() && this.tab() === 'chat') {
        untracked(() => {
          this.panes.setRight(true);
          this.tab.set(tabOfPlace(this.lastArea()));
        });
      }
    });
  }

  // -- the wide tab (desktop web, iPad) ---------------------------------------------

  /** The tab the wide layouts show: the phone-only menu reads as Work. */
  protected readonly wideTab = computed(() => wideTabOf(this.tab()));

  /**
   * What the wide layout's centre shows, by precedence: the ticket screen,
   * then the persona 1:1, then the tab's own detail — the team list
   * (desktop only; the iPad lists personas in the left pane), Settings, the
   * chat (desktop tablet only; with the dock it sits right), the shared
   * plan, or the empty pane.
   */
  protected readonly detail = computed<'ticket' | 'persona' | 'plan' | 'team' | 'settings' | 'chat' | 'note' | 'empty'>(
    () => {
      if (this.ticketOpen() !== null) {
        return 'ticket';
      }
      if (this.personaOpen() !== null) {
        return 'persona';
      }
      const tab = this.wideTab();
      if (tab === 'settings') {
        return 'settings';
      }
      if (tab === 'notes' && this.isPad() && this.notes.path() !== null) {
        return 'note';
      }
      if (tab === 'team' && this.isDesktop()) {
        return 'team';
      }
      // Shape mode (E10-3, board "iPad: Shape the plan"): with the chat beside
      // it, the shared plan takes the centre. Narrower, it is a sheet inside
      // the chat.
      if (this.chatBeside() && this.state.shapedTicket() !== null) {
        return 'plan';
      }
      if (tab === 'chat' && this.isDesktop() && !this.docked()) {
        return 'chat';
      }
      return 'empty';
    },
  );

  /** The chat sits beside the centre: the desktop dock's chat tab, or the iPad's open right pane. */
  private readonly chatBeside = computed(() =>
    this.isPad() ? this.panes.right() : this.docked() && this.showDock() && this.dockTab() === 'chat',
  );

  // -- desktop web ------------------------------------------------------------------

  /** The desktop dock (column 3): wide enough and not folded. */
  protected readonly showDock = computed(() => this.isDesktop() && this.docked() && this.dockOpen());

  /** Capacity: the desktop dock's second tab (the iPad's right pane has the same switch). */
  protected readonly showCapacity = computed(() => this.showDock() && this.dockTab() === 'capacity');

  /** The desktop top bar's Chat button: folds the dock, or on a narrower screen switches to the chat. */
  protected onChatTab(): void {
    if (this.docked()) {
      this.dockOpen.update((open) => !open);
      this.dockTab.set('chat');
      return;
    }
    this.goTab('chat');
  }

  // -- what mounts where ------------------------------------------------------------

  /** Work: the phone's Work screen; the desktop's column 1; the iPad's left pane while Work is the area. */
  protected readonly showWork = computed(() => {
    switch (this.shell()) {
      case 'phone':
        return this.tab() === 'work';
      case 'desktop':
        return true;
      case 'ipad':
        return this.panes.left() && this.area() === 'work';
    }
  });

  /**
   * Notes: the phone's list while no note is open (the note replaces it),
   * the iPad's left pane while Notes is the area. Not on the desktop web.
   */
  protected readonly showNotesList = computed(() => {
    switch (this.shell()) {
      case 'phone':
        return this.tab() === 'notes' && this.notes.path() === null;
      case 'desktop':
        return false;
      case 'ipad':
        return this.panes.left() && this.area() === 'notes';
    }
  });

  /** The open note: the phone's note screen, the iPad's centre. */
  protected readonly showNote = computed(() =>
    this.isPhone() ? this.tab() === 'notes' && this.notes.path() !== null : this.detail() === 'note',
  );

  /** Team: the phone's Crew screen; the desktop centre while it owns it; the iPad's left pane while Crew is the area. */
  protected readonly showTeam = computed(() => {
    switch (this.shell()) {
      case 'phone':
        return this.tab() === 'team';
      case 'desktop':
        return this.detail() === 'team';
      case 'ipad':
        return this.panes.left() && this.area() === 'crew';
    }
  });

  /** Chat: the phone's Chat screen; the desktop dock's chat tab or tablet centre; the iPad's right pane. */
  protected readonly showChat = computed(() => {
    switch (this.shell()) {
      case 'phone':
        return this.tab() === 'chat';
      case 'desktop':
        return this.docked() ? this.showDock() && this.dockTab() === 'chat' : this.tab() === 'chat';
      case 'ipad':
        return this.panes.right() && this.dockTab() === 'chat';
    }
  });

  /** Settings: the phone's Settings screen; the wide centre while it owns it. */
  protected readonly showSettings = computed(() =>
    this.isPhone() ? this.tab() === 'settings' : this.detail() === 'settings',
  );

  /** The shared plan: the centre while a shape session is open beside the chat. */
  protected readonly showPlan = computed(() => !this.isPhone() && this.detail() === 'plan');

  /** The empty pane: only in a wide centre, while nothing else claims it. */
  protected readonly showEmpty = computed(() => !this.isPhone() && this.detail() === 'empty');

  /** The phone's root screen. */
  protected readonly showMenu = computed(() => this.isPhone() && this.tab() === 'menu');

  /** The iPad's right pane in portrait: an overlay over the centre, closed by its scrim. */
  protected readonly rightOverlay = computed(() => this.isPad() && this.panes.orientation() === 'portrait');

  // -- navigation -------------------------------------------------------------------

  /** A top-bar tab or a menu place: sets the tab (Work is permanent on the desktop, so it clears any detail). */
  protected goTab(tab: McTab): void {
    this.state.ticketOpen.set(null);
    this.state.personaDetail.set(null);
    this.tab.set(tab);
  }

  /** The iPad header's area switch: the area's list in the left pane, which opens if it was closed. */
  protected onArea(area: ShellArea): void {
    this.goTab(tabOfPlace(area));
    if (!this.panes.left()) {
      this.panes.setLeft(true);
    }
  }

  /** The iPad header's Settings control: Settings in the centre; a second tap returns to the area. */
  protected onPadSettings(): void {
    this.goTab(this.wideTab() === 'settings' ? tabOfPlace(this.lastArea()) : 'settings');
  }

  /** A phone menu place. */
  protected onPlace(place: MenuPlace): void {
    this.goTab(tabOfPlace(place));
  }

  /** A chat row in the phone menu: that session in the chat screen. */
  protected onMenuChat(entry: SessionMeta): void {
    void this.state.openSession(entry.file);
    this.goTab('chat');
  }

  /** New chat from the phone menu: the chat screen with no session open — the first send starts one. */
  protected onMenuNewChat(): void {
    this.state.closeSession();
    this.goTab('chat');
  }
}
