/**
 * The Work panel's list (req-75 W1/W1b, ADR-0087): Needs you, Shaping,
 * Running, Ideas and Done this week as collapsible groups of the
 * canvas's two-line rows, so it reads in a ~240 px side dock. Plain DOM
 * over `work-groups.ts`; a row is information plus one click — it opens
 * the ticket where the decision is made. Every action goes back through
 * the deps; this file holds no board state of its own beyond which
 * groups are folded. The filter (T-0084) hides rows in every group and
 * marks a group the filter emptied; its state lives in the caller, the
 * store beside the folds.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import {
  TICKETS_ARCHIVE_DIR,
  type BoardSnapshot,
  type RecentDone,
  type TicketCard,
  type TicketPriority,
  type TicketTrack,
} from '../shared/tickets';
import type { RunInfo } from '../main/fleet/protocol';
import type { ChainAlert, ChainAlertAction } from './chain-alerts';
import { ageWords, needKindLabel, runningStepOf, statusLineOf, workGroups, type WorkGroupId, type WorkRow } from './work-groups';
import { applyWorkFilter, isFilterActive, NO_WORK_FILTER, type FilteredGroup, type WorkFilterState } from './work-filter';

export const PRIORITY_LABEL: Readonly<Record<TicketPriority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const GROUP_TITLE: Readonly<Record<WorkGroupId, string>> = {
  needs: 'Needs you',
  shaping: 'Shaping',
  running: 'Running',
  ideas: 'Ideas',
  done: 'Done this week',
};

/** The fold key of the ideas' "<n> more" tail. */
const IDEAS_ALL = 'ideas-all';

/** How many ideas show before the "<n> more" row. */
const IDEAS_SHOWN = 5;

/** The groups in display order (T-0084 made it a constant): what runs
 *  stays above the backlog — Needs you first, then Running. */
export const WORK_GROUP_ORDER: readonly WorkGroupId[] = ['needs', 'running', 'shaping', 'ideas', 'done'];

export interface WorkPanelDeps {
  readonly api: DreyPluginApi;
  /** Opens the ticket page: the ticket file with its thread beside it. */
  openTicket(card: TicketCard): void;
  setPriority(card: TicketCard, priority: TicketPriority): void;
  setTrack(card: TicketCard, track: TicketTrack | null): void;
  openMenu(card: TicketCard, at: { x: number; y: number }): void;
  /** What stops the fleet (a tripped breaker, a held column, …), drawn on top; absent = none. */
  readonly alerts?: readonly ChainAlert[];
  /** An alert's button: resume a column, run the chain. */
  onAlertAction?(action: ChainAlertAction): void;
  /** Clears the Work filter (the hidden-by-filter marker's button, T-0084). */
  clearFilter(): void;
}

/** Which groups the owner folded — per viewer, never in the repo. */
export interface GroupFoldStore {
  isFolded(id: string): boolean;
  setFolded(id: string, folded: boolean): void;
}

const FOLD_KEY = 'drey.tickets.work.folded';

export function createGroupFoldStore(storage: Storage | null): GroupFoldStore {
  const read = (): Set<string> | null => {
    try {
      const raw = storage?.getItem(FOLD_KEY) ?? null;
      if (raw === null) {
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set<string>();
    }
  };
  // Nothing saved yet: Done this week and the ideas' tail start folded.
  let folded = read() ?? new Set<string>(['done', IDEAS_ALL]);
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
  const alerts = deps.alerts ?? [];
  if (alerts.length > 0) {
    list.append(alertsNode(deps, alerts));
  }
  for (const id of WORK_GROUP_ORDER) {
    if (id === 'done') {
      if (snap.recentDone.length > 0) {
        list.append(doneGroupNode(snap, folds, rerender));
      }
      continue;
    }
    const group = filtered[id];
    // Needs you and Shaping show only when something waits / runs — the
    // unfiltered totals decide, so a filter never hides a whole group's head.
    if ((id === 'needs' || id === 'shaping') && group.total === 0) {
      continue;
    }
    list.append(groupNode(deps, snap, id, group, folds, rerender, isFilterActive(filter)));
  }
  const total =
    groups.needs.length + groups.shaping.length + groups.running.length + groups.ideas.length + snap.recentDone.length;
  if (total === 0) {
    list.append(el('div', 'work-empty', 'No tickets yet — capture one with +'));
  }
  return list;
}

/**
 * The fleet's alerts above every group: what keeps the machine from
 * working the board. Each row says what and why; its one button undoes
 * the stop where the owner can.
 */
function alertsNode(deps: WorkPanelDeps, alerts: readonly ChainAlert[]): HTMLElement {
  const box = el('section', 'work-alerts');
  box.setAttribute('role', 'alert');
  for (const alert of alerts) {
    const row = el('div', 'work-alert');
    row.dataset['kind'] = alert.kind;
    const icon = el('span', 'work-alert-icon');
    icon.append(deps.api.ui.icon(alert.kind === 'quota' ? 'pause' : 'triangle-alert', 13));
    const body = el('div', 'work-alert-body');
    body.append(el('div', 'work-alert-title', alert.title), el('div', 'work-alert-text', alert.text));
    row.append(icon, body);
    const action = alert.action;
    if (action !== null && deps.onAlertAction !== undefined) {
      const button = el('button', 'work-alert-action', action.label);
      button.type = 'button';
      button.title = action.kind === 'play-column' ? 'Play the column again — the runner dispatches into it' : 'Run the chain — columns with a worker drain themselves';
      button.addEventListener('click', () => deps.onAlertAction?.(action));
      row.append(button);
    }
    box.append(row);
  }
  return box;
}

/** The head's count (T-0084): the visible rows, `<visible>/<total>` while
 *  a filter is active; Running adds its live runs. */
function groupHeadCount(id: WorkGroupId, group: FilteredGroup, filterActive: boolean): string {
  let text = filterActive ? `${group.rows.length}/${group.total}` : `${group.rows.length}`;
  if (id === 'running') {
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
  section.append(groupHead(id, groupHeadCount(id, group, filterActive), folded, folds, rerender));
  if (!folded) {
    const body = el('div', 'work-group-rows');
    if (id === 'ideas') {
      appendIdeas(deps, body, group.rows, group.total, folds, rerender, filterActive);
    } else {
      for (const row of group.rows) {
        body.append(id === 'shaping' ? shapingRowNode(deps, row) : id === 'running' ? runningRowNode(deps, snap, row) : rowNode(deps, snap, row));
      }
      if (group.rows.length === 0) {
        if (group.total > 0) {
          // The filter hid every row (T-0084): one quiet way back.
          const clear = el('button', 'work-hidden-by-filter', 'Hidden by the filter — clear');
          clear.type = 'button';
          clear.title = 'Show everything again';
          clear.addEventListener('click', (event) => {
            event.stopPropagation();
            deps.clearFilter();
          });
          body.append(clear);
        } else {
          body.append(el('div', 'work-group-empty', 'Nothing running'));
        }
      }
    }
    section.append(body);
  }
  return section;
}

/** The head every group shares: chevron, bold title, count as a badge. */
function groupHead(
  id: WorkGroupId,
  count: string,
  folded: boolean,
  folds: GroupFoldStore,
  rerender: () => void,
): HTMLElement {
  const head = el('button', 'work-group-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!folded));
  head.title = folded ? `Show ${GROUP_TITLE[id]}` : `Fold ${GROUP_TITLE[id]}`;
  const chevron = el('span', 'work-group-chevron');
  chevron.append(folded ? '▸' : '▾');
  const title = el('span', 'work-group-title', GROUP_TITLE[id]);
  const badge = el('span', `work-group-count${['needs', 'shaping', 'running'].includes(id) ? ' work-group-badge' : ''}`, count);
  head.append(chevron, title, badge);
  head.addEventListener('click', () => {
    folds.setFolded(id, !folded);
    rerender();
  });
  return head;
}

/** Ideas: the first five rows, then "<n> more" unfolds the rest (remembered). */
function appendIdeas(
  deps: WorkPanelDeps,
  body: HTMLElement,
  rows: readonly WorkRow[],
  total: number,
  folds: GroupFoldStore,
  rerender: () => void,
  filterActive: boolean,
): void {
  if (rows.length === 0) {
    if (total > 0) {
      // The filter hid every idea (T-0084): one quiet way back.
      const clear = el('button', 'work-hidden-by-filter', 'Hidden by the filter — clear');
      clear.type = 'button';
      clear.title = 'Show everything again';
      clear.addEventListener('click', (event) => {
        event.stopPropagation();
        deps.clearFilter();
      });
      body.append(clear);
    } else {
      body.append(el('div', 'work-group-empty', 'No ideas yet — capture one with +'));
    }
    return;
  }
  const allOpen = !folds.isFolded(IDEAS_ALL);
  const shown = allOpen ? rows : rows.slice(0, IDEAS_SHOWN);
  for (const row of shown) {
    body.append(ideaRowNode(deps, row));
  }
  if (rows.length > IDEAS_SHOWN) {
    const more = el('button', 'work-ideas-more');
    more.type = 'button';
    const rest = rows.length - shown.length;
    more.textContent = allOpen ? 'Show fewer' : `${rows.length - IDEAS_SHOWN} more`;
    more.title = allOpen ? `Fold the ideas back to the first ${IDEAS_SHOWN}` : `Show ${rest} more idea${rest === 1 ? '' : 's'}`;
    more.addEventListener('click', () => {
      folds.setFolded(IDEAS_ALL, allOpen);
      rerender();
    });
    body.append(more);
  }
}

/** A row's shared bones: identity, tooltip, the open/menu affordances. */
function baseRow(deps: WorkPanelDeps, card: TicketCard): { node: HTMLElement; more: HTMLButtonElement } {
  const node = el('article', 'work-row');
  node.dataset['id'] = card.id;
  node.dataset['path'] = card.path;
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${card.id} ${card.meta.title ?? '(untitled)'}`);
  node.title = `${card.id} — ${card.meta.title ?? ''}\n${card.path}`;

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
  return { node, more };
}

/** The issue badge a row with findings carries beside its age. */
function issuesBadge(card: TicketCard): HTMLElement | null {
  if (card.issues.length === 0) {
    return null;
  }
  const worst = card.issues.some((i) => i.level === 'error')
    ? 'error'
    : card.issues.some((i) => i.level === 'warning')
      ? 'warning'
      : 'noise';
  const badge = el('span', `work-row-issues work-row-issues-${worst}`, String(card.issues.length));
  badge.title = card.issues.map((i) => `[${i.level}] ${i.message}`).join('\n');
  return badge;
}

/** A row's phase chip (T-0084): a dot in the phase's colour plus its
 *  name — the name carries the meaning, the colour anchors it. */
function phaseChipNode(row: WorkRow): HTMLElement {
  const chip = el('span', 'work-phase-chip');
  chip.style.setProperty('--phase-color', row.phaseColor);
  chip.title = row.phase.title;
  chip.append(el('span', 'work-phase-dot'), el('span', 'work-phase-name', row.phase.title));
  return chip;
}

/** A Needs-you row: title + age, then the phase chip, the kind chip and why it waits. */
function rowNode(deps: WorkPanelDeps, snap: BoardSnapshot, row: WorkRow): HTMLElement {
  const { card, need } = row;
  const { node, more } = baseRow(deps, card);
  if (need !== null) {
    node.dataset['need'] = need.kind;
  }
  const top = el('div', 'work-row-top');
  top.append(el('span', 'work-row-title', card.meta.title ?? '(untitled)'));
  const issues = issuesBadge(card);
  if (issues !== null) {
    top.append(issues);
  }
  top.append(el('span', 'work-row-age', ageWords(need?.since ?? null, Date.now())), more);
  node.append(top);
  if (need !== null) {
    const line = el('div', 'work-row-sub');
    line.append(phaseChipNode(row), el('span', 'work-kind', needKindLabel(need, snap)), el('span', 'work-row-line', statusLineOf(row, snap)));
    node.append(line);
  }
  return node;
}

/** A Shaping row: title + age, then the phase chip and the dialog's pulse. */
function shapingRowNode(deps: WorkPanelDeps, row: WorkRow): HTMLElement {
  const { card } = row;
  const { node, more } = baseRow(deps, card);
  if (row.run !== null) {
    node.dataset['running'] = 'true';
  }
  const top = el('div', 'work-row-top');
  top.append(el('span', 'work-row-title', card.meta.title ?? '(untitled)'));
  const issues = issuesBadge(card);
  if (issues !== null) {
    top.append(issues);
  }
  top.append(el('span', 'work-row-age', ageWords(row.run?.startedAt ?? card.meta.entered[row.phase.id] ?? null, Date.now())), more);
  node.append(top);
  const turns = (row.run?.steerCount ?? -1) + 1;
  const dialog =
    row.run === null ? 'Dialog not started' : `${row.run.turn === 'busy' ? 'Dialog running' : 'Dialog paused'} · ${turns} turns`;
  const sub = el('div', 'work-row-sub');
  sub.append(phaseChipNode(row), el('span', 'work-row-line', dialog));
  node.append(sub);
  return node;
}

/** A Running row: title + the run's age, then dot, the phase chip, the step and the worker's line. */
function runningRowNode(deps: WorkPanelDeps, snap: BoardSnapshot, row: WorkRow): HTMLElement {
  const { card } = row;
  const { node, more } = baseRow(deps, card);
  const step = runningStepOf(row, snap);
  if (step.live) {
    node.dataset['running'] = 'true';
  }
  const top = el('div', 'work-row-top');
  top.append(el('span', 'work-row-title', card.meta.title ?? '(untitled)'));
  const issues = issuesBadge(card);
  if (issues !== null) {
    top.append(issues);
  }
  top.append(el('span', 'work-row-age', step.live ? ageWords(row.run?.startedAt ?? null, Date.now()) : ''), more);
  node.append(top);
  const sub = el('div', 'work-row-sub work-run');
  sub.append(el('span', `work-run-dot${step.live ? '' : ' work-run-dot-queued'}`), phaseChipNode(row), el('span', 'work-run-step', step.step));
  if (step.line !== '') {
    sub.append(el('span', 'work-run-line', step.line));
  }
  node.append(sub);
  return node;
}

/** An Idea row: one line — priority chip when it matters, title, track chip. */
function ideaRowNode(deps: WorkPanelDeps, row: WorkRow): HTMLElement {
  const { card } = row;
  const { node, more } = baseRow(deps, card);
  node.classList.add('work-row-idea');
  if (card.meta.priority === 'urgent' || card.meta.priority === 'high') {
    node.append(el('span', `work-prio-mini work-prio-mini-${card.meta.priority}`, PRIORITY_LABEL[card.meta.priority]));
  }
  node.append(el('span', 'work-row-title', card.meta.title ?? '(untitled)'));
  if (row.queued) {
    const queued = el('span', 'work-row-queued', 'Queued');
    queued.title = 'Queued for the fleet — the next free worker takes it';
    node.append(queued);
  }
  const track = card.meta.track;
  const chip = el('span', `work-track work-track-${track ?? 'triage'}`, track === 'auto' ? 'Auto' : track === 'shape' ? 'Shape' : 'Triage');
  chip.title =
    track === null
      ? 'Not triaged yet — pick a track from the menu'
      : `Track: ${track === 'auto' ? 'Auto — runs on its own' : 'Shape — a plan-mode dialog with you'}`;
  node.append(chip, more);
  return node;
}

/** Done this week: the archived tickets of the last 7 days, folded by default. */
function doneGroupNode(snap: BoardSnapshot, folds: GroupFoldStore, rerender: () => void): HTMLElement {
  const section = el('section', 'work-group work-group-done');
  section.dataset['group'] = 'done';
  section.append(groupHead('done', String(snap.recentDone.length), folds.isFolded('done'), folds, rerender));
  if (!folds.isFolded('done')) {
    const body = el('div', 'work-group-rows');
    for (const done of snap.recentDone) {
      body.append(doneRowNode(done));
    }
    section.append(body);
  }
  return section;
}

/** A Done row is a memento, not a button: muted title and when it closed. */
function doneRowNode(done: RecentDone): HTMLElement {
  const node = el('div', 'work-done-row');
  node.dataset['id'] = done.id;
  node.title = `${TICKETS_ARCHIVE_DIR}/${done.id}.md`;
  node.append(el('span', 'work-done-title', done.title ?? done.id), el('span', 'work-row-age', ageWords(done.at, Date.now())));
  return node;
}
