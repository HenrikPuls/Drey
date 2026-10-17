/**
 * The Tickets board (ADR-0076, milestone 83): a kanban view over the
 * tickets vault in the dock panel. Plain DOM (ADR-0044 rule 2); all data
 * comes from `backend.invoke('board')` snapshots — the renderer never
 * parses a ticket file. One module-level store serves every view; a
 * view is just a DOM root plus a render call.
 */
import type { DreyPluginApi, PluginWidgetContrib } from '../../../shared/plugin-api/renderer';
import {
  ageOf,
  branchForTicket,
  openTicketCount,
  type BoardColumn,
  type BoardSnapshot,
  type CreateResult,
  type MutationResult,
  type TicketCard,
} from '../shared/tickets';
import { createColumnCollapseStore } from './column-collapse';

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

// --- drag state (one interaction at a time, shared across views) -------

let draggedId: string | null = null;
let draggedFrom: string | null = null;
let insertPhase: string | null = null;
let insertAt = 0;

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
  if (column.phase.handover.startsWith('agent')) {
    const handover = el('span', 'tickets-col-agent', column.phase.handover);
    handover.title = 'Agents handle this handover (from milestone 84)';
    head.append(handover);
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
    const board = el('div', 'tickets-board');
    for (const column of snap.columns) {
      board.append(columnNode(api, column));
    }
    root.append(board);
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
      button.textContent = `Creates tickets/_meta/{pipeline,order,repos}.md in ${target} — click again`;
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

    api.backend.on('board-changed', () => void refreshBoard());
    api.vault.onChanged(() => void refreshBoard());
    void refreshBoard();
  },
};

export default plugin;
