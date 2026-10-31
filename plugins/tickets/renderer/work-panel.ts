/**
 * The Work panel's list (req-75 W1, ADR-0087): Needs you, Ideas and In
 * progress as collapsible groups of one-line rows in place of the
 * kanban columns, so it reads in a ~240 px side dock. Plain DOM over
 * `work-groups.ts`; every action goes back through the deps — this file
 * holds no board state of its own beyond which groups are folded.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { TICKET_PRIORITIES, type BoardSnapshot, type TicketCard, type TicketPriority } from '../shared/tickets';
import type { RunInfo } from '../main/fleet/protocol';
import { answerText, type ShapedOption, type ShapedQuestion } from '../shared/question-shape';
import type { InteractiveMode } from './end-moves';
import { interactiveModeFor } from './end-moves';
import {
  checkpointActionOf,
  statusLineOf,
  workGroups,
  type WorkGroupId,
  type WorkRow,
} from './work-groups';
import { applyWorkFilter, isFilterActive, NO_WORK_FILTER, type FilteredGroup, type WorkFilterState } from './work-filter';
import { workerStatus } from './worker-status';

export const PRIORITY_LABEL: Readonly<Record<TicketPriority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const GROUP_TITLE: Readonly<Record<WorkGroupId, string>> = {
  needs: 'Needs you',
  ideas: 'Ideas',
  progress: 'In progress',
};

/** The groups in display order (T-0084): the owner reads what runs first. */
export const WORK_GROUP_ORDER: readonly WorkGroupId[] = ['needs', 'progress', 'ideas'];

export interface WorkPanelDeps {
  readonly api: DreyPluginApi;
  /** Opens the ticket page: the ticket file with its thread beside it. */
  openTicket(card: TicketCard): void;
  /** An owner move (blocked tickets into a machine phase ask first). */
  move(card: TicketCard, to: string): void;
  /** Accept: the ticket goes to the archive. */
  accept(card: TicketCard): void;
  setPriority(card: TicketCard, priority: TicketPriority): void;
  startDialog(card: TicketCard, mode: InteractiveMode): void;
  openRunModal(card: TicketCard): void;
  openMenu(card: TicketCard, at: { x: number; y: number }): void;
  /** Answers a waiting worker's shaped question with one tap (req-75 W2) — the composer's send path. */
  answer(card: TicketCard, run: RunInfo, text: string): void;
  /** Clears the Work filter (the hidden-by-filter marker's button, T-0084). */
  clearFilter(): void;
}

/** Which groups the owner folded — per viewer, never in the repo. */
export interface GroupFoldStore {
  isFolded(id: WorkGroupId): boolean;
  setFolded(id: WorkGroupId, folded: boolean): void;
}

const FOLD_KEY = 'drey.tickets.work.folded';

export function createGroupFoldStore(storage: Storage | null): GroupFoldStore {
  const read = (): Set<string> => {
    try {
      const raw = storage?.getItem(FOLD_KEY) ?? null;
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  };
  let folded = read();
  return {
    isFolded: (id) => folded.has(id),
    setFolded: (id, value) => {
      folded = new Set(folded);
      if (value) {
        folded.add(id);
      } else {
        folded.delete(id);
      }
      try {
        storage?.setItem(FOLD_KEY, JSON.stringify([...folded]));
      } catch {
        // A blocked storage keeps the fold for this session only.
      }
    },
  };
}

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

/**
 * The whole list for one snapshot. `rerender` repaints after a fold, so
 * every mounted view stays in step. The filter (T-0084) hides rows in
 * every group; its state lives in the caller (the store beside the
 * folds).
 */
export function workListNode(
  deps: WorkPanelDeps,
  snap: BoardSnapshot,
  runs: readonly RunInfo[],
  folds: GroupFoldStore,
  rerender: () => void,
  filter: WorkFilterState = NO_WORK_FILTER,
): HTMLElement {
  const groups = workGroups(snap, runs);
  const filtered = applyWorkFilter(groups, filter);
  const list = el('div', 'work-list');
  for (const id of WORK_GROUP_ORDER) {
    const group = filtered[id];
    // Needs you shows only when something waits on the owner.
    if (id === 'needs' && group.total === 0) {
      continue;
    }
    list.append(groupNode(deps, snap, id, group, folds, rerender, isFilterActive(filter)));
  }
  if (filtered.needs.total + filtered.ideas.total + filtered.progress.total === 0) {
    list.append(el('div', 'work-empty', 'No tickets yet — capture one with +'));
  }
  return list;
}

/** The head's count: the visible rows, `<visible>/<total>` while a
 *  filter is active; In progress adds its live runs (T-0084). */
function groupHeadCount(id: WorkGroupId, group: FilteredGroup, filterActive: boolean): string {
  let text = filterActive ? `${group.rows.length}/${group.total}` : `${group.rows.length}`;
  if (id === 'progress') {
    const running = group.rows.filter((row) => row.run !== null).length;
    if (running > 0) {
      text += ` · ${running} running`;
    }
  }
  return text;
}

function groupNode(
  deps: WorkPanelDeps,
  snap: BoardSnapshot,
  id: WorkGroupId,
  group: FilteredGroup,
  folds: GroupFoldStore,
  rerender: () => void,
  filterActive: boolean,
): HTMLElement {
  const folded = folds.isFolded(id);
  const section = el('section', `work-group work-group-${id}`);
  section.dataset['group'] = id;
  const head = el('button', 'work-group-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!folded));
  head.title = folded ? `Show ${GROUP_TITLE[id]}` : `Fold ${GROUP_TITLE[id]}`;
  const chevron = el('span', 'work-group-chevron');
  chevron.append(deps.api.ui.icon(folded ? 'chevron-right' : 'chevron-down', 12));
  head.append(
    chevron,
    el('span', 'work-group-title', GROUP_TITLE[id]),
    el('span', 'work-group-count', groupHeadCount(id, group, filterActive)),
  );
  head.addEventListener('click', () => {
    folds.setFolded(id, !folded);
    rerender();
  });
  section.append(head);
  if (!folded) {
    const body = el('div', 'work-group-rows');
    for (const row of group.rows) {
      body.append(rowNode(deps, snap, row));
    }
    if (group.rows.length === 0) {
      if (group.total > 0) {
        const clear = el('button', 'work-hidden-by-filter', 'Hidden by the filter — clear');
        clear.type = 'button';
        clear.title = 'Show everything again';
        clear.addEventListener('click', (event) => {
          event.stopPropagation();
          deps.clearFilter();
        });
        body.append(clear);
      } else {
        body.append(el('div', 'work-group-empty', id === 'ideas' ? 'No ideas waiting' : 'Nothing running'));
      }
    }
    section.append(body);
  }
  return section;
}

function rowNode(deps: WorkPanelDeps, snap: BoardSnapshot, row: WorkRow): HTMLElement {
  const { card } = row;
  const node = el('article', 'work-row');
  node.dataset['id'] = card.id;
  node.dataset['path'] = card.path;
  if (row.need !== null) {
    node.dataset['need'] = row.need.kind;
  }
  if (row.run !== null) {
    node.dataset['running'] = 'true';
  }
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${card.id} ${card.meta.title ?? '(untitled)'}`);
  node.title = `${card.id} — ${card.meta.title ?? ''}\n${card.path}`;

  const top = el('div', 'work-row-top');
  top.append(priorityChip(deps, card), el('span', 'work-row-title', card.meta.title ?? '(untitled)'));
  if (row.queued) {
    const queued = el('span', 'work-row-queued', 'Queued');
    queued.title = 'Queued for the fleet — the next free worker takes it';
    top.append(queued);
  }
  if (card.issues.length > 0) {
    const worst = card.issues.some((i) => i.level === 'error') ? 'error' : card.issues.some((i) => i.level === 'warning') ? 'warning' : 'noise';
    const badge = el('span', `work-row-issues work-row-issues-${worst}`, String(card.issues.length));
    badge.title = card.issues.map((i) => `[${i.level}] ${i.message}`).join('\n');
    top.append(badge);
  }
  const more = el('button', 'icon-btn work-row-more');
  more.type = 'button';
  more.title = 'More actions';
  more.setAttribute('aria-label', `More actions for ${card.id}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.append(deps.api.ui.icon('more-horizontal', 13));
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    const rect = more.getBoundingClientRect();
    deps.openMenu(card, { x: rect.left, y: rect.bottom + 2 });
  });
  top.append(more);
  node.append(top);

  const status = el('div', 'work-row-status');
  if (row.run !== null) {
    status.append(el('span', `tickets-light tickets-light-${workerStatus(row.run, Date.now()).light}`));
  }
  const chip = el('span', 'work-phase-chip');
  chip.style.setProperty('--phase-color', row.phaseColor);
  chip.title = row.phase.title;
  chip.append(el('span', 'work-phase-dot'), el('span', 'work-phase-name', row.phase.title));
  const line = el('span', 'work-row-line', statusLineOf(row, snap));
  if (line.textContent === '') {
    line.hidden = true;
  }
  status.append(chip, el('span', 'work-row-id', card.id), line);
  node.append(status);

  const actions = needActions(deps, snap, row);
  if (actions !== null) {
    node.append(actions);
  }

  node.addEventListener('click', () => deps.openTicket(card));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === node) {
      event.preventDefault();
      deps.openTicket(card);
    }
  });
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    deps.openMenu(card, { x: event.clientX, y: event.clientY });
  });
  return node;
}

/** The priority chip: the label, a click lists the four to pick from. */
function priorityChip(deps: WorkPanelDeps, card: TicketCard): HTMLElement {
  const chip = el('button', `work-prio work-prio-${card.meta.priority}`, PRIORITY_LABEL[card.meta.priority]);
  chip.type = 'button';
  chip.title = `Priority ${PRIORITY_LABEL[card.meta.priority]} — click to change`;
  chip.setAttribute('aria-label', chip.title);
  chip.setAttribute('aria-haspopup', 'menu');
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    for (const other of document.querySelectorAll('.tickets-menu')) {
      other.remove();
    }
    const menu = el('div', 'tickets-menu');
    menu.setAttribute('role', 'menu');
    const close = (): void => {
      menu.remove();
      window.removeEventListener('mousedown', outside, true);
    };
    const outside = (e: Event): void => {
      if (!menu.contains(e.target as Node)) {
        close();
      }
    };
    for (const priority of TICKET_PRIORITIES) {
      const item = el('button', 'tickets-menu-item', PRIORITY_LABEL[priority]);
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(priority === card.meta.priority));
      item.addEventListener('click', () => {
        close();
        deps.setPriority(card, priority);
      });
      menu.append(item);
    }
    document.body.append(menu);
    const anchor = chip.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.min(anchor.bottom + 2, window.innerHeight - rect.height - 8)}px`;
    menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    window.addEventListener('mousedown', outside, true);
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        close();
        chip.focus();
      }
    });
  });
  return chip;
}

/** The option rows of a shaped question (req-75 W2): one tap answers.
 *  Compact dot rows (T-0084) — the consequence rides the tooltip, the
 *  dot's ring marks the recommendation. */
function shapedOptionButtons(box: HTMLElement, shaped: ShapedQuestion, onPick: (option: ShapedOption) => void): HTMLElement {
  const options = el('div', 'work-options');
  for (const option of shaped.options) {
    const recommended = shaped.recommended === option.n;
    const b = el('button', `work-option${recommended ? ' work-option-recommended' : ''}`);
    b.type = 'button';
    b.title =
      option.consequence !== null
        ? `${option.label} — ${option.consequence}${recommended ? ' (recommended)' : ''}`
        : `${option.label}${recommended ? ' (recommended)' : ''}`;
    b.append(el('span', 'work-option-dot'), el('span', 'work-option-label', option.label));
    b.addEventListener('click', (event) => {
      event.stopPropagation();
      for (const sibling of box.querySelectorAll('button')) {
        (sibling as HTMLButtonElement).disabled = true;
      }
      onPick(option);
    });
    options.append(b);
  }
  return options;
}

/** The buttons of a Needs-you row: answer, approve, accept, refine, run again. */
function needActions(deps: WorkPanelDeps, snap: BoardSnapshot, row: WorkRow): HTMLElement | null {
  const need = row.need;
  if (need === null) {
    return null;
  }
  const box = el('div', 'work-row-actions');
  const button = (label: string, title: string, primary: boolean, onClick: () => void): void => {
    const b = el('button', `work-action${primary ? ' work-action-primary' : ''}`, label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    box.append(b);
  };
  switch (need.kind) {
    case 'question': {
      // A shaped question answers from the row itself (req-75 W2).
      const run = row.run;
      const shaped = run?.waiting?.shaped ?? null;
      if (shaped !== null && run !== null) {
        box.append(shapedOptionButtons(box, shaped, (option) => deps.answer(row.card, run, answerText(option))));
      }
      button('Answer', 'Open the ticket and answer the worker', true, () => deps.openTicket(row.card));
      break;
    }
    case 'permission':
      button('Review', 'Open the ticket and allow or deny what the worker wants to do', true, () => deps.openTicket(row.card));
      break;
    case 'red-gate':
    case 'failed':
      button('Open', 'Open the ticket and read what went wrong', true, () => deps.openTicket(row.card));
      button('Run again…', 'Start a new run on this ticket', false, () => deps.openRunModal(row.card));
      break;
    default: {
      const action = checkpointActionOf(snap, need.phase);
      if (action.kind === 'accept') {
        button(action.label, 'Accept the result — the ticket goes to the archive', true, () => deps.accept(row.card));
      } else {
        button(action.label, `Your review is done — move the ticket on to ${action.label.replace('Approve → ', '')}`, true, () =>
          deps.move(row.card, action.to),
        );
        const mode = interactiveModeFor(need.phase, snap.columns);
        if (mode === 'refine' && row.run === null) {
          button('Refine with agent', 'Talk it through with a worker first', false, () => deps.startDialog(row.card, 'refine'));
        }
      }
    }
  }
  return box;
}
