/**
 * The workers' two surfaces (docs/design/work-panel/Workers.dc.html).
 * The section: the Work panel carries one card per live worker — a
 * state word beside its light, the ticket, a "Now" line with what it
 * is doing, the context and the clock — with the controls that matter
 * on a card: Pause or Continue, Stop, Tell, Nudge. The pure
 * `workerCards` choice is DOM-free and pinned by the spec;
 * `workersNode` draws it.
 *
 * The tab (req-75 W4b, canvas "3b · All workers"): the same live runs
 * as a grid of cards — what each does now and just did, its context,
 * its time — plus the pools, the queue, `Pause all after this step`
 * and the armed `Stop all`, and the stuck verdict read from the run's
 * own stream (`stuckOf`). `mountWorkers` pulls every live run's stream
 * every 5 s and stops pulling the moment the tab unmounts.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RunInfo } from '../main/fleet/protocol';
import type { NormalizedEvent } from '../main/fleet/providers';
import { durationWords, headerControls, liveStateWord } from './thread-steps';
import { contextFill, contextLabel, execClockMs, formatTokens, workerStatus, type Light } from './worker-status';
import { parseStreamEvents } from './watch-format';
import { STUCK_REPEATS, recentActions, stuckOf } from './stuck';
import { setSquirrelPose, squirrelNode, squirrelPose, type SquirrelPose } from './squirrel';

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
  /** The pulse the card's squirrel draws (req-75 W4d). */
  readonly pose: SquirrelPose;
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
        pose: squirrelPose(run, nowMs),
      };
    })
    .sort((a, b) => rank[a.light] - rank[b.light] || a.ticketId.localeCompare(b.ticketId));
}

/** What the Work panel's section needs from its host. */
export interface WorkersSectionDeps {
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
export function workersNode(deps: WorkersSectionDeps, runs: readonly RunInfo[], nowMs: number): HTMLElement | null {
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
    // The card's pulse: the squirrel, posed from the model (req-75 W4d).
    const dot = squirrelNode(14);
    setSquirrelPose(dot, card.pose);
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

// --- the Workers tab (req-75 W4b) --------------------------------------------

/** A provider's pool as the top row's chip names it. */
export interface WorkerPoolEntry {
  readonly id: string;
  readonly label: string;
  readonly size: number;
}

/** The queue behind the pools (the first blocked ticket says what it waits for). */
export interface WorkersQueueInfo {
  readonly count: number;
  readonly blocked: { readonly title: string; readonly blocker: string } | null;
}

/** What the Workers tab needs from its host — one seam, the spec's fakes. */
export interface WorkersViewDeps {
  /** The live, watchable runs — one card each. */
  runs(): readonly RunInfo[];
  /** The run's raw stream (NDJSON); '' when it has none yet. */
  stream(runId: string): Promise<string>;
  /** Every provider pool in board order, with its size. */
  pools(): readonly WorkerPoolEntry[];
  /** What waits behind the pools; null while the board has not loaded. */
  queue(): WorkersQueueInfo | null;
  /** The ticket's title (its id when the board does not know it). */
  titleOf(ticketId: string): string;
  /** A provider id as the card names it. */
  providerLabel(provider: string): string;
  /** tokensIn + tokensOut summed over the runs started today. */
  todayTokens(): number;
  /** The card's controls: pause after this step (a pause Continue resumes), and take over. */
  control(action: 'pause' | 'continue' | 'takeover', runId: string): void;
  /** Stops one run; resolves false when the backend refused. */
  stop(runId: string, reason: string | null): Promise<boolean>;
  /** Sends the owner's text to the worker (the steer ladder decides the rung). */
  send(runId: string, text: string): void;
  /** Starts a run on the ticket with this provider — the hand-over's other worker. */
  startRun(ticketId: string, provider: string): void;
  /** `Pause all after this step`: interrupt every live run. */
  pauseAll(): void;
  /** `Stop all`: the chain's emergency stop. */
  stopAll(): void;
  /** Opens the ticket page — the file with its thread beside it. */
  openTicket(ticketId: string): void;
  /** The host repaints the tab when its run list changes. */
  onRunsChanged(listener: () => void): () => void;
}

/** Each live run's stream is pulled this often — no faster. */
const PULL_MS = 5_000;

/** The recent-action lines under `Now`. */
const RECENT_LINES = 2;

/** From this context fill on, the stuck hint says the context is filling up. */
const FILLING_UP = 0.6;

/** Stop all disarms itself again after this long without a second click. */
const DISARM_MS = 5_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const button = (className: string, label: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

/** The Tell box's state, shared across the card rebuilds of one mount. */
interface TellBox {
  /** The run whose input is open; null when none. */
  forRun: string | null;
  text: string;
}

/**
 * The tab's DOM: the top row (title, pool chips, the queue, Pause all /
 * Stop all), the card grid, the muted footer line. The cards rebuild on
 * every paint; an open Tell input comes back with its text and focus.
 */
export function mountWorkers(deps: WorkersViewDeps, host: HTMLElement): () => void {
  const root = el('div', 'tickets-workers-tab');
  const topRow = el('div', 'tickets-workers-top');
  const grid = el('div', 'tickets-workers-grid');
  const foot = el('div', 'tickets-workers-foot');
  root.append(topRow, grid, foot);
  host.append(root);

  /** Each live run's parsed stream, by run id (gone with the run). */
  const streams = new Map<string, readonly NormalizedEvent[]>();
  const tell: TellBox = { forRun: null, text: '' };
  let stopAllArmed = false;
  let disarmTimer: number | null = null;
  let alive = true;

  const paint = (): void => {
    const runs = deps.runs();
    const refocus: (() => void)[] = [];

    // --- the top row: h1, one chip per pool, the queue, the two buttons.
    topRow.replaceChildren(el('h1', 'tickets-workers-h1', 'Workers'));
    for (const pool of deps.pools()) {
      const live = runs.filter((run) => run.provider === pool.id).length;
      topRow.append(el('span', 'tickets-workers-pool', pool.label), el('b', 'tickets-workers-pool-size', `${live}/${pool.size}`));
    }
    const queue = deps.queue();
    if (queue !== null && queue.count > 0) {
      const line =
        queue.blocked === null ? `${queue.count} queued` : `${queue.count} queued · ${queue.blocked.title} waits for ${queue.blocked.blocker}`;
      topRow.append(el('span', 'tickets-workers-queue', line));
    }
    topRow.append(el('span', 'tickets-workers-spacer'));
    const pauseAll = button('tickets-takeover-btn tickets-workers-allbtn', 'Pause all after this step', () => deps.pauseAll());
    pauseAll.disabled = runs.length === 0;
    const stopAll = button(
      `tickets-takeover-btn tickets-workers-allbtn tickets-workers-stopall${stopAllArmed ? ' tickets-workers-armed' : ''}`,
      stopAllArmed ? 'Stop all — click again' : 'Stop all',
      () => {
        if (!stopAllArmed) {
          stopAllArmed = true;
          paint();
          disarmTimer = window.setTimeout(() => {
            stopAllArmed = false;
            if (alive) {
              paint();
            }
          }, DISARM_MS);
          return;
        }
        stopAllArmed = false;
        if (disarmTimer !== null) {
          window.clearTimeout(disarmTimer);
          disarmTimer = null;
        }
        deps.stopAll();
        paint();
      },
    );
    stopAll.disabled = runs.length === 0;
    topRow.append(pauseAll, stopAll);

    // --- the cards, one per live run.
    grid.replaceChildren();
    if (runs.length === 0) {
      grid.append(el('div', 'tickets-workers-empty', 'No worker is running.'));
    }
    for (const run of runs) {
      grid.append(cardNode(deps, run, streams.get(run.id) ?? [], tell, paint, refocus));
    }

    // --- the footer line.
    foot.textContent = `${runs.length} worker${runs.length === 1 ? '' : 's'} · today ${formatTokens(deps.todayTokens())} tokens`;
    for (const focus of refocus) {
      focus();
    }
  };

  /** Pulls every live run's stream, then repaints. */
  const pull = (): void => {
    if (!alive) {
      return;
    }
    const runs = deps.runs();
    const live = new Set(runs.map((run) => run.id));
    for (const id of [...streams.keys()]) {
      if (!live.has(id)) {
        streams.delete(id);
      }
    }
    void Promise.all(
      runs.map(async (run) => {
        try {
          const text = await deps.stream(run.id);
          if (alive) {
            streams.set(run.id, parseStreamEvents(text));
          }
        } catch {
          // a refused pull — the next one retries
        }
      }),
    ).then(() => {
      if (alive) {
        paint();
      }
    });
  };

  const offRunsChanged = deps.onRunsChanged(paint);
  paint();
  pull();
  const timer = window.setInterval(pull, PULL_MS);
  return () => {
    alive = false;
    offRunsChanged();
    window.clearInterval(timer);
    if (disarmTimer !== null) {
      window.clearTimeout(disarmTimer);
    }
    root.remove();
  };
}

/** One card's DOM (the canvas's bordered card). */
function cardNode(
  deps: WorkersViewDeps,
  run: RunInfo,
  events: readonly NormalizedEvent[],
  tell: TellBox,
  repaint: () => void,
  refocus: (() => void)[],
): HTMLElement {
  const card = el('div', 'tickets-workers-card');
  const verdict = stuckOf(run, events, Date.now());
  // Stuck is a hint from two sources: the fleet's own flag and the
  // stream-read verdict — either one is enough to offer Nudge.
  const stuck = run.stuck === true || verdict.stuck;
  const waiting = run.waiting != null;
  const paused = !waiting && run.paused === true;
  const telling = tell.forRun === run.id;
  card.classList.add(waiting ? 'is-waiting' : paused ? 'is-paused' : stuck ? 'is-stuck' : 'is-working');
  if (telling) {
    card.classList.add('is-telling');
  }

  // The head: the run's dot, the bold title, the time right.
  const status = workerStatus(run, Date.now());
  const light = waiting ? 'waiting' : stuck ? 'amber' : status.light;
  const head = el('div', 'tickets-workers-cardhead');
  head.append(el('span', `tickets-light tickets-light-${light}`));
  head.append(el('b', 'tickets-workers-title', deps.titleOf(run.ticketId)));
  head.append(el('span', 'tickets-workers-time', durationWords(execClockMs(run, Date.now()))));
  card.append(head);

  // One muted line: state · provider · model · context.
  const fill = contextFill(run);
  const meta = el('div', 'tickets-workers-meta');
  meta.append(el('span', 'tickets-workers-state', stuck ? 'Looks stuck' : (liveStateWord(run) ?? 'Working')));
  for (const part of [deps.providerLabel(run.provider), run.model ?? null, fill === null ? null : `context ${Math.round(fill * 100)}%`]) {
    if (part !== null && part !== '') {
      meta.append(el('span', undefined, ' · '), el('span', undefined, part));
    }
  }
  card.append(meta);

  // The Now box: the current activity (the runner's own line, else the
  // newest action), the recent actions before it muted below.
  const activity = (run.activity ?? '').trim();
  const recent = recentActions(events, RECENT_LINES + (activity !== '' ? 0 : 1)).slice();
  const nowLine = activity !== '' ? activity : (recent.pop() ?? '');
  const nowBox = el('div', 'tickets-workers-now');
  nowBox.append(el('span', 'tickets-workers-nowlabel', 'Now'));
  nowBox.append(el('span', 'tickets-workers-activity', nowLine));
  nowBox.append(el('span', 'tickets-workers-before', recent.join('\n')));
  card.append(nowBox);

  // The stuck hint line (a hint, never an action).
  if (stuck) {
    const text =
      verdict.repeatedReads >= STUCK_REPEATS
        ? `Read the same files ${verdict.repeatedReads} times without an edit.`
        : verdict.minutesWithoutEdit !== null && fill !== null && fill >= FILLING_UP
          ? `No progress for ${verdict.minutesWithoutEdit} minutes and the context is filling up.`
          : verdict.minutesWithoutEdit !== null
            ? `No progress for ${verdict.minutesWithoutEdit} minutes.`
            : 'No progress for a while.';
    card.append(el('div', 'tickets-workers-hint', text));
  }

  // The Tell input (a working card): one line and a Send button, inside
  // the card. Sending closes it.
  if (telling) {
    const box = el('div', 'tickets-workers-tell');
    const input = el('input', 'tickets-workers-tellinput') as HTMLInputElement;
    input.type = 'text';
    input.setAttribute('aria-label', 'Tell the worker');
    input.value = tell.text;
    input.addEventListener('input', () => {
      tell.text = input.value;
    });
    const send = (): void => {
      const text = tell.text.trim();
      if (text === '') {
        return;
      }
      tell.forRun = null;
      tell.text = '';
      deps.send(run.id, text);
      repaint();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });
    const sendBtn = button('tickets-takeover-btn tickets-takeover-btn-primary', 'Send', send);
    box.append(input, sendBtn);
    card.append(box);
    refocus.push(() => input.focus());
  }

  // The actions row: the state's buttons, the Open ticket link right.
  const actions = el('div', 'tickets-workers-actions');
  const takeOver = button('tickets-takeover-btn', 'Take over', () => deps.control('takeover', run.id));
  const stop = button('tickets-takeover-btn tickets-workers-stop', 'Stop', () => void deps.stop(run.id, null));
  const tellBtn = button('tickets-takeover-btn', 'Tell…', () => {
    tell.forRun = run.id;
    tell.text = '';
    repaint();
  });
  if (waiting) {
    actions.append(button('tickets-takeover-btn tickets-takeover-btn-primary', 'Answer', () => deps.openTicket(run.ticketId)), takeOver, stop);
  } else if (paused) {
    // A paused run resumes: Continue releases the step it stopped after.
    actions.append(button('tickets-takeover-btn tickets-takeover-btn-primary', 'Continue', () => deps.control('continue', run.id)), tellBtn, takeOver, stop);
  } else if (stuck) {
    actions.append(button('tickets-takeover-btn', 'Nudge', () => deps.send(run.id, NUDGE_TEXT)));
    const other = deps.pools().find((pool) => pool.id !== run.provider) ?? null;
    if (other !== null) {
      actions.append(
        button('tickets-takeover-btn', `Hand to ${other.label}`, () => {
          void deps.stop(run.id, `handed to ${other.label} by the owner`).then((ok) => {
            if (ok) {
              deps.startRun(run.ticketId, other.id);
            }
          });
        }),
      );
    }
    actions.append(stop);
  } else {
    actions.append(button('tickets-takeover-btn', 'Pause', () => deps.control('pause', run.id)), tellBtn, takeOver, stop);
  }
  actions.append(el('span', 'tickets-workers-spacer'));
  actions.append(button('tickets-workers-open', 'Open ticket', () => deps.openTicket(run.ticketId)));
  card.append(actions);
  return card;
}
