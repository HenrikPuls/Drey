/**
 * The tickets remote's phone client (req-66 R3, ADR-0084): pairing,
 * then Needs you / Board / Capture under a tab bar, a ticket view with
 * its actions, all kept live by the desk's event stream. Routes are the
 * URL fragment (`#needs`, `#board/<phase>`, `#ticket/<id>[/log]`,
 * `#capture`) so the back gesture and a home-screen launch both work.
 */
import type { FleetSnapshot } from '../main/fleet-client';
import type { DeviceView } from '../main/remote/auth';
import type { NeedItem, TicketReply } from '../shared/remote-protocol';
import type { BoardSnapshot } from '../shared/tickets';
import { Api, ApiError } from './api';
import { h, icon, present, toast } from './dom';
import type { Ctx, State, View } from './context';
import { kanbanView } from './kanban';
import { refineTabOf, refineView } from './refine-view';
import { runsView, runView } from './runs-views';
import { boardView, captureView, fleetChip, gestureInProgress, needsView, pairView, ticketView } from './views';

interface Route {
  readonly name: 'needs' | 'board' | 'ticket' | 'capture' | 'runs' | 'run' | 'refine';
  readonly arg: string | null;
  readonly sub: string | null;
}

function routeOf(hash: string): Route {
  const [name, arg, sub] = hash.replace(/^#/, '').split('/');
  switch (name) {
    case 'board':
      return { name: 'board', arg: arg ?? null, sub: null };
    case 'ticket':
      return arg !== undefined ? { name: 'ticket', arg: decodeURIComponent(arg), sub: sub ?? null } : { name: 'needs', arg: null, sub: null };
    case 'capture':
      return { name: 'capture', arg: null, sub: null };
    case 'runs':
      return { name: 'runs', arg: null, sub: null };
    case 'refine':
      return arg !== undefined ? { name: 'refine', arg: decodeURIComponent(arg), sub: sub ?? null } : { name: 'needs', arg: null, sub: null };
    case 'run':
      return arg !== undefined ? { name: 'run', arg: decodeURIComponent(arg), sub: null } : { name: 'runs', arg: null, sub: null };
    default:
      return { name: 'needs', arg: null, sub: null };
  }
}

class App {
  private readonly api = new Api();
  private readonly state: State = {
    actor: '',
    deviceName: '',
    readOnly: false,
    board: null,
    fleet: null,
    needs: [],
    connected: false,
    ticket: null,
    stream: null,
  };
  private pendingRender = false;
  /** iPad widths: the kanban from 768 px, the kanban with a detail pane from 1100 px. */
  private readonly wideQuery = matchMedia('(min-width: 768px)');
  private readonly splitQuery = matchMedia('(min-width: 1100px)');
  private lastWasForm = false;
  private forcePaint = false;
  /** What the current page was drawn from — an identical refresh draws nothing. */
  private paintedFrom = '';
  private stopEvents: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly header = h('header', { class: 'topbar' });
  private readonly main = h('main', { class: 'view' });
  private readonly footer = h('div', { class: 'footer' });
  private readonly tabbar = h('nav', { class: 'tabbar', attrs: { 'aria-label': 'Sections' } });
  private lastRouteKey = '';

  private readonly ctx: Ctx = {
    api: this.api,
    state: this.state,
    go: (hash) => {
      if (location.hash === hash) {
        this.render();
      } else {
        location.hash = hash;
      }
    },
    reload: () => {
      this.forcePaint = true;
      this.paintedFrom = '';
      void this.refresh();
    },
    act: async (call, success) => {
      try {
        const result = await call;
        if (result.ok) {
          toast(success);
          this.scheduleRefresh(0);
          return true;
        }
        toast(result.error ?? 'The desk refused.', 'error');
      } catch (error) {
        this.handleError(error);
      }
      return false;
    },
  };

  start(): void {
    document.body.append(this.header, this.main, this.footer, this.tabbar);
    window.addEventListener('hashchange', () => this.onRoute());
    const relayout = (): void => {
      this.forcePaint = true;
      this.paintedFrom = '';
      this.render();
    };
    this.wideQuery.addEventListener('change', relayout);
    this.splitQuery.addEventListener('change', relayout);
    // A field being typed in is never redrawn under the cursor: the redraw waits for blur.
    document.addEventListener('focusout', () => {
      if (this.pendingRender) {
        setTimeout(() => this.render(), 0);
      }
    });
    // The transcript is not pushed: an open run view pulls it while the run lives.
    setInterval(() => {
      const route = routeOf(location.hash);
      if (route.name === 'run' && document.visibilityState === 'visible' && !this.tabbar.hidden) {
        const run = this.state.fleet?.runs.find((r) => r.id === route.arg);
        if (run !== undefined && ['starting', 'running', 'stopping', 'detached'].includes(run.state)) {
          this.scheduleRefresh(0);
        }
      }
    }, 3000);
    const pair = /^#pair=([A-Za-z0-9-]+)$/.exec(location.hash);
    if (pair !== null) {
      history.replaceState(null, '', `${location.pathname}#needs`);
      void this.pair(pair[1]!);
    } else if (this.api.token() === null) {
      this.showPair(null);
    } else {
      void this.connect();
    }
  }

  private async pair(code: string): Promise<void> {
    try {
      const result = await this.api.post<{ ok: boolean; token?: string; error?: string }>('/api/pair', { code });
      if (result.token === undefined || !this.api.setToken(result.token)) {
        this.showPair(result.token === undefined ? (result.error ?? 'Pairing failed.') : 'This browser keeps no data, so the pairing cannot be stored.');
        return;
      }
      await this.connect();
    } catch (error) {
      this.showPair(error instanceof Error ? error.message : String(error));
    }
  }

  private showPair(message: string | null): void {
    this.stopEvents?.();
    this.stopEvents = null;
    this.tabbar.hidden = true;
    this.paint(pairView((code) => void this.pair(code), message));
  }

  private async connect(): Promise<void> {
    try {
      const me = await this.api.get<{ device: DeviceView; actor: string }>('/api/me');
      this.state.actor = me.actor;
      this.state.deviceName = me.device.name;
      this.state.readOnly = me.device.readOnly;
    } catch (error) {
      this.handleError(error);
      return;
    }
    this.tabbar.hidden = false;
    this.stopEvents?.();
    this.stopEvents = this.api.listen({
      onEvent: () => this.scheduleRefresh(250),
      onState: (connected) => {
        this.state.connected = connected;
        this.paintHeaderOnly();
      },
      onUnauthorized: () => this.unpaired(),
    });
    await this.refresh();
  }

  private unpaired(): void {
    this.api.clearToken();
    this.showPair('This device is not paired (any more).');
  }

  private handleError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      this.unpaired();
      return;
    }
    toast(error instanceof Error ? error.message : String(error), 'error');
  }

  private scheduleRefresh(ms: number): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, ms);
  }

  private async refresh(): Promise<void> {
    try {
      const route = routeOf(location.hash);
      const [board, fleet, needs, ticket, stream] = await Promise.all([
        this.api.get<BoardSnapshot>('/api/board'),
        this.api.get<FleetSnapshot>('/api/fleet'),
        this.api.get<NeedItem[]>('/api/needs'),
        (route.name === 'ticket' || route.name === 'refine') && route.arg !== null
          ? this.api.get<TicketReply>(`/api/tickets/${encodeURIComponent(route.arg)}`)
          : Promise.resolve(null),
        route.name === 'run' && route.arg !== null
          ? this.api.get<{ text: string }>(`/api/runs/${encodeURIComponent(route.arg)}/stream`)
          : Promise.resolve(null),
      ]);
      this.state.board = board;
      this.state.fleet = fleet;
      this.state.needs = needs;
      if (ticket !== null) {
        this.state.ticket = ticket;
      }
      if (stream !== null && route.arg !== null) {
        this.state.stream = { runId: route.arg, text: stream.text };
      }
      this.render();
    } catch (error) {
      this.handleError(error);
    }
  }

  private onRoute(): void {
    const route = routeOf(location.hash);
    if (route.name === 'run' && this.state.stream?.runId !== route.arg) {
      this.state.stream = null;
      this.scheduleRefresh(0);
    }
    if (route.name === 'ticket' || route.name === 'refine') {
      const current = this.state.ticket;
      if (current === null || !current.ok || current.card.id !== route.arg) {
        this.state.ticket = null;
        this.scheduleRefresh(0);
      }
    }
    this.render();
  }

  private render(): void {
    if (this.tabbar.hidden) {
      return;
    }
    if (gestureInProgress()) {
      setTimeout(() => this.render(), 150);
      return;
    }
    const route = routeOf(location.hash);
    let view: View;
    switch (route.name) {
      case 'board':
        view = this.wideQuery.matches ? kanbanView(this.ctx, null, 'ticket', this.splitQuery.matches) : boardView(this.ctx, route.arg);
        break;
      case 'ticket':
        view = this.splitQuery.matches
          ? kanbanView(this.ctx, route.arg!, route.sub === 'log' ? 'log' : 'ticket', true)
          : ticketView(this.ctx, route.arg!, route.sub === 'log' ? 'log' : 'ticket');
        break;
      case 'capture':
        view = captureView(this.ctx);
        break;
      case 'runs':
        view = runsView(this.ctx);
        break;
      case 'run':
        view = runView(this.ctx, route.arg!);
        break;
      case 'refine':
        view = refineView(this.ctx, route.arg!, refineTabOf(route.sub));
        break;
      default:
        view = needsView(this.ctx);
    }
    // Capture is a form: a live update must not wipe what is being typed.
    const key = `${route.name}/${route.arg ?? ''}/${route.sub ?? ''}`;
    const same = key === this.lastRouteKey;
    if (same && view.form === true && this.lastWasForm && !this.forcePaint) {
      this.paintHeaderOnly();
      return;
    }
    this.forcePaint = false;
    const active = document.activeElement;
    if (same && active instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && document.body.contains(active)) {
      this.pendingRender = true;
      this.paintHeaderOnly();
      return;
    }
    this.pendingRender = false;
    const from = `${key}|${this.state.connected}|${JSON.stringify([this.state.board, this.state.fleet, this.state.needs, this.state.ticket, this.state.stream])}`;
    if (same && from === this.paintedFrom) {
      return;
    }
    this.paintedFrom = from;
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;
    this.paint(view, same);
    this.lastWasForm = view.form === true;
    if (view.followTail === true && (!same || atEnd)) {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
    this.lastRouteKey = key;
    this.paintTabs(route);
  }

  private paint(view: View, keepScroll = false): void {
    const scroll = keepScroll ? window.scrollY : 0;
    this.header.replaceChildren(...present<Node>([
      view.back !== undefined
        ? h(
            'a',
            { class: 'back', attrs: { href: view.back, 'aria-label': 'Back' } },
            icon('back', 20),
          )
        : null,
      h('span', { class: 'topbar-title', text: view.title }),
      this.tabbar.hidden ? null : fleetChip(this.ctx),
    ]));
    this.main.replaceChildren(...view.body);
    this.footer.replaceChildren(...(view.actions ? [view.actions] : []));
    document.body.classList.toggle('has-actions', Boolean(view.actions));
    document.body.classList.toggle('wide', view.wide === true);
    document.title = `${view.title} · Drey Tickets`;
    window.scrollTo(0, scroll);
  }

  private paintHeaderOnly(): void {
    const chipNode = this.header.querySelector('.chip');
    if (chipNode !== null && !this.tabbar.hidden) {
      chipNode.replaceWith(fleetChip(this.ctx));
    }
  }

  private paintTabs(route: Route): void {
    const needCount = this.state.needs.filter((n) => n.kind !== 'checkpoint').length;
    const tab = (name: Route['name'], label: string, glyph: string, hash: string, badge = 0): HTMLElement =>
      h(
        'a',
        {
          class: `tab${route.name === name || (name === 'board' && (route.name === 'ticket' || route.name === 'refine')) || (name === 'runs' && route.name === 'run') ? ' on' : ''}`,
          attrs: { href: hash, ...(route.name === name ? { 'aria-current': 'page' } : {}) },
        },
        icon(glyph),
        h('span', { text: label }),
        badge > 0 ? h('span', { class: 'badge', text: String(badge) }) : null,
      );
    this.tabbar.replaceChildren(
      tab('needs', 'Needs you', 'inbox', '#needs', needCount),
      tab('board', 'Board', 'board', '#board'),
      tab('runs', 'Runs', 'pulse', '#runs'),
      tab('capture', 'Capture', 'plus', '#capture'),
    );
  }
}

new App().start();
