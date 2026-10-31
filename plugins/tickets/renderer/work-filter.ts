/**
 * The Work panel's filter (T-0084): a positive selection of phases and
 * statuses, applied to every group. View state like the folds —
 * per viewer in localStorage, never repo state. The popover toggles
 * chips that apply at once; the rows re-render behind it while it stays
 * open.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { BoardColumn } from '../shared/tickets';
import { phaseColorOf } from './phase-colors';
import { rowStatusOf, type WorkGroupId, type WorkGroups, type WorkRow, type WorkStatus } from './work-groups';

export interface WorkFilterState {
  /** Selected phase ids; an empty axis shows every phase. */
  readonly phases: readonly string[];
  /** Selected statuses; an empty axis shows every status. */
  readonly statuses: readonly string[];
}

export const NO_WORK_FILTER: WorkFilterState = { phases: [], statuses: [] };

export function isFilterActive(state: WorkFilterState): boolean {
  return state.phases.length > 0 || state.statuses.length > 0;
}

export interface FilteredGroup {
  /** The rows the filter lets through. */
  readonly rows: readonly WorkRow[];
  /** The group's size before the filter. */
  readonly total: number;
}

/** Filters every group by both axes — a row shows when it matches each
 *  active axis (an empty axis matches everything). */
export function applyWorkFilter(groups: WorkGroups, state: WorkFilterState): Record<WorkGroupId, FilteredGroup> {
  const phases = new Set(state.phases);
  const statuses = new Set(state.statuses);
  const filter = (rows: readonly WorkRow[]): FilteredGroup => ({
    rows: rows.filter(
      (row) =>
        (phases.size === 0 || phases.has(row.phase.id)) && (statuses.size === 0 || statuses.has(rowStatusOf(row))),
    ),
    total: rows.length,
  });
  // Done this week is the snapshot's recentDone, drawn unfiltered —
  // its entry exists only to satisfy the record's shape.
  return { needs: filter(groups.needs), shaping: filter(groups.shaping), running: filter(groups.running), ideas: filter(groups.ideas), done: { rows: [], total: 0 } };
}

/** The filter state, per viewer — the same lifetime as the group folds. */
export interface WorkFilterStore {
  get(): WorkFilterState;
  set(state: WorkFilterState): void;
}

const FILTER_KEY = 'drey.tickets.work.filter';

export function createWorkFilterStore(storage: Storage | null): WorkFilterStore {
  const read = (): WorkFilterState => {
    try {
      const raw = storage?.getItem(FILTER_KEY) ?? null;
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      const axes = (parsed ?? {}) as { phases?: unknown; statuses?: unknown };
      return {
        phases: Array.isArray(axes.phases) ? axes.phases.filter((x): x is string => typeof x === 'string') : [],
        statuses: Array.isArray(axes.statuses)
          ? axes.statuses.filter((x): x is string => typeof x === 'string')
          : [],
      };
    } catch {
      return NO_WORK_FILTER;
    }
  };
  let state = read();
  return {
    get: () => state,
    set: (next) => {
      state = { phases: [...next.phases], statuses: [...next.statuses] };
      try {
        storage?.setItem(FILTER_KEY, JSON.stringify(state));
      } catch {
        // A blocked storage keeps the filter for this session only.
      }
    },
  };
}

/** The statuses as the filter shows them, sentence case (T-0084). */
export const WORK_STATUS_LABEL: Readonly<Record<WorkStatus, string>> = {
  waiting: 'Waiting for you',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  blocked: 'Blocked',
  parked: 'Parked',
  review: 'Needs review',
  idle: 'Idle',
};

const STATUS_ORDER: readonly WorkStatus[] = ['waiting', 'review', 'failed', 'running', 'queued', 'blocked', 'parked', 'idle'];

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

/** Every column once, configured first, unknown directories after (they
 *  get chips and filter entries too, palette-coloured). */
function phaseChipsOf(columns: readonly BoardColumn[]): readonly { id: string; title: string; color: string }[] {
  const configured = columns.filter((column) => !column.unknown);
  const positionOf = new Map<string, number>();
  configured.forEach((column, index) => positionOf.set(column.phase.id, index));
  let afterConfigured = configured.length;
  const chips: { id: string; title: string; color: string }[] = [];
  for (const column of columns) {
    let position = positionOf.get(column.phase.id);
    if (position === undefined) {
      position = afterConfigured++;
      positionOf.set(column.phase.id, position);
    }
    chips.push({ id: column.phase.id, title: column.phase.title, color: phaseColorOf(column.phase, position) });
  }
  return chips;
}

/**
 * The filter popover (`role="dialog"`): a head row with **Clear**, a
 * Phases and a Statuses section of toggle chips. Every toggle applies at
 * once through `onApply` — the caller repaints the rows behind the open
 * popover, and the popover repaints itself from the next state.
 */
export function filterPopover(deps: {
  api: DreyPluginApi;
  columns: readonly BoardColumn[];
  state: WorkFilterState;
  onApply(next: WorkFilterState): void;
}): HTMLElement {
  let current: WorkFilterState = { phases: [...deps.state.phases], statuses: [...deps.state.statuses] };
  const pop = el('div', 'work-filter-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Filter by phase and status');

  const apply = (next: WorkFilterState): void => {
    current = next;
    deps.onApply(next);
    paint();
  };
  const toggle = (axis: 'phases' | 'statuses', value: string): void => {
    const selected = new Set(current[axis]);
    if (selected.has(value)) {
      selected.delete(value);
    } else {
      selected.add(value);
    }
    apply(
      axis === 'phases'
        ? { phases: [...selected], statuses: current.statuses }
        : { phases: current.phases, statuses: [...selected] },
    );
  };

  const paint = (): void => {
    const head = el('div', 'work-filter-head');
    head.append(el('span', 'work-filter-title', 'Filter'));
    const clear = el('button', 'work-filter-clear', 'Clear');
    clear.type = 'button';
    clear.title = 'Show everything again';
    clear.disabled = !isFilterActive(current);
    clear.addEventListener('click', () => apply(NO_WORK_FILTER));
    head.append(clear);

    const chip = (label: string, pressed: boolean, kind: 'phase' | 'status', color: string | null, onToggle: () => void): HTMLElement => {
      const b = el('button', `work-filter-chip work-filter-chip-${kind}${pressed ? ' work-filter-chip-on' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(pressed));
      const dot = el('span', 'work-filter-dot');
      if (color !== null) {
        b.style.setProperty('--chip-color', color);
      }
      b.append(dot, el('span', 'work-filter-chip-label', label));
      b.addEventListener('click', () => {
        onToggle();
        // The repaint replaced this node — hand focus to its successor.
        [...pop.querySelectorAll<HTMLButtonElement>('.work-filter-chip')]
          .find((x) => x.textContent === label)
          ?.focus();
      });
      return b;
    };

    const phaseSection = el('div', 'work-filter-section');
    phaseSection.append(el('span', 'work-filter-label', 'Phases'));
    const phaseChips = el('div', 'work-filter-chips');
    for (const phase of phaseChipsOf(deps.columns)) {
      phaseChips.append(
        chip(phase.title, current.phases.includes(phase.id), 'phase', phase.color, () => toggle('phases', phase.id)),
      );
    }
    phaseSection.append(phaseChips);

    const statusSection = el('div', 'work-filter-section');
    statusSection.append(el('span', 'work-filter-label', 'Statuses'));
    const statusChips = el('div', 'work-filter-chips');
    for (const status of STATUS_ORDER) {
      statusChips.append(
        chip(WORK_STATUS_LABEL[status], current.statuses.includes(status), 'status', null, () => toggle('statuses', status)),
      );
    }
    statusSection.append(statusChips);

    pop.replaceChildren(head, phaseSection, statusSection);
  };
  paint();
  return pop;
}
