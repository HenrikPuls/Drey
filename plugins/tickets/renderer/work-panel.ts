/**
 * The Work panel's list (req-75 W1/W1b, ADR-0087): Needs you, Shaping,
 * Running, Ideas and Done this week as collapsible groups of the
 * canvas's two-line rows (E12-11, boards 7a–7c: id, title and age, then
 * one grey meta line and the cost), so it reads in a ~240 px side dock. Plain DOM
 * over `work-groups.ts`; a row is information plus one click — it opens
 * the ticket where the decision is made. Every action goes back through
 * the deps; this file holds no board state of its own beyond which
 * groups are folded. The filter (T-0084) hides rows in every group and
 * marks a group the filter emptied; its state lives in the caller, the
 * store beside the folds.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { usd } from './team/team-model';
import {
  DEFAULT_PRIORITY_CONFIG,
  priorityClass,
  TICKETS_ARCHIVE_DIR,
  type BoardSnapshot,
  type RecentDone,
  type TicketCard,
  type TicketPriority,
  type TicketTrack,
} from '../shared/tickets';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import type { ChainAlert, ChainAlertAction } from './chain-alerts';
import { ageWords, needKindLabel, runningStepOf, workGroups, type WorkGroupId, type WorkRow } from './work-groups';
import { applyWorkFilter, isFilterActive, NO_WORK_FILTER, type FilteredGroup, type WorkFilterState } from './work-filter';

export const PRIORITY_LABEL: Readonly<Record<TicketPriority, string>> = {
  critical: 'Critical',
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const GROUP_TITLE: Readonly<Record<WorkGroupId, string>> = {
  needs: 'Needs you',
  shaping: 'Shaping',
  running: 'Running',
  prioritized: 'Prioritized',
  ideas: 'Inbox',
  done: 'Done this week',
};

/** The fold key of the ideas' "<n> more" tail. */
const IDEAS_ALL = 'ideas-all';

/** The fold key of the prioritized group's "<n> more" tail. */
const PRIORITIZED_ALL = 'prioritized-all';

/** How many ideas show before the "<n> more" row. */
const IDEAS_SHOWN = 2;

/** The groups in display order (T-0084 made it a constant): what runs
 *  stays above the backlog — Needs you first, then Running. */
export const WORK_GROUP_ORDER: readonly WorkGroupId[] = ['needs', 'running', 'shaping', 'prioritized', 'ideas', 'done'];

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
  /** Opens a done/archived ticket (E13-21): its document, with the Thread and Review faces beside it. */
  openArchived?(id: string): void;
  /** The archive of any age, newest first, for the Done group's "Show older" (E13-21). */
  listArchived?(): Promise<readonly RecentDone[]>;
  /** Clears the Work filter (the hidden-by-filter marker's button, T-0084). */
  clearFilter(): void;
  /** A persona id as its name (E13-8, the rows' persona chip); absent = the id itself. */
  personaName?(id: string): string;
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
  let folded = read() ?? new Set<string>(['done', IDEAS_ALL, PRIORITIZED_ALL]);
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
        list.append(doneGroupNode(deps, snap, folds, rerender));
      }
      continue;
    }
    const group = filtered[id];
    // Needs you and Shaping show only when something waits / runs — the
    // unfiltered totals decide, so a filter never hides a whole group's head.
    if ((id === 'needs' || id === 'shaping' || id === 'prioritized') && group.total === 0) {
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

/** One mounted row's age text, whatever group it belongs to. */
function setAge(node: HTMLElement, text: string): void {
  const age = node.querySelector<HTMLElement>('.work-row-age');
  if (age !== null) {
    age.textContent = text;
    age.hidden = text === '';
  }
}

/**
 * Updates a mounted Work list in place (T-0086): the rows' ages, the
 * run rows' step/line/dot, the needs rows' shaped line and the shaping
 * rows' dialog pulse — text and toggles only, never a node added or
 * removed. A row whose card is gone from the snapshot is skipped: a
 * structure change (`workListSignature`) re-rendered the list before
 * this could run on stale DOM.
 */
export function workListLivePaint(
  list: HTMLElement,
  deps: WorkPanelDeps,
  snap: BoardSnapshot,
  runs: readonly RunInfo[],
): void {
  const nowMs = Date.now();
  const groups = workGroups(snap, runs);
  const rows = new Map<string, WorkRow>();
  for (const row of [...groups.needs, ...groups.shaping, ...groups.running, ...groups.ideas]) {
    rows.set(row.card.id, row);
  }
  const doneAt = new Map(snap.recentDone.map((entry) => [entry.id, entry.at]));
  for (const node of list.querySelectorAll<HTMLElement>('[data-id]')) {
    const id = node.dataset['id'] ?? '';
    const row = rows.get(id);
    if (row !== undefined) {
      if (row.need !== null) {
        // Needs you: the age follows the need, the line may turn shaped.
        setAge(node, ageWords(row.need.since, nowMs));
        continue;
      }
      // Shaping and Running share the top line; the sub line differs.
      const group = node.closest('.work-group');
      if (group?.classList.contains('work-group-shaping') === true) {
        setAge(node, ageWords(row.run?.startedAt ?? row.card.meta.entered[row.phase.id] ?? null, nowMs));
        // Only the pulse line moves; the phase chip keeps its place (T-0084).
        const line = node.querySelector<HTMLElement>('.work-row-line');
        if (line !== null) {
          line.textContent = shapingDialogLine(row);
        }
        continue;
      }
      const step = runningStepOf(row, snap);
      setAge(node, step.live ? ageWords(row.run?.startedAt ?? null, nowMs) : '');
      const stepWord = node.querySelector<HTMLElement>('.work-run-step');
      if (stepWord !== null) {
        stepWord.textContent = step.step;
      }
      continue;
    }
    const at = doneAt.get(id);
    if (at !== undefined) {
      // Done this week: only the age still moves.
      setAge(node, ageWords(at, nowMs));
    }
    // A row whose card is gone: skipped — the re-render lands next.
  }
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
  void id;
  return filterActive ? `${group.rows.length}/${group.total}` : `${group.rows.length}`;
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
  section.append(groupHead(deps, id, groupHeadCount(id, group, filterActive), folded, folds, rerender));
  if (!folded) {
    const body = el('div', 'work-group-rows');
    if (id === 'ideas' || id === 'prioritized') {
      appendIdeas(deps, snap, id, body, group.rows, group.total, folds, rerender, filterActive);
    } else {
      for (const row of group.rows) {
        body.append(
          id === 'shaping'
            ? shapingRowNode(deps, row)
            : id === 'running'
              ? runningRowNode(deps, snap, row)
              : rowNode(deps, snap, row),
        );
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
  deps: WorkPanelDeps,
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
  chevron.append(deps.api.ui.icon(folded ? 'chevron-right' : 'chevron-down', 12));
  const title = el('span', 'work-group-title', GROUP_TITLE[id]);
  head.append(chevron, title);
  if (id === 'needs') {
    // Board 7a: the attention dot right after the title.
    const dot = el('span', 'work-attn-dot');
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', GROUP_TITLE[id]);
    head.append(dot);
  }
  head.append(el('span', 'work-group-count', count));
  head.addEventListener('click', () => {
    folds.setFolded(id, !folded);
    rerender();
  });
  return head;
}

/** Ideas and Prioritized: the first IDEAS_SHOWN rows (board 7a: two), then "<n> more" unfolds the rest (remembered). */
function appendIdeas(
  deps: WorkPanelDeps,
  snap: BoardSnapshot,
  id: 'ideas' | 'prioritized',
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
      body.append(el('div', 'work-group-empty', 'Inbox is empty — capture a ticket with +'));
    }
    return;
  }
  const tailKey = id === 'ideas' ? IDEAS_ALL : PRIORITIZED_ALL;
  const allOpen = !folds.isFolded(tailKey);
  const shown = allOpen ? rows : rows.slice(0, IDEAS_SHOWN);
  for (const row of shown) {
    body.append(id === 'ideas' ? ideaRowNode(deps, snap, row) : prioritizedRowNode(deps, row));
  }
  if (rows.length > IDEAS_SHOWN) {
    const more = el('button', 'work-ideas-more');
    more.type = 'button';
    const rest = rows.length - shown.length;
    more.textContent = allOpen ? 'Show fewer' : `${rows.length - IDEAS_SHOWN} more`;
    more.title = allOpen ? `Fold back to the first ${IDEAS_SHOWN}` : `Show ${rest} more`;
    more.addEventListener('click', () => {
      folds.setFolded(tailKey, allOpen);
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

/** The ticket id left of a row's title (req-85): the board's stable
 * handle, muted so the title stays the lead. */
function idNode(id: string): HTMLElement {
  return el('span', 'work-row-id', id);
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

/** A row's phase as plain grey words (board 7a: one meta line, no chips). */
function phaseChipNode(row: WorkRow): HTMLElement {
  const phase = el('span', 'work-meta-phase', row.phase.title);
  phase.title = row.phase.title;
  return phase;
}

/** The one grey meta line's text part: its pieces run together, a dot between (CSS). */
function metaLine(...parts: readonly HTMLElement[]): HTMLElement {
  const meta = el('span', 'work-row-meta');
  meta.append(...parts);
  return meta;
}

/** The ticket's settled cost as the mobile list writes it (`$1.20`); null = none known. */
function costNode(row: WorkRow): HTMLElement | null {
  const cost = row.card.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? el('span', 'work-row-cost', usd(cost)) : null;
}

/** The cost, grey, at the line's right end; its title says it is the cost so far. */
function costNodes(row: WorkRow): HTMLElement[] {
  const cost = costNode(row);
  if (cost === null) {
    return [];
  }
  cost.title = 'So far';
  return [cost];
}

/** The rich rows' second line, board 7a: id · phase · what it is · age, the cost at the right end. */
function richSub(row: WorkRow, parts: readonly HTMLElement[], age: string): HTMLElement {
  const sub = el('div', 'work-row-sub');
  const pieces = [idNode(row.card.id), ...parts];
  if (age !== '') {
    pieces.push(el('span', 'work-row-age', age));
  } else {
    // The live paint fills the age when the run starts; the span stays so it can.
    const empty = el('span', 'work-row-age');
    empty.hidden = true;
    pieces.push(empty);
  }
  sub.append(metaLine(...pieces), ...costNodes(row));
  return sub;
}

/** A rich row's first line: the title, then the hover-only menu button. */
function richTop(card: TicketCard, more: HTMLElement): HTMLElement {
  const top = el('div', 'work-row-top');
  top.append(el('span', 'work-row-title', card.meta.title ?? '(untitled)'));
  const issues = issuesBadge(card);
  if (issues !== null) {
    top.append(issues);
  }
  top.append(more);
  return top;
}

/** A Needs-you row: the title, then id · phase · what it waits for · age and the cost. */
function rowNode(_deps: WorkPanelDeps, snap: BoardSnapshot, row: WorkRow): HTMLElement {
  const { card, need } = row;
  const { node, more } = baseRow(_deps, card);
  if (need !== null) {
    node.dataset['need'] = need.kind;
  }
  node.append(richTop(card, more));
  if (need !== null) {
    const kind = needKindLabel(need, snap);
    // The phase word is dropped when the kind already says it (*Ready to try* in Ready to try).
    const parts = kind === row.phase.title ? [phaseChipNode(row)] : [phaseChipNode(row), el('span', 'work-kind', kind.toLowerCase())];
    node.append(richSub(row, parts, ageWords(need.since, Date.now())));
  }
  return node;
}

/** A Shaping row's pulse: whether the dialog runs, pauses or never started, and its turns. */
function shapingDialogLine(row: WorkRow): string {
  const turns = (row.run?.steerCount ?? -1) + 1;
  return row.run === null ? 'Dialog not started' : `${row.run.turn === 'busy' ? 'Dialog running' : 'Dialog paused'} · ${turns} turns`;
}

/** A Shaping row: the title, then id · phase · the dialog's pulse · age. */
function shapingRowNode(deps: WorkPanelDeps, row: WorkRow): HTMLElement {
  const { card } = row;
  const { node, more } = baseRow(deps, card);
  if (row.run !== null) {
    node.dataset['running'] = 'true';
  }
  node.append(richTop(card, more));
  node.append(
    richSub(row, [phaseChipNode(row), el('span', 'work-row-line', shapingDialogLine(row))], ageWords(row.run?.startedAt ?? card.meta.entered[row.phase.id] ?? null, Date.now())),
  );
  return node;
}

/** A Running row: the title, then id · phase · step · age (while it lives) and the cost. */
function runningRowNode(deps: WorkPanelDeps, snap: BoardSnapshot, row: WorkRow): HTMLElement {
  const { card } = row;
  const { node, more } = baseRow(deps, card);
  const step = runningStepOf(row, snap);
  if (step.live) {
    node.dataset['running'] = 'true';
  }
  node.append(richTop(card, more));
  // The step word is dropped when it only repeats the phase (board 7a: "Building · queued").
  const stepWord = el('span', 'work-run-step', step.step);
  stepWord.hidden = step.step.toLowerCase() === row.phase.title.toLowerCase();
  node.append(richSub(row, [phaseChipNode(row), stepWord], step.live ? ageWords(row.run?.startedAt ?? null, Date.now()) : ''));
  return node;
}

/** An Inbox row (board 7a): the title alone; the menu button shows on hover. A priority that matters earns its chip. */
function ideaRowNode(deps: WorkPanelDeps, snap: BoardSnapshot, row: WorkRow): HTMLElement {
  const { card } = row;
  const { node, more } = baseRow(deps, card);
  node.classList.add('work-row-idea');
  node.append(el('span', 'work-row-title', card.meta.title ?? '(untitled)'));
  // The vocabulary's jump class earns the chip (`urgent`/`high` in the
  // default list); an id outside the label map shows as itself.
  if (priorityClass(card.meta.priority, snap.priorities ?? DEFAULT_PRIORITY_CONFIG) === 0) {
    const label = PRIORITY_LABEL[card.meta.priority] ?? card.meta.priority;
    node.append(el('span', `work-prio-mini work-prio-mini-${card.meta.priority}`, label));
  }
  node.append(more);
  return node;
}

/** A Prioritized row (board 7a): the title, the ticket id grey at the right end. */
function prioritizedRowNode(deps: WorkPanelDeps, row: WorkRow): HTMLElement {
  const { card } = row;
  const { node, more } = baseRow(deps, card);
  node.classList.add('work-row-idea');
  node.append(el('span', 'work-row-title', card.meta.title ?? '(untitled)'), idNode(card.id), more);
  return node;
}

/** Done this week: the archived tickets of the last 7 days, folded by default. */
function doneGroupNode(deps: WorkPanelDeps, snap: BoardSnapshot, folds: GroupFoldStore, rerender: () => void): HTMLElement {
  const section = el('section', 'work-group work-group-done');
  section.dataset['group'] = 'done';
  section.append(groupHead(deps, 'done', String(snap.recentDone.length), folds.isFolded('done'), folds, rerender));
  if (!folds.isFolded('done')) {
    const body = el('div', 'work-group-rows');
    for (const done of snap.recentDone) {
      body.append(doneRowNode(deps, done));
    }
    if (deps.listArchived !== undefined) {
      body.append(...olderNodes(deps, snap, rerender));
    }
    section.append(body);
  }
  return section;
}

/** A Done row opens its ticket (E13-21): the document, then Thread and Review in the strip on top. */
function doneRowNode(deps: WorkPanelDeps, done: RecentDone): HTMLElement {
  const node = el('div', 'work-done-row');
  node.dataset['id'] = done.id;
  node.title = `${TICKETS_ARCHIVE_DIR}/${done.id}.md`;
  node.append(idNode(done.id), el('span', 'work-done-title', done.title ?? ''), el('span', 'work-row-age', done.at === '' ? '' : ageWords(done.at, Date.now())));
  if (deps.openArchived !== undefined) {
    node.classList.add('work-done-row-open');
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    const open = (): void => deps.openArchived?.(done.id);
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }
  return node;
}

/** "Show older" state: per window, like the folds -- never repo state. */
const older: { open: boolean; query: string; rows: readonly RecentDone[] | null; loading: boolean } = {
  open: false,
  query: '',
  rows: null,
  loading: false,
};

/**
 * The Done group's tail (E13-21): "Show older" loads the whole archive once and lists
 * the tickets beyond this week under a search field (id or title words). Rows open like
 * any Done row.
 */
function olderNodes(deps: WorkPanelDeps, snap: BoardSnapshot, rerender: () => void): HTMLElement[] {
  if (!older.open) {
    const more = el('button', 'work-ideas-more', 'Show older');
    more.type = 'button';
    more.addEventListener('click', () => {
      older.open = true;
      older.loading = true;
      older.rows = null;
      rerender();
      void deps
        .listArchived?.()
        .catch(() => [] as readonly RecentDone[])
        .then((rows) => {
          older.rows = rows ?? [];
          older.loading = false;
          rerender();
        });
    });
    return [more];
  }
  const recent = new Set(snap.recentDone.map((done) => done.id));
  const rows = (older.rows ?? []).filter((done) => !recent.has(done.id));
  const search = el('input', 'work-done-search');
  search.type = 'search';
  search.value = older.query;
  search.setAttribute('aria-label', 'Search older tickets');
  const list = el('div', 'work-done-older-rows');
  const empty = el('div', 'work-empty', older.loading ? 'Loading…' : 'No older tickets');
  const nodes = rows.map((done) => ({ done, node: doneRowNode(deps, done) }));
  const apply = (): void => {
    const words = older.query.toLowerCase().split(/\s+/).filter((word) => word !== '');
    let shown = 0;
    for (const { done, node } of nodes) {
      const hay = `${done.id} ${done.title ?? ''}`.toLowerCase();
      node.hidden = !words.every((word) => hay.includes(word));
      shown += node.hidden ? 0 : 1;
    }
    empty.hidden = shown > 0;
  };
  search.addEventListener('input', () => {
    older.query = search.value;
    apply();
  });
  list.append(...nodes.map((entry) => entry.node), empty);
  apply();
  return [search, list];
}
