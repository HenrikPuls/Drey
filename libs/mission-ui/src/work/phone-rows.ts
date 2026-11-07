import type { MessageKey, MessageParams } from '../../../../shared/i18n';
import {
  rowAgeOf,
  type McDoneEntry,
  type McLiveRunSlice,
  type NeedVm,
  type TicketVm,
  type WorkGroup,
} from './work.model';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** One row of the phone's Work list (board 10c): title, one grey line, the cost. */
export interface PhoneWorkRow {
  readonly key: string;
  readonly title: string;
  readonly meta: string;
  /** The iPad's grey line (10e): the same words without the age. */
  readonly padMeta: string;
  readonly cost: string | null;
  /** The ticket row's view model; null on a need without a board row or a done entry. */
  readonly ticket: TicketVm | null;
  readonly need: NeedVm | null;
  /** A plan waiting to be accepted: the row opens the plan, not the ticket (board 10c → 10j). */
  readonly plan: boolean;
  /** The ticket the row opens; null = a need with no ticket (it opens its persona, if any). */
  readonly ticketId: string | null;
}

export interface PhoneWorkGroup {
  readonly key: string;
  readonly title: string;
  readonly hot: boolean;
  /** The folded groups show head and count only until tapped; the live ones start open. */
  readonly startsOpen: boolean;
  readonly rows: readonly PhoneWorkRow[];
}

/** The state list's words decide the groups (canvas decision 15). */
const norm = (title: string): string => title.trim().toLowerCase();
const RUNNING_PHASE = 'building';
/** Reading order under the running group; a phase not named here follows, the folded ones last. */
const OPEN_ORDER = ['ready to try', 'shaping'];
const FOLDED_ORDER = ['prioritized', 'inbox'];
const DONE_PHASE = 'done';

const ticketsOf = (groups: readonly WorkGroup[]): readonly TicketVm[] =>
  groups.flatMap((group) => (group.kind === 'phase' ? group.tickets : []));

/** A need on a ticket in Shaping is about its plan: the row opens the plan to accept (10c → 10j). */
function isPlanRow(need: NeedVm, ticket: TicketVm | null): boolean {
  return ticket !== null && norm(ticket.phaseTitle) === 'shaping' && ['question', 'checkpoint', 'manual'].includes(need.need.kind);
}

function needWord(need: NeedVm, ticket: TicketVm | null, t: Translate): string | null {
  switch (need.need.kind) {
    case 'question':
      return isPlanRow(need, ticket) ? t('work.phone.plan_to_accept') : t('work.phone.question');
    case 'checkpoint':
    case 'manual':
      return isPlanRow(need, ticket) ? t('work.phone.plan_to_accept') : null;
    default:
      return need.kindLabel.toLowerCase();
  }
}

function needRow(need: NeedVm, tickets: readonly TicketVm[], now: number, t: Translate): PhoneWorkRow {
  const id = need.need.ticketId ?? null;
  const ticket = id === null ? null : (tickets.find((vm) => vm.id === id) ?? null);
  const age = ticket === null ? '' : rowAgeOf(ticket.sinceAt, now, t);
  const parts = [id, ticket?.phaseTitle ?? null, needWord(need, ticket, t), age].filter(
    (part): part is string => part !== null && part !== '',
  );
  return {
    key: need.key,
    title: ticket?.title ?? need.need.title,
    meta: parts.join(' · '),
    padMeta: [id, ticket?.phaseTitle ?? null, needWord(need, ticket, t)].filter((part): part is string => part !== null && part !== '').join(' · '),
    cost: ticket?.costLabel ?? null,
    ticket,
    need,
    plan: isPlanRow(need, ticket),
    ticketId: id,
  };
}

function runWord(vm: TicketVm, runs: readonly McLiveRunSlice[], now: number, t: Translate): string {
  const run = runs.find((candidate) => candidate.ticketId === vm.id);
  if (run === undefined) {
    return t('work.phone.queued');
  }
  if (run.stuck) {
    return t('work.phone.stuck', { age: rowAgeOf(run.lastActivity, now, t) });
  }
  return rowAgeOf(run.startedAt, now, t);
}

function ticketRow(vm: TicketVm, word: string, padWord = ''): PhoneWorkRow {
  return {
    key: vm.id,
    title: vm.title,
    meta: [vm.id, vm.phaseTitle, word].filter((part) => part !== '').join(' · '),
    padMeta: [vm.id, vm.phaseTitle, padWord].filter((part) => part !== '').join(' · '),
    cost: vm.costLabel,
    ticket: vm,
    need: null,
    plan: false,
    ticketId: vm.id,
  };
}

/**
 * The phone's groups (board 10c), from the same data as the wide list: Needs
 * you, Running (the Building column), Ready to try, Shaping, then the folded
 * Prioritized, Inbox and Done this week. Empty live groups leave; a folded
 * group stays only with something in it.
 */
export function phoneGroupsOf(
  all: readonly WorkGroup[],
  listed: readonly WorkGroup[],
  done: readonly McDoneEntry[],
  runs: readonly McLiveRunSlice[],
  now: number,
  t: Translate,
): readonly PhoneWorkGroup[] {
  const tickets = ticketsOf(all);
  const groups: PhoneWorkGroup[] = [];
  const needs = all.find((group) => group.kind === 'needs');
  if (needs !== undefined && needs.kind === 'needs') {
    groups.push({
      key: 'needs',
      title: t('work.phone.needs_you'),
      hot: true,
      startsOpen: true,
      rows: needs.needs.map((need) => needRow(need, tickets, now, t)),
    });
  }
  const phases = listed.flatMap((group) => (group.kind === 'phase' ? [group] : []));
  const byName = (name: string) => phases.find((group) => norm(group.title) === name) ?? null;
  const running = byName(RUNNING_PHASE);
  if (running !== null) {
    groups.push({
      key: running.key,
      title: t('work.phone.running'),
      hot: false,
      startsOpen: true,
      rows: running.tickets.map((vm) => {
        const word = runWord(vm, runs, now, t);
        return ticketRow(vm, word, word);
      }),
    });
  }
  const plain = (name: string | null, group: (typeof phases)[number], startsOpen: boolean): PhoneWorkGroup => ({
    key: group.key,
    title: group.title,
    hot: false,
    startsOpen,
    rows: group.tickets.map((vm) => ticketRow(vm, name === null ? '' : rowAgeOf(vm.sinceAt, now, t))),
  });
  for (const name of OPEN_ORDER) {
    const group = byName(name);
    if (group !== null) {
      groups.push(plain(name, group, true));
    }
  }
  const named = new Set([RUNNING_PHASE, DONE_PHASE, ...OPEN_ORDER, ...FOLDED_ORDER]);
  for (const group of phases) {
    if (!named.has(norm(group.title))) {
      groups.push(plain(null, group, true));
    }
  }
  for (const name of FOLDED_ORDER) {
    const group = byName(name);
    if (group !== null) {
      groups.push(plain(name, group, false));
    }
  }
  const doneColumn = byName(DONE_PHASE);
  const doneIds = new Set(done.map((entry) => entry.id));
  const doneRows: PhoneWorkRow[] = [
    ...done.map((entry) => ({
      key: entry.id,
      title: entry.title === null || entry.title === '' ? entry.id : entry.title,
      meta: entry.id,
      padMeta: entry.id,
      cost: null,
      ticket: null,
      need: null,
      plan: false,
      ticketId: entry.id,
    })),
    ...(doneColumn?.tickets ?? []).filter((vm) => !doneIds.has(vm.id)).map((vm) => ticketRow(vm, '')),
  ];
  if (doneRows.length > 0) {
    groups.push({ key: 'done', title: t('work.phone.done_week'), hot: false, startsOpen: false, rows: doneRows });
  }
  return groups;
}

/** Narrows the rows by the search words (id or title, every word must hit); empty groups leave. */
export function phoneGroupsFiltered(groups: readonly PhoneWorkGroup[], query: string): readonly PhoneWorkGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) {
    return groups;
  }
  return groups
    .map((group) => ({
      ...group,
      startsOpen: true,
      rows: group.rows.filter((row) => {
        const hay = `${row.ticketId ?? ''} ${row.title}`.toLowerCase();
        return words.every((word) => hay.includes(word));
      }),
    }))
    .filter((group) => group.rows.length > 0);
}

/** `$4.10`, and `$15` for a whole budget (the desktop status line's form). */
function dollars(value: number, whole: boolean): string {
  return whole && Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** Today's spend over the crew's budgets: `$4.10 of $15 today`; null when no cost is known. */
export function todayCostTextOf(today: { readonly cost: number | null; readonly budget: number | null } | null, t: Translate): string | null {
  if (today === null || today.cost === null) {
    return null;
  }
  const spent = dollars(today.cost, false);
  return today.budget === null
    ? t('status.cost.today', { cost: spent })
    : t('status.cost.of_budget', { cost: spent, budget: dollars(today.budget, true) });
}

/** Sums the personas' day figures; a missing figure is left out, never read as zero. */
export function todayOfPersonas(
  personas: readonly { readonly dailyCost?: number; readonly budget?: number | null }[] | null,
): { readonly cost: number | null; readonly budget: number | null } | null {
  if (personas === null) {
    return null;
  }
  const costs = personas.flatMap((p) => (typeof p.dailyCost === 'number' ? [p.dailyCost] : []));
  const budgets = personas.flatMap((p) => (typeof p.budget === 'number' ? [p.budget] : []));
  return {
    cost: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    budget: budgets.length === 0 ? null : budgets.reduce((a, b) => a + b, 0),
  };
}
