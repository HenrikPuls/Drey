/**
 * The Workers section of the Work panel (docs/design/work-panel/
 * Workers.dc.html): one card per live worker — a state word beside its
 * light, the ticket, a "Now" line with what it is doing, the context and
 * the clock — with the controls that matter on a card: Pause or
 * Continue, Stop, Open. The pure `workerCards` choice is DOM-free and
 * pinned by the spec; `workersNode` draws it.
 *
 * "Pause all" / "Stop all" are the master and emergency buttons the
 * panel already carries; nothing here duplicates them.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RunInfo } from '../main/fleet/protocol';
import { durationWords, headerControls, liveStateWord } from './thread-steps';
import { contextLabel, formatTokens, workerStatus, type Light } from './worker-status';

/** A card's action: the header's run controls, narrowed to what a card shows. */
export type WorkerCardAction = 'pause' | 'continue' | 'stop';

export interface WorkerCard {
  readonly runId: string;
  readonly ticketId: string;
  /** The state as words (`Building`, `Paused`, `Looks stuck`…). */
  readonly state: string;
  readonly light: Light;
  /** The "Now" line: what the worker is doing, or why it stands. */
  readonly now: string;
  readonly context: string;
  readonly tokens: string;
  /** Working time so far, in words. */
  readonly worked: string;
  readonly actions: readonly WorkerCardAction[];
}

const CARD_ACTIONS: readonly WorkerCardAction[] = ['pause', 'continue', 'stop'];

/** The live runs as cards, the ones that need a look first. */
export function workerCards(runs: readonly RunInfo[], nowMs: number): readonly WorkerCard[] {
  const rank: Record<Light, number> = { red: 0, amber: 1, green: 2, idle: 3 };
  return runs
    .map((run): WorkerCard => {
      const status = workerStatus(run, nowMs);
      const started = Date.parse(run.startedAt);
      return {
        runId: run.id,
        ticketId: run.ticketId,
        state: run.stuck === true || run.paused === true || run.waiting != null ? status.label : (liveStateWord(run) ?? status.label),
        light: status.light,
        now:
          run.waiting != null
            ? run.waiting.text.split('\n')[0]!.slice(0, 140)
            : run.paused === true
              ? 'Paused after the current action — Continue picks the step up where it stopped.'
              : (run.activity ?? (run.turn === 'idle' ? 'Standing — nothing in progress.' : 'Working…')),
        context: contextLabel(run),
        tokens: `${formatTokens(run.tokensIn + run.tokensOut)} tokens`,
        worked: Number.isNaN(started) ? '' : durationWords(run.execMs ?? Math.max(0, nowMs - started)),
        actions: headerControls(run).filter((c): c is WorkerCardAction => (CARD_ACTIONS as readonly string[]).includes(c)),
      };
    })
    .sort((a, b) => rank[a.light] - rank[b.light] || a.ticketId.localeCompare(b.ticketId));
}

export interface WorkersViewDeps {
  readonly api: DreyPluginApi;
  /** Opens the ticket page of a card's ticket. */
  open(ticketId: string): void;
  act(runId: string, action: WorkerCardAction): void;
}

const ICONS: Record<WorkerCardAction, { icon: string; title: string }> = {
  pause: { icon: 'pause', title: 'Pause after the current action' },
  continue: { icon: 'play', title: 'Continue — the worker picks the step up where it stopped' },
  stop: { icon: 'square', title: 'Stop the worker' },
};

/** The section's node, or null when no worker lives. */
export function workersNode(deps: WorkersViewDeps, runs: readonly RunInfo[], nowMs: number): HTMLElement | null {
  const cards = workerCards(runs, nowMs);
  if (cards.length === 0) {
    return null;
  }
  const section = document.createElement('section');
  section.className = 'tickets-workers';
  const head = document.createElement('div');
  head.className = 'tickets-workers-head';
  head.textContent = `Workers · ${cards.length}`;
  section.append(head);
  for (const card of cards) {
    const node = document.createElement('div');
    node.className = 'tickets-worker-card';
    node.dataset['light'] = card.light;
    const top = document.createElement('div');
    top.className = 'tickets-worker-top';
    const dot = document.createElement('span');
    dot.className = 'tickets-worker-dot';
    const state = document.createElement('span');
    state.className = 'tickets-worker-state';
    state.textContent = card.state;
    const ticket = document.createElement('button');
    ticket.type = 'button';
    ticket.className = 'tickets-worker-ticket';
    ticket.textContent = card.ticketId;
    ticket.title = 'Open the ticket';
    ticket.addEventListener('click', () => deps.open(card.ticketId));
    const spacer = document.createElement('span');
    spacer.className = 'tickets-worker-spacer';
    top.append(dot, state, ticket, spacer);
    for (const action of card.actions) {
      const spec = ICONS[action];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn';
      button.title = spec.title;
      button.setAttribute('aria-label', spec.title);
      button.append(deps.api.ui.icon(spec.icon, 13));
      button.addEventListener('click', () => deps.act(card.runId, action));
      top.append(button);
    }
    const now = document.createElement('div');
    now.className = 'tickets-worker-now';
    now.textContent = card.now;
    const meta = document.createElement('div');
    meta.className = 'tickets-worker-meta';
    meta.textContent = [card.worked, card.context, card.tokens].filter((part) => part !== '').join(' · ');
    node.append(top, now, meta);
    section.append(node);
  }
  return section;
}
