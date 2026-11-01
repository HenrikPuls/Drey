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
export type WorkerCardAction = 'pause' | 'continue' | 'stop' | 'tell' | 'nudge';

/** What Nudge sends a worker that went quiet: a status line, then carry on or ask. */
export const NUDGE_TEXT =
  'You have been quiet for a while. Say in one line what you are doing now. If you are blocked on a decision, ask ' +
  'with QUESTION:; otherwise carry on with the step.';

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
  /** The worker looks stuck — the card offers Nudge. */
  readonly stuck: boolean;
}

/** The header controls a card repeats. */
type RunControlAction = 'pause' | 'continue' | 'stop';

const CARD_ACTIONS: readonly RunControlAction[] = ['pause', 'continue', 'stop'];

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
        actions: [
          ...headerControls(run).filter((c): c is RunControlAction => (CARD_ACTIONS as readonly string[]).includes(c)),
          'tell',
        ],
        stuck: run.stuck === true,
      };
    })
    .sort((a, b) => rank[a.light] - rank[b.light] || a.ticketId.localeCompare(b.ticketId));
}

export interface WorkersViewDeps {
  readonly api: DreyPluginApi;
  /** Opens the ticket page of a card's ticket. */
  open(ticketId: string): void;
  act(runId: string, action: WorkerCardAction, text?: string): void;
}

/** The cards whose Tell… box is open, and what the owner typed — the section is redrawn every second. */
const tellOpen = new Set<string>();
const tellDraft = new Map<string, string>();

const ICONS: Record<Exclude<WorkerCardAction, 'nudge'>, { icon: string; title: string }> = {
  pause: { icon: 'pause', title: 'Pause after the current action' },
  continue: { icon: 'play', title: 'Continue — the worker picks the step up where it stopped' },
  stop: { icon: 'square', title: 'Stop the worker' },
  tell: { icon: 'message-square', title: 'Tell the worker something — it arrives as your next message' },
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
    if (card.stuck) {
      const nudge = document.createElement('button');
      nudge.type = 'button';
      nudge.className = 'tickets-worker-nudge';
      nudge.textContent = 'Nudge';
      nudge.title = 'Ask the quiet worker for a status line — it carries on or asks you';
      nudge.addEventListener('click', () => deps.act(card.runId, 'nudge'));
      top.append(nudge);
    }
    for (const action of card.actions) {
      if (action === 'nudge') {
        continue;
      }
      const spec = ICONS[action];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn';
      button.title = spec.title;
      button.setAttribute('aria-label', spec.title);
      button.append(deps.api.ui.icon(spec.icon, 13));
      button.addEventListener('click', () => {
        if (action === 'tell') {
          // Opens or closes the card's own input; the redraw keeps it.
          if (tellOpen.has(card.runId)) {
            tellOpen.delete(card.runId);
          } else {
            tellOpen.add(card.runId);
          }
          button.closest('.tickets-worker-card')?.querySelector<HTMLElement>('.tickets-worker-tell')?.toggleAttribute('hidden');
          button.closest('.tickets-worker-card')?.querySelector<HTMLInputElement>('.tickets-worker-tell input')?.focus();
          return;
        }
        deps.act(card.runId, action);
      });
      top.append(button);
    }
    const now = document.createElement('div');
    now.className = 'tickets-worker-now';
    now.textContent = card.now;
    const meta = document.createElement('div');
    meta.className = 'tickets-worker-meta';
    meta.textContent = [card.worked, card.context, card.tokens].filter((part) => part !== '').join(' · ');
    const tell = document.createElement('form');
    tell.className = 'tickets-worker-tell';
    tell.hidden = !tellOpen.has(card.runId);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tickets-worker-tell-input';
    input.setAttribute('aria-label', 'Tell the worker');
    input.value = tellDraft.get(card.runId) ?? '';
    input.addEventListener('input', () => tellDraft.set(card.runId, input.value));
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'tickets-takeover-btn';
    send.textContent = 'Send';
    tell.append(input, send);
    tell.addEventListener('submit', (event) => {
      event.preventDefault();
      const said = input.value.trim();
      if (said === '') {
        return;
      }
      tellDraft.delete(card.runId);
      tellOpen.delete(card.runId);
      input.value = '';
      tell.hidden = true;
      deps.act(card.runId, 'tell', said);
    });
    node.append(top, now, meta, tell);
    section.append(node);
  }
  return section;
}
