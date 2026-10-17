/**
 * The Tickets board (ADR-0076, milestone 83): a kanban view over the
 * tickets vault, mountable in TWO places — the dock panel and a centre
 * editor tab (`tickets://board`, the browser-tab pattern of ADR-0042,
 * milestone 83 follow-up T-0002). Plain DOM (ADR-0044 rule 2); all data
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
  type MutationResult,
  type TicketCard,
} from '../shared/tickets';

/** The doc-kind tab key of the board view (never a vault path). */
const BOARD_TAB_KEY = 'tickets://board';

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
 *  Returns the backend's result (with `id`/`path` for `create`). */
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
  note = result.ok ? (result.warning ?? '') : (result.error ?? '');
  await refreshBoard();
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
    const pin = el('span', 'tickets-mark', 'pinned');
    pin.title = 'Pinned in order.md';
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

  node.addEventListener('click', () => openTicketFile(api, card.path));
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
  node.addEventListener('dragend', () => {
    draggedId = null;
    draggedFrom = null;
    clearInsert();
  });
  return node;
}

function columnNode(api: DreyPluginApi, column: BoardColumn): HTMLElement {
  const node = el('section', 'tickets-col');
  node.dataset['phase'] = column.phase.id;

  const head = el('div', 'tickets-col-head');
  head.append(el('span', 'tickets-col-title', column.phase.title));
  const count = el(
    'span',
    'tickets-col-count',
    column.phase.wip === null
      ? String(column.tickets.length)
      : `${column.tickets.length}/${column.phase.wip}`,
  );
  if (column.phase.wip !== null && column.tickets.length > column.phase.wip) {
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
  node.append(head);

  const list = el('div', 'tickets-col-list');
  for (const card of column.tickets) {
    list.append(cardNode(api, card, column));
  }
  if (column.tickets.length === 0) {
    list.append(el('div', 'tickets-col-empty', '—'));
  }
  list.addEventListener('dragover', (event) => {
    if (draggedId === null) {
      return;
    }
    event.preventDefault();
    markInsert(list, column.phase.id, event.clientY);
  });
  list.addEventListener('dragleave', (event) => {
    if (!list.contains(event.relatedTarget as Node | null)) {
      clearInsert();
    }
  });
  list.addEventListener('drop', (event) => {
    event.preventDefault();
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
 *  The empty state (no tickets vault) is part of the view — a board tab
 *  without a vault shows the same guidance as the panel. */
function buildBoardView(api: DreyPluginApi): BoardView {
  const root = el('div', 'tickets-view');
  const render = (): void => {
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

      const boardButton = el('button', 'icon-btn');
      boardButton.type = 'button';
      boardButton.title = 'Open the board in the editor area';
      boardButton.setAttribute('aria-label', 'Open the board in the editor area');
      boardButton.append(api.ui.icon('window', 14));
      boardButton.addEventListener('click', () => {
        api.documents.addDoc('tickets-board', BOARD_TAB_KEY, 'Tickets');
      });

      const refreshButton = el('button', 'icon-btn');
      refreshButton.type = 'button';
      refreshButton.title = 'Refresh the board';
      refreshButton.setAttribute('aria-label', 'Refresh the board');
      refreshButton.append(api.ui.icon('refresh-cw', 14));
      refreshButton.addEventListener('click', () => void refreshBoard());

      host.append(newButton, boardButton, refreshButton);
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
      );
    };
    create.addEventListener('click', submit);
    actions.append(cancel, create);

    form.append(title, row, description, actions);
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

  document.body.append(menu);
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

    // The board as a centre editor tab (T-0002, the browser-tab
    // pattern): full width, session-restorable, stateless.
    api.ui.registerDocKind({
      kind: 'tickets-board',
      serialize: () => null,
      restore: (path) => api.documents.addDoc('tickets-board', path, 'Tickets'),
      mount: (tabBody, _path) => {
        tabBody.classList.add('tickets-docview');
        const view = buildBoardView(api);
        views.add(view);
        tabBody.append(view.root);
        view.render();
        return () => {
          views.delete(view);
        };
      },
      icon: 'layers',
      statusText: () => {
        if (snapshot === null || snapshot.vaultId === null) {
          return null;
        }
        return `${snapshot.vaultName ?? 'Tickets'} — ${openTicketCount(snapshot)} open`;
      },
    });

    api.backend.on('board-changed', () => void refreshBoard());
    api.vault.onChanged(() => void refreshBoard());
    void refreshBoard();
  },
};

export default plugin;
