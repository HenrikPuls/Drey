// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RunInfo } from '../main/fleet/protocol';
import {
  phaseWithoutPoolKeys,
  type BoardColumn,
  type BoardSnapshot,
  type PipelinePhase,
  type TicketCard,
} from '../shared/tickets';
import { workGroups, type WorkGroups } from './work-groups';
import {
  applyWorkFilter,
  createWorkFilterStore,
  filterPopover,
  isFilterActive,
  NO_WORK_FILTER,
} from './work-filter';

/** T-0084: the Work panel's filter — state, store, apply and popover. */

const phase = (id: string, handover: string): PipelinePhase =>
  phaseWithoutPoolKeys({ id, title: id[0]!.toUpperCase() + id.slice(1), wip: null, claim: false, handover });

const PIPELINE: readonly PipelinePhase[] = [
  phase('inbox', 'manual'),
  phase('prioritized', 'manual'),
  phase('plan', 'agent plan-default'),
  phase('plan-review', 'manual'),
  phase('build', 'agent build-default'),
  phase('review', 'manual'),
  phase('commit', 'agent commit-default'),
  phase('done', 'none'),
];

const card = (id: string, at: string, blocked: readonly string[] = []): TicketCard =>
  ({
    id,
    path: `tickets/${at}/${id}.md`,
    phase: at,
    meta: { title: `Ticket ${id}`, priority: 'normal', parkedReason: null, entered: { inbox: '2026-10-30T10:00:00Z' } },
    blocked,
    blocks: [],
    issues: [],
  }) as unknown as TicketCard;

const board = (placed: Record<string, readonly TicketCard[]>): BoardSnapshot =>
  ({
    columns: PIPELINE.map((p): BoardColumn => ({ phase: p, unknown: false, tickets: placed[p.id] ?? [] })),
    checkpoints: ['plan-review', 'review', 'done'],
  }) as unknown as BoardSnapshot;

const run = (ticketId: string): RunInfo =>
  ({ id: `r-${ticketId}`, ticketId, provider: 'opencode', state: 'running', startedAt: '2026-10-30T10:00:00Z' }) as unknown as RunInfo;

const groupsOf = (): WorkGroups =>
  workGroups(
    board({
      inbox: [card('T-0001', 'inbox')],
      plan: [card('T-0002', 'plan')],
      build: [card('T-0003', 'build')],
    }),
    [run('T-0003')],
  );

const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage;
};

describe('WorkFilterState / isFilterActive', () => {
  it('no selection is inactive; either axis alone is active', () => {
    expect(isFilterActive(NO_WORK_FILTER)).toBe(false);
    expect(isFilterActive({ phases: ['build'], statuses: [] })).toBe(true);
    expect(isFilterActive({ phases: [], statuses: ['running'] })).toBe(true);
  });
});

describe('createWorkFilterStore', () => {
  it('round-trips like the folds and survives a fresh store over the same storage', () => {
    const storage = memoryStorage();
    const store = createWorkFilterStore(storage);
    expect(store.get()).toEqual(NO_WORK_FILTER);
    store.set({ phases: ['build', 'plan'], statuses: ['running'] });
    expect(store.get()).toEqual({ phases: ['build', 'plan'], statuses: ['running'] });
    expect(createWorkFilterStore(storage).get()).toEqual({ phases: ['build', 'plan'], statuses: ['running'] });
  });

  it('a blocked or corrupt storage falls back to no filter', () => {
    expect(createWorkFilterStore(null).get()).toEqual(NO_WORK_FILTER);
    const storage = memoryStorage();
    storage.setItem('drey.tickets.work.filter', '{not json');
    expect(createWorkFilterStore(storage).get()).toEqual(NO_WORK_FILTER);
    storage.setItem('drey.tickets.work.filter', JSON.stringify({ phases: [42], statuses: null }));
    expect(createWorkFilterStore(storage).get()).toEqual({ phases: [], statuses: [] });
  });
});

describe('applyWorkFilter', () => {
  it('filters by phase, by status, and by both — totals stay the unfiltered size', () => {
    const groups = groupsOf();
    const ids = (rows: readonly { card: TicketCard }[]): string[] => rows.map((r) => r.card.id);
    const byPhase = applyWorkFilter(groups, { phases: ['build'], statuses: [] });
    expect(ids(byPhase.running.rows)).toEqual(['T-0003']);
    expect(byPhase.running.total).toBe(2);
    expect(byPhase.ideas.rows).toHaveLength(0); // the idea is in inbox, not build
    expect(byPhase.ideas.total).toBe(1);

    const byStatus = applyWorkFilter(groups, { phases: [], statuses: ['running'] });
    expect(ids(byStatus.running.rows)).toEqual(['T-0003']);
    expect(byStatus.running.total).toBe(2);

    const both = applyWorkFilter(groups, { phases: ['plan'], statuses: ['running'] });
    expect(both.running.rows).toHaveLength(0); // plan matches, running does not
    expect(both.running.total).toBe(2);
  });

  it('an empty axis shows all — the no-filter state changes nothing', () => {
    const groups = groupsOf();
    const all = applyWorkFilter(groups, NO_WORK_FILTER);
    expect(all.running.rows).toHaveLength(groups.running.length);
    expect(all.needs.total).toBe(groups.needs.length);
  });
});

describe('filterPopover', () => {
  const api = { ui: { icon: () => document.createElement('span') } } as unknown as DreyPluginApi;

  it('lists phase chips with titles and colour vars, and the eight status labels', () => {
    const pop = filterPopover({ api, columns: board({}).columns, state: NO_WORK_FILTER, onApply: () => undefined });
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(pop.getAttribute('aria-label')).toBe('Filter by phase and status');
    const labels = [...pop.querySelectorAll('.work-filter-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Phases', 'Statuses']);
    const chips = [...pop.querySelectorAll<HTMLButtonElement>('.work-filter-chip')];
    const statusLabels = ['Waiting for you', 'Needs review', 'Failed', 'Running', 'Queued', 'Blocked', 'Parked', 'Idle'];
    expect(chips.map((c) => c.textContent)).toEqual([...PIPELINE.map((p) => p.title), ...statusLabels]);
    const build = chips[4]!;
    expect(build.style.getPropertyValue('--chip-color')).not.toBe('');
    expect(build.getAttribute('aria-pressed')).toBe('false');
    // Clear starts disabled: nothing is filtered.
    expect((pop.querySelector('.work-filter-clear') as HTMLButtonElement).disabled).toBe(true);
  });

  it('toggling chips applies at once with the next state; Clear resets both axes', () => {
    const applied: unknown[] = [];
    const pop = filterPopover({
      api,
      columns: board({}).columns,
      state: NO_WORK_FILTER,
      onApply: (next) => applied.push(next),
    });
    const chips = [...pop.querySelectorAll<HTMLButtonElement>('.work-filter-chip')];
    chips[4]!.click(); // phase Build
    expect(applied.at(-1)).toEqual({ phases: ['build'], statuses: [] });
    expect(chips[4]!.getAttribute('aria-pressed')).toBe('false'); // the pre-toggle node
    expect([...pop.querySelectorAll('.work-filter-chip')][4]!.getAttribute('aria-pressed')).toBe('true');
    const running = [...pop.querySelectorAll<HTMLButtonElement>('.work-filter-chip')].find(
      (c) => c.textContent === 'Running',
    )!;
    running.click();
    expect(applied.at(-1)).toEqual({ phases: ['build'], statuses: ['running'] });
    const clear = pop.querySelector('.work-filter-clear') as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(applied.at(-1)).toEqual(NO_WORK_FILTER);
    expect((pop.querySelector('.work-filter-clear') as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts from a given state — a pressed chip toggles off', () => {
    const applied: unknown[] = [];
    const pop = filterPopover({
      api,
      columns: board({}).columns,
      state: { phases: ['build'], statuses: [] },
      onApply: (next) => applied.push(next),
    });
    const build = [...pop.querySelectorAll<HTMLButtonElement>('.work-filter-chip')][4]!;
    expect(build.getAttribute('aria-pressed')).toBe('true');
    build.click();
    expect(applied.at(-1)).toEqual(NO_WORK_FILTER);
  });

  it('unknown phase directories get a chip too', () => {
    const limbo: BoardColumn = { phase: phase('limbo', 'manual'), unknown: true, tickets: [] };
    const snap = board({});
    const pop = filterPopover({ api, columns: [...snap.columns, limbo], state: NO_WORK_FILTER, onApply: () => undefined });
    const titles = [...pop.querySelectorAll('.work-filter-chip')].map((c) => c.textContent);
    expect(titles).toContain('Limbo');
  });
});
