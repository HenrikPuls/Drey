/**
 * The Tickets board (ADR-0076, milestone 83): a kanban view over the
 * tickets vault in the dock panel. Plain DOM (ADR-0044 rule 2); all data
 * comes from `backend.invoke('board')` snapshots — the renderer never
 * parses a ticket file. One module-level store serves every view; a
 * view is just a DOM root plus a render call.
 */
import { transcriptMarkdown } from './transcript';
import { asParagraphs, chainLogStamp, visibleChainLog } from './chain-log';
import type { DreyPluginApi, PluginWidgetContrib } from '../../../shared/plugin-api/renderer';
import {
  ageOf,
  averageDwellMs,
  branchForTicket,
  dwellMs,
  openTicketCount,
  parseHandover,
  spanWords,
  timeOnBoardMs,
  type BoardColumn,
  type BoardSnapshot,
  type CreateResult,
  type MutationResult,
  type TicketCard,
} from '../shared/tickets';
import { createColumnCollapseStore } from './column-collapse';
import { createTicketsSettingsPage } from './settings-page';
import type { ChainStatus, RunInfo } from '../main/fleet/protocol';
import {
  CONTEXT_WARN,
  contextFill,
  DEFAULT_CONTEXT_WINDOW,
  formatTokens,
  lanesOfColumn,
  opensByItself,
  workerStatus,
  type Light,
} from './worker-status';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const PRIORITY_LABEL: Record<TicketCard['meta']['priority'], string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// --- the shared board store (one snapshot, any number of views) --------

let snapshot: BoardSnapshot | null = null;
let busy = false;
let note = '';
let inFlight: Promise<void> | null = null;

interface BoardView {
  readonly root: HTMLElement;
  /** Status-line text for this view ('' hides the line). */
  readonly status: () => string;
  render(): void;
  dispose(): void;
}

const views = new Set<BoardView>();

/** Which phases are folded to their narrow strip (T-0005) — one state
 *  for every view, persisted as pure view state (never in the repo). */
const collapse = createColumnCollapseStore(window.localStorage);

const notifyViews = (): void => {
  for (const view of views) {
    view.render();
  }
};

function refreshBoard(): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }
  busy = true;
  notifyViews();
  inFlight = (async () => {
    try {
      snapshot = (await invokeBoard('board')) as BoardSnapshot;
      // Drop persisted fold state of phases that no longer exist.
      collapse.prune(snapshot.columns.map((column) => column.phase.id));
      note = '';
    } catch (error) {
      note = messageOf(error);
    } finally {
      busy = false;
      inFlight = null;
    }
    notifyViews();
  })();
  return inFlight;
}

/** Runs a mutation: busy line, error surfacing, then a fresh pull.
 *  Returns the backend's result (with `id`/`path` for `create`).
 *  An error keeps its note (no refresh would clear it into view). */
async function runMutation(label: string, invoke: () => Promise<unknown>): Promise<MutationResult> {
  busy = true;
  note = `${label}…`;
  notifyViews();
  let result: MutationResult;
  try {
    result = (await invoke()) as MutationResult;
  } catch (error) {
    result = { ok: false, error: messageOf(error) };
  }
  busy = false;
  if (!result.ok) {
    // A refused action often means the screen is stale (a stop of a run
    // that has already ended): pull the real state, or the lane stays and
    // every click repeats the same refusal.
    await refreshBoard().catch(() => undefined);
    note = result.error ?? 'the action failed';
    notifyViews();
    return result;
  }
  await refreshBoard();
  note = result.warning ?? '';
  notifyViews();
  return result;
}

// `backend` is set in activate(); the helpers above close over it.
let backend: DreyPluginApi['backend'] | null = null;

/** The board's IPC seam — one place, typed; activation precedes every call. */
function invokeBoard(method: string, payload?: unknown): Promise<unknown> {
  if (backend === null) {
    return Promise.reject(new Error('the tickets plugin is not active'));
  }
  return backend.invoke(method, payload);
}

/** Opens a ticket file in the editor (the tickets vault, wherever the
 *  active pane lives — a centre tab like any note). */
function openTicketFile(api: DreyPluginApi, path: string): void {
  if (snapshot?.vaultId != null) {
    void api.documents.open(path, undefined, { vaultId: snapshot.vaultId });
  }
}

/** Outlines the card whose ticket file is the active editor tab. */
function markOpenCard(api: DreyPluginApi): void {
  const active = api.documents.active();
  const path = active !== null && active.vaultId === snapshot?.vaultId ? active.path : null;
  for (const node of document.querySelectorAll<HTMLElement>('.tickets-card')) {
    node.classList.toggle('tickets-card-open', path !== null && node.dataset['path'] === path);
  }
}

// --- drag state (one interaction at a time, shared across views) -------

let draggedId: string | null = null;
let draggedFrom: string | null = null;
let insertPhase: string | null = null;
let insertAt = 0;

// --- the fleet's live runs and the chain (M84/M85, ADR-0075/0077) ----------

const LIVE_RUN_STATES: readonly string[] = ['starting', 'running', 'stopping'];
let fleetRuns: RunInfo[] = [];
let chain: ChainStatus | null = null;

const runForCard = (id: string): RunInfo | null =>
  fleetRuns.find((r) => r.ticketId === id && LIVE_RUN_STATES.includes(r.state)) ?? null;

const liveRuns = (): readonly RunInfo[] =>
  fleetRuns.filter((r) => LIVE_RUN_STATES.includes(r.state));

/** The column's brake state — a phase the runner doesn't know is playing. */
const columnMode = (phaseId: string): 'playing' | 'held' => chain?.columns[phaseId] ?? 'playing';

/** Keeps the header's master switch in step (the buttons live outside the board). */
const masterButtons: { run: HTMLButtonElement; halt: HTMLButtonElement; abort: HTMLButtonElement }[] = [];

const applyChainStatus = (status: ChainStatus | null): void => {
  chain = status;
  const master = status?.master ?? 'halted';
  for (const buttons of masterButtons) {
    buttons.run.classList.toggle('tickets-master-on', master === 'run');
    buttons.halt.classList.toggle('tickets-master-on', master === 'halted');
  }
  notifyViews();
};

/** Open takeover tabs repaint their banner when the fleet snapshot changes. */
const fleetListeners = new Set<() => void>();

/** Runs and their states: the runner moves tickets (git commits in the
 *  tickets repository) when a run starts or ends, without a vault event, so
 *  a change here is the board's cue to pull. */
const runSignature = (runs: readonly RunInfo[]): string =>
  runs.map((r) => `${r.id}:${r.state}`).join('|');
let lastRunSignature: string | null = null;

const applyFleetSnapshot = (payload: { runs?: RunInfo[]; chain?: ChainStatus | null }): void => {
  fleetRuns = Array.isArray(payload.runs) ? [...payload.runs] : [];
  const signature = runSignature(fleetRuns);
  if (lastRunSignature !== null && signature !== lastRunSignature) {
    void refreshBoard();
  }
  lastRunSignature = signature;
  applyChainStatus(payload.chain ?? null);
  for (const listener of fleetListeners) {
    listener();
  }
};

const clearInsert = (): void => {
  for (const marker of document.querySelectorAll('.tickets-insert-above')) {
    marker.classList.remove('tickets-insert-above');
  }
  for (const marker of document.querySelectorAll('.tickets-insert-end')) {
    marker.classList.remove('tickets-insert-end');
  }
  insertPhase = null;
};

const insertionIndex = (list: HTMLElement, y: number): number => {
  const cards = [...list.querySelectorAll(':scope > .tickets-card')] as HTMLElement[];
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i]!.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      return i;
    }
  }
  return cards.length;
};

const markInsert = (list: HTMLElement, phase: string, y: number): void => {
  clearInsert();
  insertPhase = phase;
  insertAt = insertionIndex(list, y);
  const cards = [...list.querySelectorAll(':scope > .tickets-card')] as HTMLElement[];
  if (insertAt < cards.length) {
    cards[insertAt]!.classList.add('tickets-insert-above');
  } else {
    list.classList.add('tickets-insert-end');
  }
};

// --- the board DOM (columns, cards, drag & drop) ------------------------

function cardNode(api: DreyPluginApi, card: TicketCard, column: BoardColumn): HTMLElement {
  const node = el('article', 'tickets-card');
  node.draggable = true;
  node.dataset['id'] = card.id;
  node.dataset['path'] = card.path;
  if (card.pinned) {
    node.classList.add('tickets-pinned');
  }
  if (card.meta.claimedBy !== null) {
    node.classList.add('tickets-claimed');
  }
  if (card.meta.parkedReason !== null) {
    node.classList.add('tickets-parked');
  }

  const top = el('div', 'tickets-card-top');
  top.append(el('span', 'tickets-id', card.id));
  const dot = el('span', `tickets-prio tickets-prio-${card.meta.priority}`);
  dot.title = PRIORITY_LABEL[card.meta.priority];
  top.append(dot);
  if (card.pinned) {
    const pin = el('span', 'tickets-mark');
    pin.title = 'Pinned in order.md — click to unpin';
    pin.classList.add('tickets-mark-btn');
    pin.append(api.ui.icon('pin', 11));
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      void runMutation('Unpinning', () => invokeBoard('unpin', { id: card.id }));
    });
    top.append(pin);
  }
  if (card.issues.length > 0) {
    const badge = el('span', 'tickets-issues', String(card.issues.length));
    const worst = card.issues.some((i) => i.level === 'error')
      ? 'error'
      : card.issues.some((i) => i.level === 'warning')
        ? 'warning'
        : 'noise';
    badge.classList.add(`tickets-issues-${worst}`);
    badge.title = card.issues.map((i) => `[${i.level}] ${i.message}`).join('\n');
    top.append(badge);
  }
  node.append(top);

  node.append(el('div', 'tickets-title', card.meta.title ?? '(untitled)'));

  const meta = el('div', 'tickets-card-meta');
  if (card.meta.repo !== null) {
    meta.append(el('span', 'tickets-chip', card.meta.repo));
  }
  if (card.meta.worker !== null) {
    const pinned = el('span', 'tickets-chip tickets-chip-worker', card.worker);
    pinned.title = `Worker pin — ${card.meta.worker} (falls back to the repo/phase default when empty)`;
    meta.append(pinned);
  }
  const live = runForCard(card.id);
  if (live !== null) {
    const runChip = el('span', 'tickets-chip tickets-chip-run', `▶ ${live.state}`);
    runChip.title = `run ${live.id} (${live.provider}) — ${live.state}; open the card menu to watch, steer or stop`;
    meta.append(runChip);
  }
  const dwell = dwellMs(card, column.phase.id);
  if (dwell !== null) {
    const age = el('span', 'tickets-chip tickets-chip-age', spanWords(dwell));
    const onBoard = timeOnBoardMs(card);
    age.title =
      `In this column for ${spanWords(dwell)}` +
      (onBoard !== null ? ` — on the board for ${spanWords(onBoard)}` : '');
    meta.append(age);
  }
  if (card.meta.parkedReason !== null) {
    const parked = el('span', 'tickets-chip tickets-chip-parked', 'parked');
    parked.title = card.meta.parkedReason;
    meta.append(parked);
  }
  if (card.meta.claimedBy !== null) {
    const claim = el('span', 'tickets-chip tickets-chip-claim', card.meta.claimedBy);
    claim.title = `claimed ${ageOf(card.meta.claimedAt)} ago`;
    claim.append(el('span', 'tickets-age', ageOf(card.meta.claimedAt)));
    meta.append(claim);
  }
  node.append(meta);

  node.title = `${card.id} — ${card.meta.title ?? ''}\n${card.path}\nBranch ${branchForTicket(card.id)}`;

  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${card.id} ${card.meta.title ?? '(untitled)'}`);
  node.addEventListener('click', () => openTicketFile(api, card.path));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === node) {
      event.preventDefault();
      openTicketFile(api, card.path);
    }
  });
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openCardMenu(api, card, event, runMutation, (path) => openTicketFile(api, path));
  });
  node.addEventListener('dragstart', (event) => {
    draggedId = card.id;
    draggedFrom = column.phase.id;
    event.dataTransfer?.setData('text/plain', card.id);
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = 'move';
    }
  });
  node.addEventListener('dragstart', () => node.classList.add('tickets-dragging'));
  node.addEventListener('dragend', () => {
    node.classList.remove('tickets-dragging');
    draggedId = null;
    draggedFrom = null;
    clearInsert();
    for (const col of document.querySelectorAll('.tickets-drop-target')) {
      col.classList.remove('tickets-drop-target');
    }
  });
  return node;
}

/** The column's prompt ref for the pool chip's tooltip. */
const columnPromptRefOf = (phase: BoardColumn['phase']): string =>
  phase.prompt ?? parseHandover(phase.handover).promptRef ?? '(the handover names none)';

/**
 * One column's brakes (M85): pause — no new dispatch, running work
 * finishes; stop — this column's runs abort and the column holds; play
 * — the pool takes the column's next ticket again. Stopping one column
 * never stops the rest.
 */
function columnControlsNode(api: DreyPluginApi, column: BoardColumn): HTMLElement {
  const phaseId = column.phase.id;
  const box = el('span', 'tickets-col-controls');
  const button = (icon: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'tickets-col-btn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', `${title} (${column.phase.title})`);
    b.append(api.ui.icon(icon, 11));
    b.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return b;
  };
  if (columnMode(phaseId) === 'playing') {
    box.append(
      button('pause', 'Pause this column — no new dispatch, running work finishes', () => {
        void runChainAction('chainColumn', { phase: phaseId, mode: 'held' });
      }),
      button('square', "Stop this column — abort its runs and hold it (the rest keeps going)", () => {
        void runChainAction('chainColumnStop', { phase: phaseId });
      }),
    );
  } else {
    box.append(
      button('play', "Play this column — the pool takes the column's next ticket", () => {
        void runChainAction('chainColumn', { phase: phaseId, mode: 'playing' });
      }),
    );
    box.classList.add('tickets-col-controls-held');
  }
  return box;
}

/** Column head / strip count text: plain, or `n/wip` against a limit. */
const countText = (column: BoardColumn): string =>
  column.phase.wip === null
    ? String(column.tickets.length)
    : `${column.tickets.length}/${column.phase.wip}`;

const isOverWip = (column: BoardColumn): boolean =>
  column.phase.wip !== null && column.tickets.length > column.phase.wip;

/** A column folded to its narrow strip (T-0005): the count and the
 *  title rotated 90°, so eight folded phases cost a sliver of width.
 *  One click — or a dragged card hovering it — unfolds the column. */
function collapsedColumnNode(column: BoardColumn): HTMLElement {
  const node = el('section', 'tickets-col tickets-collapsed');
  node.dataset['phase'] = column.phase.id;

  const count = countText(column);
  const strip = el('button', 'tickets-col-strip');
  strip.type = 'button';
  strip.title = `Expand "${column.phase.title}" — ${count} ticket${column.tickets.length === 1 ? '' : 's'}`;
  strip.setAttribute('aria-label', strip.title);
  const countEl = el('span', 'tickets-col-count', count);
  if (isOverWip(column)) {
    countEl.classList.add('tickets-col-over');
  }
  strip.append(countEl, el('span', 'tickets-col-strip-title', column.phase.title));
  const expand = (): void => {
    collapse.setCollapsed(column.phase.id, false);
    notifyViews();
  };
  strip.addEventListener('click', expand);
  strip.addEventListener('dragover', (event) => {
    if (draggedId === null) {
      return;
    }
    event.preventDefault();
    expand(); // unfolding makes the drop target reachable mid-drag
  });
  node.append(strip);
  return node;
}

function columnNode(api: DreyPluginApi, column: BoardColumn): HTMLElement {
  if (collapse.isCollapsed(column.phase.id)) {
    return collapsedColumnNode(column);
  }

  const node = el('section', 'tickets-col');
  node.dataset['phase'] = column.phase.id;
  if (parseHandover(column.phase.handover).mode === 'agent') {
    node.classList.add('tickets-col-pool');
    if (columnMode(column.phase.id) !== 'playing') {
      node.classList.add('tickets-col-held');
    }
  }

  const head = el('div', 'tickets-col-head');
  head.append(el('span', 'tickets-col-title', column.phase.title));
  const count = el('span', 'tickets-col-count', countText(column));
  if (isOverWip(column)) {
    count.classList.add('tickets-col-over');
    count.title = `WIP limit ${column.phase.wip} exceeded`;
  }
  head.append(count);
  if (column.unknown) {
    const mark = el('span', 'tickets-col-unknown', 'not in pipeline');
    mark.title = 'This directory has tickets but pipeline.md does not list it';
    head.append(mark);
  }
  if (snapshot?.checkpoints.includes(column.phase.id) === true) {
    const mark = el('span', 'tickets-col-checkpoint', 'checkpoint');
    mark.title =
      'Owner checkpoint — the machine never pulls across; tickets wait here for your review, your moves feed the next pool';
    head.append(mark);
  }
  if (parseHandover(column.phase.handover).mode === 'agent') {
    const phase = column.phase;
    const worker = phase.worker ?? parseHandover(phase.handover).worker ?? 'opencode';
    const chip = el('span', 'tickets-col-agent', `${worker}${phase.workers > 1 ? ` ×${phase.workers}` : ''}`);
    chip.title =
      `Worker pool — ${worker}` +
      (phase.model !== null ? `, model ${phase.model}` : '') +
      `, ${phase.workers} parallel, prompt ${columnPromptRefOf(phase)}`;
    head.append(chip);
    head.append(columnControlsNode(api, column));
  }
  const fold = el('button', 'tickets-col-fold');
  fold.type = 'button';
  fold.title = 'Collapse column to a strip';
  fold.setAttribute('aria-label', `Collapse the "${column.phase.title}" column`);
  fold.append(api.ui.icon('chevron-left', 12));
  fold.addEventListener('click', () => {
    collapse.setCollapsed(column.phase.id, true);
    notifyViews();
  });
  head.append(fold);
  node.append(head);

  if (parseHandover(column.phase.handover).mode === 'agent') {
    const lanes = workerLanesNode(api, column);
    if (lanes !== null) {
      node.append(lanes);
    }
  }

  const list = el('div', 'tickets-col-list');
  for (const card of column.tickets) {
    list.append(cardNode(api, card, column));
  }
  if (column.tickets.length === 0) {
    list.append(el('div', 'tickets-col-empty', 'No tickets'));
  }
  list.addEventListener('dragover', (event) => {
    if (draggedId === null) {
      return;
    }
    event.preventDefault();
    node.classList.add('tickets-drop-target');
    markInsert(list, column.phase.id, event.clientY);
  });
  list.addEventListener('dragleave', (event) => {
    if (!list.contains(event.relatedTarget as Node | null)) {
      node.classList.remove('tickets-drop-target');
      clearInsert();
    }
  });
  list.addEventListener('drop', (event) => {
    event.preventDefault();
    node.classList.remove('tickets-drop-target');
    const id = draggedId ?? event.dataTransfer?.getData('text/plain') ?? null;
    const from = draggedFrom;
    const phase = insertPhase ?? column.phase.id;
    const index = insertAt;
    draggedId = null;
    draggedFrom = null;
    clearInsert();
    if (id === null || from === null) {
      return;
    }
    if (from === phase) {
      void runMutation('Reordering', () => invokeBoard('reorder', { phase, id, index }));
    } else {
      void runMutation('Moving', () => invokeBoard('transition', { id, from, to: phase, index }));
    }
  });
  node.append(list);
  return node;
}

/** A board view: renders the current snapshot into `root` on demand.
 *  The empty state (no tickets vault) is part of the view — the
 *  guidance shows wherever the board is mounted. */
function buildBoardView(api: DreyPluginApi): BoardView {
  const root = el('div', 'tickets-view');
  /** The visible section survives every re-render: the board's
   *  horizontal scroll and each column's vertical scroll are read before
   *  the DOM is rebuilt and put back afterwards. */
  const restoreScroll = (): (() => void) => {
    const left = root.querySelector<HTMLElement>('.tickets-board')?.scrollLeft ?? 0;
    const tops = new Map<string, number>();
    for (const col of root.querySelectorAll<HTMLElement>('.tickets-col')) {
      const list = col.querySelector<HTMLElement>('.tickets-col-list');
      if (list !== null && col.dataset['phase'] !== undefined) {
        tops.set(col.dataset['phase'], list.scrollTop);
      }
    }
    return () => {
      const board = root.querySelector<HTMLElement>('.tickets-board');
      if (board === null) {
        return;
      }
      board.scrollLeft = left;
      for (const col of board.querySelectorAll<HTMLElement>('.tickets-col')) {
        const top = tops.get(col.dataset['phase'] ?? '');
        const list = col.querySelector<HTMLElement>('.tickets-col-list');
        if (top !== undefined && list !== null) {
          list.scrollTop = top;
        }
      }
    };
  };
  const render = (): void => {
    const restore = restoreScroll();
    try {
      draw();
      markOpenCard(api);
    } finally {
      restore();
    }
  };
  const draw = (): void => {
    root.textContent = '';
    const snap = snapshot;
    if (snap === null) {
      root.append(el('div', 'tickets-empty', 'Loading the board…'));
      return;
    }
    if (snap.vaultId === null) {
      root.append(emptyState(api, snap, runMutation));
      return;
    }
    const summary = fleetSummaryNode();
    if (summary !== null) {
      root.append(summary);
    }
    const board = el('div', 'tickets-board');
    for (const column of snap.columns) {
      board.append(columnNode(api, column));
    }
    root.append(board);
    const metrics = metricsNode(snap);
    if (metrics !== null) {
      root.append(metrics);
    }
    if (!snap.isGitRepo) {
      const warn = el('div', 'tickets-warn');
      warn.textContent =
        'The tickets vault is not a git repository — transitions are not versioned.';
      root.append(warn);
    }
    if (snap.issues.length > 0) {
      const issues = el('div', 'tickets-board-issues');
      issues.textContent = `${snap.issues.length} board issue${snap.issues.length === 1 ? '' : 's'}`;
      issues.title = snap.issues.map((i) => `[${i.level}] ${i.message}`).join('\n');
      root.prepend(issues);
    }
  };
  const view: BoardView = { root, status: () => (busy ? note || 'Loading…' : note), render, dispose: () => undefined };
  render();
  return view;
}

// --- the dock panel -------------------------------------------------------

export function createTicketsWidget(api: DreyPluginApi): PluginWidgetContrib {
  return {
    id: 'tickets',
    title: 'Tickets',
    icon: 'layers',
    defaultDock: 'left',
    defaultOpen: false,
    defaultFlex: 340,
    flush: true,
    status: () => {
      if (snapshot === null || snapshot.vaultId === null) {
        return null;
      }
      const open = openTicketCount(snapshot);
      return open > 0 ? `${open} open` : null;
    },
    headerActions: (host) => {
      const newButton = el('button', 'icon-btn');
      newButton.type = 'button';
      newButton.title = 'New ticket';
      newButton.setAttribute('aria-label', 'New ticket');
      newButton.append(api.ui.icon('plus', 14));
      newButton.addEventListener('click', () => {
        if (snapshot?.vaultId != null) {
          openCreateModal(api, snapshot);
        }
      });

      const refreshButton = el('button', 'icon-btn');
      refreshButton.type = 'button';
      refreshButton.title = 'Refresh the board';
      refreshButton.setAttribute('aria-label', 'Refresh the board');
      refreshButton.append(api.ui.icon('refresh-cw', 14));
      refreshButton.addEventListener('click', () => void refreshBoard());

      host.append(newButton, refreshButton);
      // The chain's master switch — meaningful wherever a tickets board
      // exists; the runner side decides whether anything is automatic.
      host.append(masterControlNode(api));
      return () => undefined;
    },
    mount: (panel) => {
      panel.classList.add('tickets-panel');
      const statusEl = el('div', 'tickets-note');
      const view = buildBoardView(api);
      views.add(view);
      const renderStatus = (): void => {
        statusEl.textContent = view.status();
        statusEl.classList.toggle('tickets-note-busy', busy);
        statusEl.style.display = statusEl.textContent === '' ? 'none' : '';
      };
      const decorated: BoardView = {
        root: view.root,
        status: view.status,
        render: () => {
          view.render();
          renderStatus();
        },
        dispose: view.dispose,
      };
      views.delete(view);
      views.add(decorated);
      panel.append(statusEl, view.root);
      decorated.render();
      return () => {
        views.delete(decorated);
      };
    },
  };
}

// --- the empty state ------------------------------------------------------

function emptyState(
  api: DreyPluginApi,
  snap: BoardSnapshot,
  run: (label: string, invoke: () => Promise<unknown>) => Promise<MutationResult>,
): HTMLElement {
  const box = el('div', 'tickets-empty');
  box.append(el('p', undefined, 'No tickets vault detected.'));
  const how = el('ol', 'tickets-empty-steps');
  for (const step of [
    'Create an empty git repository for tickets (its own repo — ADR-0076).',
    'Register its folder as a vault in the Files panel.',
    'Initialize the tickets board in that vault below.',
  ]) {
    how.append(el('li', undefined, step));
  }
  box.append(how);

  const target = snap.activeVaultName === null ? 'the active vault' : `"${snap.activeVaultName}"`;
  let armed = false;
  const button = el('button', 'tickets-init-btn');
  button.type = 'button';
  button.textContent = `Initialize the tickets board in ${target}`;
  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      button.textContent = `Creates tickets/_meta/{pipeline,order,repos}.md and the default prompts in ${target} — click again`;
      button.classList.add('tickets-init-armed');
      return;
    }
    void run('Initializing', () => invokeBoard('initialize', {}));
  });
  if (snap.activeVaultName === null) {
    button.disabled = true;
    button.title = 'Register a vault first';
  }
  box.append(button);
  return box;
}

// --- the create modal (opens the new file — T-0001) ------------------------

function openCreateModal(api: DreyPluginApi, snap: BoardSnapshot): void {
  const close = api.ui.showModal((host) => {
    const form = el('div', 'tickets-form');
    const title = el('input', 'tickets-form-title') as HTMLInputElement;
    title.type = 'text';
    title.setAttribute('aria-label', 'Title');
    title.spellcheck = true;

    const row = el('div', 'tickets-form-row');
    const priority = el('select') as HTMLSelectElement;
    priority.setAttribute('aria-label', 'Priority');
    for (const [value, label] of Object.entries(PRIORITY_LABEL)) {
      const option = el('option', undefined, label) as HTMLOptionElement;
      option.value = value;
      if (value === 'normal') {
        option.selected = true;
      }
      priority.append(option);
    }
    const repo = el('select') as HTMLSelectElement;
    repo.setAttribute('aria-label', 'Repository');
    const none = el('option', undefined, '(no repo yet)') as HTMLOptionElement;
    none.value = '';
    none.selected = true;
    repo.append(none);
    for (const ref of snap.repos) {
      const option = el('option', undefined, ref.name) as HTMLOptionElement;
      option.value = ref.name;
      repo.append(option);
    }
    if (snap.repos.length === 1) {
      repo.selectedIndex = 1;
    }
    row.append(priority, repo);

    const description = el('textarea', 'tickets-form-desc') as HTMLTextAreaElement;
    description.rows = 4;
    description.setAttribute('aria-label', 'Description');

    const actions = el('div', 'tickets-form-actions');
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => close());
    const create = el('button', 'tickets-form-create', 'Create ticket');
    create.type = 'button';
    const submit = (): void => {
      const text = title.value.trim();
      if (text === '') {
        title.focus();
        return;
      }
      close();
      void runMutation('Creating', () =>
        invokeBoard('create', {
          title: text,
          priority: priority.value,
          repo: repo.value === '' ? null : repo.value,
          description: description.value,
        }),
      ).then((result) => {
        // The file is pre-filled by the canonical writer — open it so
        // everything else can be filled in right away (T-0001).
        if (result.ok && (result as CreateResult).path !== undefined) {
          openTicketFile(api, (result as CreateResult).path as string);
        }
      });
    };
    create.addEventListener('click', submit);
    actions.append(cancel, create);

    const field = (label: string, control: HTMLElement): HTMLElement => {
      const wrap = el('label', 'tickets-form-field');
      wrap.append(el('span', 'tickets-form-label', label), control);
      return wrap;
    };
    const rowFields = el('div', 'tickets-form-row');
    rowFields.append(field('Priority', priority), field('Repository', repo));

    form.append(el('h3', 'tickets-form-heading', 'New ticket'));
    form.append(field('Title', title), rowFields, field('Description', description), actions);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === title) {
        event.preventDefault();
        submit();
      }
      if (event.key === 'Escape') {
        close();
      }
    });
    host.append(form);
    title.focus();
  });
}

// --- the chain's master switch (M85, ADR-0077) -------------------------------

/**
 * An / Aus / Notaus in the panel header. An dispatches every playing
 * automatic column; Aus halts gently (running work finishes); Notaus
 * aborts every live run through the stop ladder and halts — the red
 * button, one click, nothing in the way.
 */
function masterControlNode(api: DreyPluginApi): HTMLElement {
  const box = el('span', 'tickets-master');
  const run = el('button', 'icon-btn');
  run.type = 'button';
  run.title = 'Run the chain — columns with a worker drain themselves';
  run.setAttribute('aria-label', 'Run the chain');
  run.append(api.ui.icon('play', 14));
  run.addEventListener('click', () => void runChainAction('chainMaster', { mode: 'run' }));

  const halt = el('button', 'icon-btn');
  halt.type = 'button';
  halt.title = 'Halt the chain — running work finishes, nothing new dispatches';
  halt.setAttribute('aria-label', 'Halt the chain');
  halt.append(api.ui.icon('pause', 14));
  halt.addEventListener('click', () => void runChainAction('chainMaster', { mode: 'halted' }));

  const abort = el('button', 'icon-btn tickets-master-abort');
  abort.type = 'button';
  abort.title = 'Emergency stop — abort every run and halt the chain';
  abort.setAttribute('aria-label', 'Emergency stop');
  abort.append(api.ui.icon('triangle-alert', 14));
  abort.addEventListener('click', () => void runChainAction('chainAbort', {}));

  const chainLog = el('button', 'icon-btn');
  chainLog.type = 'button';
  chainLog.title = 'Chain log — what the fleet daemon did (dispatches, skips, gates), as a readonly editor tab';
  chainLog.setAttribute('aria-label', 'Chain log');
  chainLog.textContent = 'Log';
  chainLog.addEventListener('click', () => openChainLog(api));

  masterButtons.push({ run, halt, abort });
  box.append(run, halt, abort, chainLog);
  return box;
}

/** Runs a chain control and applies the runner's returned state. */
async function runChainAction(method: string, payload: unknown): Promise<void> {
  let result: unknown;
  try {
    result = await invokeBoard(method, payload);
  } catch (error) {
    note = messageOf(error);
    notifyViews();
    return;
  }
  const status = (result as { status?: ChainStatus; error?: string }).status ?? null;
  if (status === null) {
    note = (result as { error?: string }).error ?? 'the chain control failed';
    notifyViews();
    return;
  }
  applyChainStatus(status);
}

// --- the fleet run controls (M84, ADR-0075) --------------------------------

const WORKER_LABEL: ReadonlyArray<readonly [string, string]> = [
  ['opencode', 'OpenCode'],
  ['claude-code', 'Claude Code'],
];

/**
 * The cycle-time line (M85): each non-empty column's average dwell,
 * read from the tickets' entered-* stamps — shown beside the fleet's
 * run stats so a stuck column is visible at a glance.
 */
function metricsNode(snap: BoardSnapshot): HTMLElement | null {
  const now = Date.now();
  const parts: string[] = [];
  for (const column of snap.columns) {
    if (column.tickets.length === 0) {
      continue;
    }
    const avg = averageDwellMs(column.tickets, column.phase.id, now);
    parts.push(`${column.phase.title} ${avg === null ? '–' : `⌀${spanWords(avg)}`}`);
  }
  if (parts.length === 0) {
    return null;
  }
  const line = el('div', 'tickets-metrics', parts.join(' · '));
  line.title =
    'Average time this column\'s tickets have been sitting there (from the entered-* stamps)';
  return line;
}

/** The pills above the board: lights of the whole fleet and today's spend. */
function fleetSummaryNode(): HTMLElement | null {
  const runs = liveRuns();
  if (runs.length === 0) {
    return null;
  }
  const now = Date.now();
  const lights = runs.map((run) => workerStatus(run, now).light);
  const count = (light: Light): number => lights.filter((l) => l === light).length;
  const bar = el('div', 'tickets-summary');
  const pill = (light: Light | null, text: string, extra = ''): void => {
    const p = el('span', `tickets-pill${extra}`);
    if (light !== null) {
      p.append(el('span', `tickets-light tickets-light-${light}`));
    }
    p.append(document.createTextNode(text));
    bar.append(p);
  };
  pill('green', `${count('green')} running`);
  if (count('idle') > 0) {
    pill('idle', `${count('idle')} standing`);
  }
  if (count('amber') > 0) {
    pill('amber', `${count('amber')} need attention`);
  }
  if (count('red') > 0) {
    pill('red', `${count('red')} stalled`);
  }
  const tokens = runs.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0);
  pill(null, `${formatTokens(tokens)} tokens in flight`, ' tickets-pill-mono');
  return bar;
}

/** Lanes the owner folded or unfolded by hand; a lane without an entry follows its light. */
const laneOpen = new Map<string, boolean>();

/**
 * The worker lanes of one working column (the board redesign): a header
 * line with the pool's lights and, per live run, a lane that folds down
 * to one status line — light, state in words, ticket, context fill —
 * and unfolds to what the worker is doing, its context window, its
 * token spend and the controls. A lane that needs a look (amber, red)
 * is open until the owner folds it.
 */
function workerLanesNode(api: DreyPluginApi, column: BoardColumn): HTMLElement | null {
  // A detached run (the runner restarted while its worker lived on) keeps
  // its ticket blocked until it is stopped, so it gets a lane with a Stop.
  const runs = lanesOfColumn(
    fleetRuns.filter((r) => LIVE_RUN_STATES.includes(r.state) || r.state === 'detached'),
    column.phase.id,
  );
  const slots = column.phase.workers;
  if (runs.length === 0 && slots <= 0) {
    return null;
  }
  const now = Date.now();
  const strip = el('div', 'tickets-lanes');

  const statuses = runs.map((run) => workerStatus(run, now));
  const worst: Light = statuses.some((s) => s.light === 'red')
    ? 'red'
    : statuses.some((s) => s.light === 'amber')
      ? 'amber'
      : statuses.some((s) => s.light === 'green')
        ? 'green'
        : 'idle';
  const head = el('div', 'tickets-lanes-head');
  head.append(
    el('span', `tickets-light tickets-light-${runs.length === 0 ? 'idle' : worst}`),
    el('span', 'tickets-lanes-title', 'Workers'),
    el('span', 'tickets-lanes-count', `${runs.filter((r) => r.state !== 'detached').length} of ${slots} busy`),
  );
  strip.append(head);

  runs.forEach((run, index) => {
    const status = statuses[index]!;
    const open = laneOpen.get(run.id) ?? opensByItself(status);
    const fill = contextFill(run);
    const fillWarn = fill !== null && fill >= CONTEXT_WARN;
    const lane = el('div', `tickets-lane tickets-lane-${status.light}`);
    lane.classList.toggle('tickets-lane-open', open);

    const summary = el('button', 'tickets-lane-summary');
    summary.type = 'button';
    summary.setAttribute('aria-expanded', String(open));
    summary.title = open ? 'Fold the lane' : 'Unfold the lane';
    const chevron = el('span', 'tickets-lane-chevron');
    chevron.append(api.ui.icon(open ? 'chevron-down' : 'chevron-right', 11));
    summary.append(
      chevron,
      el('span', `tickets-light tickets-light-${status.light}`),
      el('span', `tickets-lane-state tickets-lane-state-${status.light}`, status.label),
      el('span', 'tickets-lane-ticket', run.ticketId),
    );
    if (fill !== null && !open) {
      const mini = el('span', 'tickets-lane-mini');
      const miniBar = el('span', 'tickets-meter');
      const miniFill = el('span', `tickets-meter-fill tickets-meter-${fillWarn ? 'amber' : 'green'}`);
      miniFill.style.width = `${Math.round(fill * 100)}%`;
      miniBar.append(miniFill);
      mini.append(miniBar, el('span', 'tickets-lane-pct', `${Math.round(fill * 100)}%`));
      summary.append(mini);
    }
    summary.addEventListener('click', () => {
      laneOpen.set(run.id, !open);
      notifyViews();
    });
    lane.append(summary);

    if (open) {
      const body = el('div', 'tickets-lane-body');
      const activity = run.activity ?? '';
      const act = el(
        'div',
        'tickets-lane-activity',
        run.state === 'detached'
          ? 'The runner restarted while this worker lived on — stop the run to free the ticket'
          : activity !== ''
            ? activity
            : 'No output yet',
      );
      act.title = activity;
      body.append(act);

      const used = run.contextTokens ?? null;
      const label = el(
        'div',
        'tickets-lane-context-row',
        used === null
          ? 'Context — not reported yet'
          : `Context ${formatTokens(used)} / ${formatTokens(DEFAULT_CONTEXT_WINDOW)} · ${Math.round((fill ?? 0) * 100)}%`,
      );
      const bar = el('div', 'tickets-meter');
      const barFill = el('div', `tickets-meter-fill tickets-meter-${fillWarn ? 'amber' : 'green'}`);
      barFill.style.width = `${Math.round((fill ?? 0) * 100)}%`;
      bar.append(barFill);
      body.append(label, bar);

      const tokens = el('div', 'tickets-lane-tokens');
      tokens.append(
        el('span', undefined, `in ${formatTokens(run.tokensIn)}`),
        el('span', undefined, `out ${formatTokens(run.tokensOut)}`),
      );
      if (run.costUsd !== null && run.costUsd > 0) {
        tokens.append(el('span', undefined, `$${run.costUsd.toFixed(2)}`));
      }
      const age = ageOf(run.startedAt);
      if (age !== '') {
        tokens.append(el('span', undefined, age));
      }
      body.append(tokens);

      const actions = el('div', 'tickets-lane-actions');
      const button = (icon: string, title: string, onClick: () => void): void => {
        const b = el('button', 'tickets-col-btn');
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', `${title} (${run.ticketId})`);
        b.append(api.ui.icon(icon, 12));
        b.addEventListener('click', onClick);
        actions.append(b);
      };
      button('arrow-right', 'Open the run — its conversation, controls and prompt (nothing changes until you send a command)', () => {
        openTakeover(api, run);
      });
      if (run.state === 'detached' && run.sessionRef !== null) {
        button('rotate-ccw', 'Resume the session in a new worker — the run is attached again', () => {
          void runMutation('Resuming', () => invokeBoard('fleetControl', { action: 'resume', runId: run.id }));
        });
      }
      button('square', run.state === 'detached' ? 'Stop the run — frees the ticket (the worker is killed if it still lives)' : 'Kill the worker (the ticket stays in its phase)', () => {
        void runMutation('Stopping the run', () => invokeBoard('fleetStop', { runId: run.id, reason: null }));
      });
      body.append(actions);
      lane.append(body);
    }
    strip.append(lane);
  });
  return strip;
}

function openRunModal(api: DreyPluginApi, card: TicketCard): void {
  const close = api.ui.showModal((host) => {
    const form = el('div', 'tickets-form');
    form.append(el('h3', 'tickets-form-heading', `Run ${card.id} — ${card.meta.title ?? '(untitled)'}`));

    const field = (label: string, control: HTMLElement): HTMLElement => {
      const wrap = el('label', 'tickets-form-field');
      wrap.append(el('span', 'tickets-form-label', label), control);
      return wrap;
    };
    const worker = el('select') as HTMLSelectElement;
    worker.setAttribute('aria-label', 'Worker');
    for (const [value, label] of WORKER_LABEL) {
      const option = el('option', undefined, label) as HTMLOptionElement;
      option.value = value;
      if (value === card.worker.split('/')[0]) {
        option.selected = true;
      }
      worker.append(option);
    }
    const permission = el('select') as HTMLSelectElement;
    permission.setAttribute('aria-label', 'Permissions');
    for (const [value, label] of [
      ['accept-edits', 'Accept edits (asks before commands)'],
      ['bypass', 'Bypass permissions (unattended)'],
    ] as const) {
      const option = el('option', undefined, label) as HTMLOptionElement;
      option.value = value;
      if (value === 'accept-edits') {
        option.selected = true;
      }
      permission.append(option);
    }
    const rowFields = el('div', 'tickets-form-row');
    rowFields.append(field('Worker', worker), field('Permissions', permission));

    const hint = el(
      'p',
      'tickets-form-hint',
      'The instruction is composed from the ticket (description, plan, acceptance criteria) plus the phase handover’s prompt. ' +
        'On a green machine gate the runner moves the ticket to the next phase.',
    );

    const actions = el('div', 'tickets-form-actions');
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => close());
    const start = el('button', 'tickets-form-create', 'Start run');
    start.type = 'button';
    start.addEventListener('click', () => {
      const workerValue = worker.value;
      close();
      void runMutation('Starting the run', () =>
        invokeBoard('fleetStart', {
          id: card.id,
          worker: workerValue,
          permissionMode: permission.value,
        }),
      );
    });
    actions.append(cancel, start);

    form.append(rowFields, hint, actions);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
      }
    });
    host.append(form);
    worker.focus();
  });
}

// --- the takeover tab (owner request, follow-up of M86; ADR-0078) -------------

const TAKEOVER_KIND = 'tickets-takeover';
const TAKEOVER_SCHEME = 'takeover://';

/** The largest file the prompt box attaches (the runner enforces the same). */
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

/** Short notes for the commands both workers share; others show their name only. */
const COMMAND_HINTS: Readonly<Record<string, string>> = {
  compact: 'Summarise the conversation to free context',
  clear: 'Start over with an empty context',
  context: 'Show what fills the context window',
  cost: 'Show the session cost',
  init: 'Write a CLAUDE.md for the project',
  review: 'Review the changes',
  help: 'List the available commands',
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** One-click starters for the takeover prompt box: a label and the text it fills in. */
const QUICK_PROMPTS: ReadonlyArray<readonly [string, string]> = [
  ['Continue', 'Continue where you left off.'],
  ['Status', 'Briefly summarise what you have done so far and what is left.'],
  ['Run checks', "Run the ticket's acceptance checks now and report the result."],
  ['Wrap up', 'Wrap up: finish the current step, update the ticket Log, and stop.'],
];

/** Opens (or focuses) the takeover tab of one run. */
function openTakeover(api: DreyPluginApi, run: RunInfo): void {
  api.documents.addDoc(TAKEOVER_KIND, `${TAKEOVER_SCHEME}${run.id}`, takeoverTitle(run));
}

function takeoverTitle(run: RunInfo): string {
  return `${run.ticketId} · ${run.provider}`;
}

/**
 * The tab body: the worker's transcript in the host's read-only Markdown
 * view (rendered from the run's normalized stream, so the same for every
 * worker), a prompt box in the compact view below it, and the controls —
 * interrupt the running turn (the session stays), hand the run back.
 */
function mountTakeover(api: DreyPluginApi, host: HTMLElement, runId: string): () => void {
  const wrap = el('div', 'tickets-takeover');

  const banner = el('div', 'tickets-takeover-banner');
  const light = el('span', 'tickets-light');
  const headline = el('span', 'tickets-takeover-headline');
  const stats = el('span', 'tickets-takeover-stats');
  const spacer = el('span', 'tickets-takeover-spacer');
  const controls = el('span', 'tickets-takeover-controls');
  const iconButton = (icon: string, label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'tickets-takeover-btn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(api.ui.icon(icon, 13), document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  };
  const control = (action: 'interrupt' | 'release' | 'resume'): void => {
    void runMutation(
      action === 'interrupt' ? 'Interrupting' : action === 'resume' ? 'Resuming' : 'Handing back',
      () => invokeBoard('fleetControl', { action, runId }),
    );
  };
  const resumeBtn = iconButton('rotate-ccw', 'Resume session', 'Pick this session up again in a new worker — it answers, then waits for your prompts', () => {
    void runMutation('Resuming', () => invokeBoard('fleetControl', { action: 'resume', runId })).then((result) => {
      const resumed = (result as { run?: RunInfo }).run;
      if (result.ok && resumed !== undefined) {
        openTakeover(api, resumed);
      }
    });
  });
  const releaseBtn = iconButton('arrow-left', 'Hand back', 'Hand the run back to the runner — an idle worker ends the run and the gate decides', () =>
    control('release'),
  );
  controls.append(resumeBtn, releaseBtn);
  banner.append(light, headline, stats, spacer, controls);

  const transcript = api.ui.createMarkdownView({ mode: 'view', readOnly: true, content: '' });
  transcript.element.classList.add('tickets-takeover-transcript');

  const promptWrap = el('div', 'tickets-takeover-prompt');
  // Files and pictures for the worker: stored in its worktree, named in the message.
  const attached: { name: string; path: string }[] = [];
  const attachRow = el('div', 'tickets-takeover-attached');
  attachRow.hidden = true;
  const paintAttached = (): void => {
    attachRow.replaceChildren();
    for (const [index, file] of attached.entries()) {
      const chip = el('span', 'tickets-takeover-attachment');
      chip.title = file.path;
      const drop = el('button', 'tickets-takeover-attachment-x', '×');
      drop.type = 'button';
      drop.title = 'Remove from the message';
      drop.setAttribute('aria-label', `Remove ${file.name}`);
      drop.addEventListener('click', () => {
        attached.splice(index, 1);
        paintAttached();
        paintBanner();
      });
      chip.append(document.createTextNode(file.name), drop);
      attachRow.append(chip);
    }
    attachRow.hidden = attached.length === 0;
  };
  const addFiles = async (files: Iterable<File>): Promise<void> => {
    for (const file of files) {
      if (file.size > MAX_ATTACH_BYTES) {
        note = `${file.name} is larger than ${MAX_ATTACH_BYTES / 1024 / 1024} MB`;
        notifyViews();
        continue;
      }
      const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      const name = file.name !== '' ? file.name : `pasted.${(file.type.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '')}`;
      const result = (await invokeBoard('fleetAttach', { runId, name, data })) as { ok?: boolean; error?: string; path?: string };
      if (result.ok === true && typeof result.path === 'string') {
        attached.push({ name, path: result.path });
      } else {
        note = result.error ?? `${name} could not be attached`;
        notifyViews();
      }
    }
    paintAttached();
    paintBanner();
  };

  const send = async (text: string, interruptFirst: boolean): Promise<void> => {
    const typed = text.trim();
    if (typed === '' && attached.length === 0) {
      return;
    }
    // A slash command stays a command: attachments ride after it as plain text.
    const message =
      attached.length === 0
        ? typed
        : `${typed === '' ? 'See the attached files.' : typed}\n\nAttached files:\n${attached.map((a) => `- ${a.path}`).join('\n')}`;
    if (interruptFirst) {
      // An idle worker refuses the interrupt — the message still goes out.
      await invokeBoard('fleetControl', { action: 'interrupt', runId });
    }
    const result = await runMutation('Sending', () => invokeBoard('fleetSend', { runId, text: message }));
    if (result.ok) {
      prompt.setContent('');
      attached.length = 0;
      paintAttached();
      prompt.focus();
    }
  };

  // "/" lists the commands the worker accepts; anything typed goes through as it is.
  const commandMenu = el('div', 'tickets-takeover-commands');
  commandMenu.hidden = true;
  const paintCommands = (text: string): void => {
    const match = /^\/([\w.-]*)$/.exec(text);
    const known = live()?.commands ?? [];
    const shown = match === null ? [] : known.filter((name) => name.toLowerCase().startsWith(match[1]!.toLowerCase())).slice(0, 12);
    commandMenu.replaceChildren();
    for (const name of shown) {
      const item = el('button', 'tickets-takeover-command');
      item.type = 'button';
      item.append(el('span', 'tickets-takeover-command-name', `/${name}`), el('span', 'tickets-takeover-command-hint', COMMAND_HINTS[name] ?? ''));
      item.addEventListener('click', () => {
        prompt.setContent(`/${name} `);
        commandMenu.hidden = true;
        prompt.focus();
      });
      commandMenu.append(item);
    }
    commandMenu.hidden = shown.length === 0;
  };
  const prompt = api.ui.createMarkdownView({
    compact: true,
    placeholder: 'Message the worker — type / for commands',
    onChange: (text) => {
      paintCommands(text);
      paintBanner();
    },
    onSubmit: (text) => {
      commandMenu.hidden = true;
      void send(text, false);
    },
  });
  prompt.element.classList.add('tickets-takeover-prompt-input');

  const composerBar = el('div', 'tickets-takeover-composer');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const picked = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void addFiles(picked);
  });
  const plusBtn = el('button', 'tickets-takeover-plus');
  plusBtn.type = 'button';
  plusBtn.title = 'Attach files or pictures — the worker reads them from its worktree';
  plusBtn.setAttribute('aria-label', 'Attach files');
  plusBtn.append(api.ui.icon('plus', 15));
  plusBtn.addEventListener('click', () => fileInput.click());
  promptWrap.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files') === true) {
      event.preventDefault();
    }
  });
  promptWrap.addEventListener('drop', (event) => {
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length > 0) {
      event.preventDefault();
      void addFiles(dropped);
    }
  });
  promptWrap.addEventListener(
    'paste',
    (event) => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (pasted.length > 0) {
        event.preventDefault();
        void addFiles(pasted);
      }
    },
    true,
  );
  const chips = el('span', 'tickets-takeover-chips');
  for (const [label, text] of QUICK_PROMPTS) {
    const chip = el('button', 'tickets-takeover-chip', label);
    chip.type = 'button';
    chip.title = `Puts "${text}" in the box — edit it, then send`;
    chip.addEventListener('click', () => {
      prompt.setContent(text);
      prompt.focus();
    });
    chips.append(chip);
  }
  const composerSpacer = el('span', 'tickets-takeover-spacer');
  const stopBtn = iconButton('square', 'Stop', 'Stop the running turn — the session and its context stay, you can prompt it again', () =>
    control('interrupt'),
  );
  stopBtn.classList.add('tickets-takeover-btn-stop');
  const sendBtn = iconButton('corner-down-left', 'Send', 'Send the message — a working worker takes it into its turn', () => {
    void send(prompt.getContent(), false);
  });
  sendBtn.classList.add('tickets-takeover-btn-primary');
  composerBar.append(plusBtn, fileInput, chips, composerSpacer, stopBtn, sendBtn);

  // The worker's pulse while a turn runs: what it does now and for how long.
  const progress = el('div', 'tickets-takeover-progress');
  progress.hidden = true;
  const spinner = el('span', 'tickets-takeover-spinner', '✻');
  const progressText = el('span', 'tickets-takeover-progress-text');
  progress.append(spinner, progressText);
  let busySince: number | null = null;
  const paintProgress = (): void => {
    const run = live();
    const working = run !== null && LIVE_RUN_STATES.includes(run.state) && run.turn !== 'idle';
    if (!working) {
      busySince = null;
      progress.hidden = true;
      return;
    }
    busySince ??= run.steerCount === 0 && run.turn === undefined ? Date.parse(run.startedAt) || Date.now() : Date.now();
    const seconds = Math.max(0, Math.round((Date.now() - busySince) / 1000));
    const doing = (run.activity ?? '').trim();
    const verb = doing === '' || run.activity === undefined ? 'Thinking' : doing.length > 70 ? `${doing.slice(0, 69)}…` : doing;
    progressText.textContent = `${verb}… ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`} · ↓ ${formatTokens(run.tokensOut)} tokens`;
    progress.hidden = false;
  };
  promptWrap.prepend(progress);
  promptWrap.append(commandMenu, attachRow, prompt.element, composerBar);

  const live = (): RunInfo | null => fleetRuns.find((r) => r.id === runId) ?? null;
  const paintBanner = (): void => {
    const run = live();
    const active = run !== null && LIVE_RUN_STATES.includes(run.state);
    const held = active && run.held === true;
    const detached = run !== null && run.state === 'detached';
    const status = run === null ? null : workerStatus(run, Date.now());
    light.className = `tickets-light tickets-light-${(active || detached) && status !== null ? status.light : 'idle'}`;
    headline.textContent =
      run === null
        ? 'This run is no longer known to the runner'
        : detached
          ? `${run.ticketId} · ${run.provider} — detached: the runner lost its worker`
          : !active
            ? `${run.ticketId} · ${run.provider} — run ${run.state}`
            : held
              ? `${run.ticketId} · ${run.provider} — you have control`
              : `${run.ticketId} · ${run.provider} — the runner is driving; your first command takes over`;
    const fill = run === null ? null : contextFill(run);
    stats.textContent =
      run === null
        ? ''
        : [
            status !== null && (active || detached) ? status.label : '',
            fill === null ? '' : `context ${Math.round(fill * 100)}%`,
            `in ${formatTokens(run.tokensIn)} · out ${formatTokens(run.tokensOut)}`,
          ]
            .filter((part) => part !== '')
            .join(' · ');
    resumeBtn.hidden = !(run !== null && !active && run.sessionRef !== null);
    releaseBtn.hidden = !held;
    prompt.setReadOnly(!active);
    const busy = active && run.turn !== 'idle';
    wrap.dataset['state'] =
      !active && !detached
        ? 'ended'
        : detached || status?.light === 'red'
          ? 'alert'
          : status?.light === 'amber'
            ? 'warn'
            : held
              ? busy
                ? 'driving'
                : 'waiting'
              : 'working';
    stopBtn.hidden = !busy;
    sendBtn.hidden = busy && prompt.getContent().trim() === '' && attached.length === 0;
    sendBtn.disabled = !active;
    plusBtn.disabled = !active;
    for (const chip of chips.children) {
      (chip as HTMLButtonElement).disabled = !active;
    }
    paintProgress();
  };

  let lastMarkdown = '\u0000';
  let alive = true;
  const pull = (): void => {
    void invokeBoard('fleetStream', { runId }).then((result) => {
      if (!alive) {
        return;
      }
      const markdown = transcriptMarkdown((result as { text?: string }).text ?? '');
      const shown = markdown === '' ? '_The stream is empty so far._' : markdown;
      if (shown !== lastMarkdown) {
        lastMarkdown = shown;
        transcript.setContent(shown);
      }
    });
  };

  fleetListeners.add(paintBanner);
  paintBanner();
  pull();
  const timer = setInterval(pull, 2_000);
  const tick = setInterval(paintBanner, 1_000);
  wrap.append(banner, transcript.element, promptWrap);
  host.append(wrap);
  return () => {
    alive = false;
    clearInterval(timer);
    clearInterval(tick);
    fleetListeners.delete(paintBanner);
    transcript.dispose();
    prompt.dispose();
  };
}

/**
 * The fleet daemon's chain log as a readonly editor tab: the same lines
 * land in `<userData>/plugins/fleet/runner.log` (T-0007 review finding 2).
 */
const CHAIN_LOG_KIND = 'tickets-chain-log';
const CHAIN_LOG_KEY = 'chain-log://fleet-daemon';

/** Lines stamped at or before this instant are hidden ("Clear"); the
 *  daemon's ring buffer and runner.log on disk stay untouched. */
let chainLogClearedAt = '';

/** Opens (or focuses) the fleet daemon's log tab. */
function openChainLog(api: DreyPluginApi): void {
  api.documents.addDoc(CHAIN_LOG_KIND, CHAIN_LOG_KEY, 'Fleet daemon log');
}

/**
 * The log's pane body: a readonly tail that follows the bottom while the
 * view is scrolled down. Scrolling up pauses the follow; scrolling back
 * to the bottom resumes it — the terminal behavior (owner ruling).
 */
function mountChainLog(api: DreyPluginApi, host: HTMLElement): () => void {
  const wrap = el('div', 'tickets-chain-log');
  const bar = el('div', 'tickets-chain-log-bar');
  const hint = el('div', 'tickets-chain-log-hint');
  hint.textContent =
    'Also on disk as <userData>/plugins/fleet/runner.log — follows the tail while you are at the bottom; scroll up to hold, back down to resume.';
  const clear = el('button', 'icon-btn');
  clear.type = 'button';
  clear.title = 'Clear the view — only lines logged from now on are shown (the file on disk is kept)';
  clear.setAttribute('aria-label', 'Clear log');
  clear.textContent = 'Clear';
  bar.append(hint, clear);
  let lastText = '';
  // The host's own Markdown editor, read-only: the log is one fenced block,
  // and the view itself follows the tail while it is scrolled to the bottom.
  const view = api.ui.createMarkdownView({ mode: 'view', readOnly: true, content: asParagraphs('Loading the daemon log…') });
  view.element.classList.add('tickets-chain-log-out');
  let alive = true;
  const pull = (): void => {
    void invokeBoard('fleetLog').then((result) => {
      if (!alive) {
        return;
      }
      lastText = (result as { text?: string }).text ?? '';
      render();
    });
  };
  const render = (): void => {
    const text = visibleChainLog(lastText, chainLogClearedAt);
    view.setContent(
      asParagraphs(
        text === ''
          ? chainLogClearedAt === ''
            ? '(the daemon has not logged anything yet)'
            : '(cleared — new lines appear here)'
          : text,
      ),
    );
  };
  clear.addEventListener('click', () => {
    const stamps = lastText.split('\n').map(chainLogStamp).filter((x) => x !== '');
    const newest = stamps[stamps.length - 1];
    if (newest !== undefined) {
      chainLogClearedAt = newest;
    }
    render();
  });
  pull();
  const timer = setInterval(pull, 2_000);
  wrap.append(bar, view.element);
  host.append(wrap);
  return () => {
    alive = false;
    clearInterval(timer);
    view.dispose();
  };
}

// --- the card context menu ----------------------------------------------------

function openCardMenu(
  api: DreyPluginApi,
  card: TicketCard,
  event: MouseEvent,
  run: (label: string, invoke: () => Promise<unknown>) => Promise<MutationResult>,
  openFile: (path: string) => void,
): void {
  for (const other of document.querySelectorAll('.tickets-menu')) {
    other.remove();
  }
  const menu = el('div', 'tickets-menu');
  const item = (label: string, onClick: () => void, disabled = false): void => {
    const button = el('button', 'tickets-menu-item', label);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', () => {
      menu.remove();
      onClick();
    });
    menu.append(button);
  };

  item('Open ticket file', () => openFile(card.path));
  item(`Copy branch (${branchForTicket(card.id)})`, () => {
    void navigator.clipboard.writeText(branchForTicket(card.id));
  });
  {
    // T-0004: jump to the work checkout to test the ticket. Needs the
    // ticket's repo AND a local `path:` for it in _meta/repos.md.
    const repoPath =
      card.meta.repo === null
        ? null
        : snapshot?.repos.find((r) => r.name === card.meta.repo)?.path ?? null;
    const reason =
      card.meta.repo === null
        ? 'This ticket names no repository'
        : repoPath === null
          ? `No local "path:" for "${card.meta.repo}" in _meta/repos.md`
          : null;
    const button = el(
      'button',
      'tickets-menu-item',
      reason === null ? `Open work folder in terminal (${repoPath})` : 'Open work folder in terminal',
    );
    button.type = 'button';
    button.disabled = reason !== null;
    button.title = reason ?? `Opens a terminal at ${repoPath}`;
    button.addEventListener('click', () => {
      menu.remove();
      if (card.meta.repo !== null) {
        void runMutation('Opening terminal', () =>
          invokeBoard('openRepoFolder', { repo: card.meta.repo }),
        );
      }
    });
    menu.append(button);
  }
  if (card.pinned) {
    item('Unpin from order', () => {
      void run('Unpinning', () => invokeBoard('unpin', { id: card.id }));
    });
  }
  menu.append(el('div', 'tickets-menu-sep'));
  const live = runForCard(card.id);
  if (live === null) {
    item(`Run agent (${card.worker})…`, () => openRunModal(api, card));
  } else {
    item(`Open run — ${live.state}`, () => openTakeover(api, live));
    item('Stop run', () => {
      void run('Stopping the run', () => invokeBoard('fleetStop', { runId: live.id, reason: null }));
    });
  }
  // Earlier runs of this ticket (other columns, finished or stopped): their
  // transcripts stay on disk, and the takeover tab shows them read-only.
  const past = fleetRuns
    .filter((r) => r.ticketId === card.id && !LIVE_RUN_STATES.includes(r.state))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 8);
  for (const earlier of past) {
    const when = earlier.startedAt.replace('T', ' ').slice(0, 16);
    item(`Past run — ${earlier.column ?? earlier.provider} · ${earlier.state} · ${when}`, () =>
      openTakeover(api, earlier),
    );
  }
  menu.append(el('div', 'tickets-menu-sep'));
  item(
    'Take over claim',
    () => {
      void run('Taking over', () => invokeBoard('claim', { id: card.id, mode: 'takeover' }));
    },
    card.meta.claimedBy !== null && card.meta.claimedBy.startsWith('owner@'),
  );
  item(
    'Release claim',
    () => {
      void run('Releasing', () => invokeBoard('claim', { id: card.id, mode: 'release' }));
    },
    card.meta.claimedBy === null,
  );
  menu.append(el('div', 'tickets-menu-sep'));
  {
    // T-0041: archive instead of delete — armed two-step, so a single
    // click never sends a ticket to tickets/archive/. The first click
    // only relabels; the menu closing disarms.
    const button = el('button', 'tickets-menu-item', 'Archive…');
    button.type = 'button';
    button.title = 'Moves the ticket to tickets/archive/ — out of the board, kept in git';
    let armed = false;
    button.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Archive — click again';
        return;
      }
      menu.remove();
      void run('Archiving', () => invokeBoard('archive', { id: card.id }));
    });
    menu.append(button);
  }

  menu.setAttribute('role', 'menu');
  document.body.append(menu);
  menu.querySelector<HTMLButtonElement>('.tickets-menu-item:not(:disabled)')?.focus();
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;

  const closeMenu = (e: Event): void => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      window.removeEventListener('mousedown', closeMenu, true);
    }
  };
  window.addEventListener('mousedown', closeMenu, true);
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      menu.remove();
      window.removeEventListener('mousedown', closeMenu, true);
    }
  });
}

// --- activation -------------------------------------------------------------

const plugin: { activate(api: DreyPluginApi): void } = {
  activate(api) {
    backend = api.backend;
    api.ui.registerWidget(createTicketsWidget(api));
    api.ui.registerSettingsPage(createTicketsSettingsPage(api));

    // The fleet daemon's chain log: a readonly, tail-following editor tab
    // (T-0007 review finding 2). Stateless — the session snapshot reopens
    // it from the fixed key.
    api.ui.registerDocKind({
      kind: CHAIN_LOG_KIND,
      icon: 'scroll-text',
      serialize: () => null,
      restore: () => openChainLog(api),
      mount: (el) => mountChainLog(api, el),
      statusText: () => 'fleet daemon',
    });

    api.ui.registerDocKind({
      kind: TAKEOVER_KIND,
      icon: 'message-circle',
      // The title rides in the session (req-51): a restore runs before the
      // first fleet snapshot arrives, and the tab used to be dropped for
      // want of its run. The banner fills in once the runner answers.
      serialize: (path) => {
        const run = fleetRuns.find((r) => r.id === path.slice(TAKEOVER_SCHEME.length));
        return run === undefined ? null : { title: takeoverTitle(run) };
      },
      restore: (path, data) => {
        const runId = path.startsWith(TAKEOVER_SCHEME) ? path.slice(TAKEOVER_SCHEME.length) : '';
        const run = fleetRuns.find((r) => r.id === runId);
        const saved = (data as { title?: unknown } | null)?.title;
        const title = run !== undefined ? takeoverTitle(run) : typeof saved === 'string' ? saved : null;
        if (runId !== '' && title !== null) {
          api.documents.addDoc(TAKEOVER_KIND, `${TAKEOVER_SCHEME}${runId}`, title);
        }
      },
      mount: (el, path) => mountTakeover(api, el, path.slice(TAKEOVER_SCHEME.length)),
      statusText: (path) => {
        const run = fleetRuns.find((r) => r.id === path.slice(TAKEOVER_SCHEME.length));
        return run === undefined ? null : run.held === true ? 'you have control' : 'runner driving';
      },
    });

    api.documents.onChange((event) => {
      if (event.type === 'active-changed' || event.type === 'docs-changed') {
        markOpenCard(api);
      }
    });
    api.backend.on('board-changed', () => void refreshBoard());
    api.vault.onChanged(() => void refreshBoard());
    api.backend.on('fleet-changed', (payload) =>
      applyFleetSnapshot((payload ?? {}) as { runs?: RunInfo[]; chain?: ChainStatus | null }));
    void invokeBoard('fleetStatus').then((result) =>
      applyFleetSnapshot((result ?? {}) as { runs?: RunInfo[]; chain?: ChainStatus | null }));
    void refreshBoard();
  },
};

export default plugin;
