/**
 * The work tab's specs: the pure group/next-phase logic plus the header's
 * helpers (vault sub, Fleet chip, the card's tolerant cost/Σ-tokens/ctx/
 * wait slots), then the component class against a fake state object — no
 * DOM (the unit-test builder runs these under jsdom, but nothing here
 * renders a template). The improvements card's tap and the scout report
 * card's promote (E8) close the file.
 */
import type { Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Work } from './work';
import {
  MC_WORK_STATE,
  NEED_KIND_LABELS,
  blockerIdsOf,
  costLabelOf,
  ctxPercentOf,
  displayTitleOf,
  fleetLabelOf,
  groupsOf,
  isBlockedTicket,
  isFlaggedTicket,
  liveRunCountOf,
  needKindLabelOf,
  nextPhaseOf,
  personaInitialOf,
  personaMapOf,
  tokensSumLabelOf,
  vaultTitleOf,
  type McBoard,
  type McNeed,
  type McPersona,
  type McRun,
  type McScoutReport,
  type McTicket,
  type McWorkState,
  type NeedVm,
  type TicketVm,
  type WorkGroup,
} from './work.model';

// --- fakes -----------------------------------------------------------------------

function ticket(id: string, extra: Partial<McTicket> = {}): McTicket {
  return { title: null, blocked: [], meta: {}, ...extra, id };
}

function need(kind: string, title: string, extra: Partial<McNeed> = {}): McNeed {
  return { kind, title, summary: '', ...extra };
}

function persona(id: string, color = '#7aa2f7'): McPersona {
  return { id, title: id.toUpperCase(), color };
}

interface FakeState extends McWorkState {
  needs: McNeed[];
  board: McBoard | null;
  personas: McPersona[];
  readOnly: boolean;
  runs?: readonly McRun[] | null;
  toast?: (message: string, kind?: 'ok' | 'warn' | 'error') => void;
  moveResults: McMoveResultForTest[];
}

type McMoveResultForTest = { ok: boolean; error?: string };

// The fake needs a self-reference inside moveTicket (the recorded calls
// and the queued results); build it in one place so each spec gets an
// isolated, fully wired fake.
interface MoveCall {
  ticketId: string;
  phaseId: string;
}

function makeFake(patch: Partial<FakeState> = {}): { state: FakeState; calls: MoveCall[] } {
  const calls: MoveCall[] = [];
  const state = {
    needs: [],
    board: null,
    personas: [],
    readOnly: false,
    moveResults: [{ ok: true }] as McMoveResultForTest[],
    ...patch,
  } as FakeState;
  state.moveTicket = (ticketId: string, phaseId: string) => {
    calls.push({ ticketId, phaseId });
    const result = state.moveResults.shift() ?? { ok: true };
    return Promise.resolve(result);
  };
  return { state, calls };
}

// The component's template-facing surface is protected; these specs drive
// the class directly, so expose it through one typed lens.
interface WorkSurface {
  groups: Signal<WorkGroup[]>;
  readOnly: Signal<boolean>;
  vaultTitle: Signal<string | null>;
  liveRuns: Signal<number | null>;
  fleetLabel: Signal<string>;
  fleetLive: Signal<boolean>;
  openCard: Signal<TicketVm | null>;
  moveError: Signal<string | null>;
  movePending: Signal<boolean>;
  moveTarget: Signal<{ phaseId: string; title: string } | null>;
  openSheet(card: TicketVm): void;
  closeSheet(): void;
  moveOn(): Promise<void>;
  needTappable(vm: NeedVm): boolean;
  openNeedPersona(vm: NeedVm): void;
  onFleetTap(): void;
}

function surface(work: Work): WorkSurface {
  return work as unknown as WorkSurface;
}

/** The group's first card, when it is a phase group (template-free specs). */
function firstCard(group: WorkGroup | undefined): TicketVm | null {
  return group?.kind === 'phase' ? (group.tickets[0] ?? null) : null;
}

function setup(fake: FakeState | null): Work {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: fake === null ? [] : [{ provide: MC_WORK_STATE, useValue: fake }],
  });
  return TestBed.runInInjectionContext(() => new Work());
}

// --- the pure group logic ----------------------------------------------------------

describe('groupsOf', () => {
  const board: McBoard = {
    checkpoints: ['verify'],
    columns: [
      { phase: { id: 'inbox', title: 'Inbox' }, tickets: [] },
      {
        phase: { id: 'build', title: 'Build', color: '#123456' },
        tickets: [
          ticket('T-0001', { title: 'Wire the board' }),
          ticket('T-0002', {
            meta: { priority: 'urgent', persona: 'tessa' },
            blocked: ['T-0001'],
          }),
        ],
      },
      {
        phase: { id: 'lost', title: 'lost' },
        tickets: [ticket('T-0009')],
        unknown: true,
      },
    ],
  };

  it('puts the needs-you group first, then the board groups in order', () => {
    const groups = groupsOf([need('question', 'Pick a lane')], board, []);
    expect(groups.map((g) => g.kind)).toEqual(['needs', 'phase', 'phase', 'phase']);
    expect(groups.map((g) => g.title)).toEqual(['Braucht dich', 'Inbox', 'Build', 'lost']);
  });

  it('omits the needs group when nothing waits', () => {
    const groups = groupsOf([], board, []);
    expect(groups.every((g) => g.kind === 'phase')).toBe(true);
  });

  it('renders just the needs group while the board is null', () => {
    const groups = groupsOf([need('failed', 'Run died')], null, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('needs');
    expect(groupsOf([], null, [])).toEqual([]);
  });

  it('keeps empty columns as groups with an empty ticket list', () => {
    const groups = groupsOf([], board, []);
    const inbox = groups.find((g) => g.kind === 'phase' && g.phaseId === 'inbox');
    expect(inbox && inbox.kind === 'phase' ? inbox.tickets : null).toEqual([]);
  });

  it('marks unknown columns but still renders their tickets', () => {
    const groups = groupsOf([], board, []);
    const lost = groups.find((g) => g.kind === 'phase' && g.phaseId === 'lost');
    expect(lost && lost.kind === 'phase' ? lost.unknown : null).toBe(true);
    const build = groups.find((g) => g.kind === 'phase' && g.phaseId === 'build');
    expect(build && build.kind === 'phase' ? build.unknown : null).toBe(false);
  });

  it('builds need cards with the kind chip label and the ticket id', () => {
    const groups = groupsOf(
      [need('red-gate', 'Gate is red', { ticketId: 'T-0002', summary: 'tests failed' })],
      null,
      [],
    );
    const first = groups[0];
    if (first?.kind !== 'needs') {
      throw new Error('expected the needs group');
    }
    const vm: NeedVm = first.needs[0]!;
    expect(vm.kindLabel).toBe('Gate red');
    expect(vm.need.ticketId).toBe('T-0002');
    expect(vm.need.summary).toBe('tests failed');
  });

  it('keys an improvements need on its persona title, stable across refreshes (E6)', () => {
    const keyOf = (groups: WorkGroup[], title: string): string | undefined => {
      const group = groups[0];
      return group?.kind === 'needs'
        ? group.needs.find((n) => n.need.title === title)?.key
        : undefined;
    };
    const first = groupsOf(
      [need('improvements', 'Pia', { ticketId: '' }), need('question', 'Ask')],
      null,
      [],
    );
    const refreshed = groupsOf(
      [need('question', 'New one'), need('improvements', 'Pia', { ticketId: '' })],
      null,
      [],
    );
    // The title is the persona title (the engine's guarantee): the key
    // survives a refresh that shifts the list around it.
    expect(keyOf(first, 'Pia')).toBe('improvements:Pia');
    expect(keyOf(refreshed, 'Pia')).toBe('improvements:Pia');
    expect(keyOf(refreshed, 'New one')).toBe('question:none:0');
  });

  it('builds ticket cards with title, phase, persona, flag and blocked state', () => {
    const groups = groupsOf([], board, [persona('tessa', '#ff8800')]);
    const build = groups.find((g) => g.kind === 'phase' && g.phaseId === 'build');
    if (build?.kind !== 'phase') {
      throw new Error('expected the build group');
    }
    const [first, second] = build.tickets as [TicketVm, TicketVm];
    expect(first.title).toBe('Wire the board');
    expect(first.persona).toBeNull();
    expect(first.personaInitial).toBeNull();
    expect(first.flagged).toBe(false);
    expect(first.blocked).toBe(false);
    expect(first.phaseColor).toBe('#123456');
    expect(second.title).toBe('T-0002');
    expect(second.flagged).toBe(true);
    expect(second.blocked).toBe(true);
    expect(second.blockers).toEqual(['T-0001']);
    expect(second.persona?.color).toBe('#ff8800');
    expect(second.personaInitial).toBe('T');
  });

  it('fills the card’s cost, ctx and wait slots only from present data — never a 0-fake', () => {
    const configured: McBoard = {
      columns: [
        {
          phase: { id: 'build', title: 'Build' },
          tickets: [
            ticket('T-0001', { cost: 0.44, ctx: 58.4 }),
            ticket('T-0002', { cost: null, ctx: undefined, meta: { blockedBy: ['T-0007'] } }),
            ticket('T-0003', { cost: 0, ctx: 101 }),
          ],
        },
      ],
    };
    const groups = groupsOf([], configured, []);
    const build = groups.find((g) => g.kind === 'phase' && g.phaseId === 'build');
    if (build?.kind !== 'phase') {
      throw new Error('expected the build group');
    }
    const [rich, waiting, junk] = build.tickets as [TicketVm, TicketVm, TicketVm];
    expect(rich.costLabel).toBe('0,44 $');
    expect(rich.ctxPercent).toBe(58);
    expect(rich.blocked).toBe(false);
    expect(waiting.costLabel).toBeNull();
    expect(waiting.ctxPercent).toBeNull();
    expect(waiting.blockers).toEqual(['T-0007']);
    expect(junk.costLabel).toBeNull();
    expect(junk.ctxPercent).toBeNull();
    expect(junk.blocked).toBe(false);
  });

  it('reads the cost and Σ slots off the card’s usage — only when the ledger has data', () => {
    const configured: McBoard = {
      columns: [
        {
          phase: { id: 'build', title: 'Build' },
          tickets: [
            ticket('T-0001', { usage: { tokensIn: 48000, tokensOut: 6000, cost: 1.87, runs: 2 } }),
            ticket('T-0002', { usage: { tokensIn: 4000, tokensOut: 1000, cost: null, runs: 1 } }),
            ticket('T-0003', { usage: { tokensIn: 0, tokensOut: 0, cost: 0, runs: 1 } }),
            ticket('T-0004'),
            ticket('T-0005', { usage: { tokensIn: 'x', tokensOut: null, cost: 'n/a' } as never }),
            // The legacy cost field stays the fallback when no usage rides along.
            ticket('T-0006', { cost: 0.44 }),
            ticket('T-0007', { cost: 0.44, usage: { tokensIn: 1000, tokensOut: 0, cost: 1.17, runs: 1 } }),
          ],
        },
      ],
    };
    const build = groupsOf([], configured, []).find((g) => g.kind === 'phase' && g.phaseId === 'build');
    if (build?.kind !== 'phase') {
      throw new Error('expected the build group');
    }
    const [full, tokensOnly, zero, bare, junk, legacy, both] = build.tickets as TicketVm[];
    expect(full.costLabel).toBe('1,87 $');
    expect(full.tokensLabel).toBe('Σ 54k');
    // A known token count without a cost: the Σ slot shows, the cost slot hides.
    expect(tokensOnly.costLabel).toBeNull();
    expect(tokensOnly.tokensLabel).toBe('Σ 5k');
    // Zero everything: both slots hide — never a 0-fake.
    expect(zero.costLabel).toBeNull();
    expect(zero.tokensLabel).toBeNull();
    expect(bare.costLabel).toBeNull();
    expect(bare.tokensLabel).toBeNull();
    // Junk counters read as nothing usable.
    expect(junk.costLabel).toBeNull();
    expect(junk.tokensLabel).toBeNull();
    expect(legacy.costLabel).toBe('0,44 $');
    expect(legacy.tokensLabel).toBeNull();
    // Usage wins over the legacy field when both ride along.
    expect(both.costLabel).toBe('1,17 $');
    expect(both.tokensLabel).toBe('Σ 1k');
  });

  it('flags cards by the board’s configured vocabulary when mapping the groups', () => {
    const configured: McBoard = {
      priorities: { order: ['meh', 'ok', 'hot'], default: 'ok' },
      columns: [
        {
          phase: { id: 'build', title: 'Build' },
          tickets: [
            ticket('T-0001', { meta: { priority: 'meh' } }), // index 0 — before the split: flag
            ticket('T-0002', { meta: { priority: 'ok' } }), // index 1 — the default slot: calm
            ticket('T-0003', { meta: { priority: 'hot' } }), // not in the vocabulary: never flags
          ],
        },
      ],
    };
    const groups = groupsOf([], configured, []);
    const build = groups.find((g) => g.kind === 'phase' && g.phaseId === 'build');
    if (build?.kind !== 'phase') {
      throw new Error('expected the build group');
    }
    expect(build.tickets.map((vm) => vm.flagged)).toEqual([true, false, false]);
  });
});

describe('nextPhaseOf', () => {
  const board: McBoard = {
    columns: [
      { phase: { id: 'inbox', title: 'Inbox' }, tickets: [] },
      { phase: { id: 'build', title: 'Build' }, tickets: [] },
      { phase: { id: 'lost', title: 'lost' }, tickets: [], unknown: true },
      { phase: { id: 'verify', title: 'Verify' }, tickets: [] },
      { phase: { id: 'done', title: 'Done' }, tickets: [] },
    ],
  };
  const groups = groupsOf([need('question', 'waiting')], board, []);

  it('returns the next phase group in board order', () => {
    const next = nextPhaseOf(groups, 'build');
    expect(next?.phaseId).toBe('verify');
    expect(next?.title).toBe('Verify');
  });

  it('skips the needs group — it is not a phase', () => {
    expect(nextPhaseOf(groups, 'inbox')?.phaseId).toBe('build');
  });

  it('skips unknown columns in both directions', () => {
    expect(nextPhaseOf(groups, 'build')?.phaseId).toBe('verify');
    expect(nextPhaseOf(groups, 'verify')?.phaseId).toBe('done');
  });

  it('returns null on the last phase, an unknown phase or an absent one', () => {
    expect(nextPhaseOf(groups, 'done')).toBeNull();
    expect(nextPhaseOf(groups, 'lost')).toBeNull();
    expect(nextPhaseOf(groups, 'nope')).toBeNull();
  });
});

describe('card helpers', () => {
  it('labels the known need kinds and passes unknown ones through', () => {
    expect(NEED_KIND_LABELS).toEqual({
      question: 'Asks you',
      permission: 'Wants permission',
      'red-gate': 'Gate red',
      failed: 'Run failed',
      checkpoint: 'Checkpoint',
      improvements: 'Improvements',
      'needs-decision': 'Needs decision',
      blocked: 'Blocked',
      report: 'Scout report',
      notify: 'Gate done',
    });
    expect(needKindLabelOf('question')).toBe('Asks you');
    expect(needKindLabelOf('improvements')).toBe('Improvements');
    expect(needKindLabelOf('needs-decision')).toBe('Needs decision');
    expect(needKindLabelOf('blocked')).toBe('Blocked');
    expect(needKindLabelOf('report')).toBe('Scout report');
    expect(needKindLabelOf('notify')).toBe('Gate done');
    expect(needKindLabelOf('mystery')).toBe('mystery');
  });

  it('falls back to the id when the title is absent or blank', () => {
    expect(displayTitleOf(ticket('T-0001'))).toBe('T-0001');
    expect(displayTitleOf(ticket('T-0001', { title: '  ' }))).toBe('T-0001');
    expect(displayTitleOf(ticket('T-0001', { title: 'Ship it' }))).toBe('Ship it');
  });

  it('flags the default vocabulary’s jump class (urgent, high)', () => {
    expect(isFlaggedTicket(ticket('a', { meta: { priority: 'urgent' } }))).toBe(true);
    expect(isFlaggedTicket(ticket('b', { meta: { priority: 'high' } }))).toBe(true);
    expect(isFlaggedTicket(ticket('c', { meta: { priority: 'normal' } }))).toBe(false);
    expect(isFlaggedTicket(ticket('e', { meta: { priority: 'low' } }))).toBe(false);
    expect(isFlaggedTicket(ticket('d'))).toBe(false);
  });

  it('flags by the configured vocabulary — a configured order flips the flag', () => {
    const flipped = { order: ['low', 'normal', 'high', 'urgent'], default: 'normal' };
    expect(isFlaggedTicket(ticket('a', { meta: { priority: 'low' } }), flipped)).toBe(true);
    expect(isFlaggedTicket(ticket('b', { meta: { priority: 'urgent' } }), flipped)).toBe(false);
    const custom = { order: ['p0', 'p1', 'p2', 'p3'], default: 'p2' };
    expect(isFlaggedTicket(ticket('c', { meta: { priority: 'p1' } }), custom)).toBe(true);
    expect(isFlaggedTicket(ticket('d', { meta: { priority: 'p2' } }), custom)).toBe(false);
    // Odd lengths split at floor(len/2): only the entries before it jump.
    const odd = { order: ['a', 'b', 'c'], default: 'b' };
    expect(isFlaggedTicket(ticket('e', { meta: { priority: 'a' } }), odd)).toBe(true);
    expect(isFlaggedTicket(ticket('f', { meta: { priority: 'b' } }), odd)).toBe(false);
  });

  it('never flags an unknown or missing priority, in any vocabulary', () => {
    const config = { order: ['p0', 'p1', 'p2', 'p3'], default: 'p2' };
    expect(isFlaggedTicket(ticket('a', { meta: { priority: 'zzz' } }), config)).toBe(false);
    expect(isFlaggedTicket(ticket('b', { meta: { priority: 'urgent' } }), config)).toBe(false);
    expect(isFlaggedTicket(ticket('c'), config)).toBe(false);
  });

  it('marks blocked from the derived list or the raw blocked-by list', () => {
    expect(isBlockedTicket(ticket('a', { blocked: ['T-0002'] }))).toBe(true);
    expect(isBlockedTicket(ticket('b', { meta: { blockedBy: ['T-0003'] } }))).toBe(true);
    expect(isBlockedTicket(ticket('c'))).toBe(false);
  });

  it('resolves persona colours by id', () => {
    const map = personaMapOf([persona('tessa', '#ff8800'), persona('pia', '#00ff88')]);
    expect(map.get('pia')?.color).toBe('#00ff88');
    expect(map.get('ghost')).toBeUndefined();
  });
});

// --- the header's helpers (vault sub, Fleet chip, slot formatters) -----------------

describe('header helpers', () => {
  it('names the vault for the header sub: vaultName first, the folder name as fallback', () => {
    expect(vaultTitleOf({ vaultName: 'lariscus', activeVaultName: 'vault-dir' } as McBoard)).toBe(
      'lariscus',
    );
    expect(vaultTitleOf({ vaultName: null, activeVaultName: 'vault-dir' } as McBoard)).toBe(
      'vault-dir',
    );
    expect(vaultTitleOf({ activeVaultName: '  spaced  ' } as McBoard)).toBe('spaced');
    // Tolerance: blank on both, absent, junk — the sub line hides instead.
    expect(vaultTitleOf({ vaultName: '   ', activeVaultName: '' } as McBoard)).toBeNull();
    expect(vaultTitleOf({} as McBoard)).toBeNull();
    expect(vaultTitleOf(null)).toBeNull();
    expect(vaultTitleOf({ vaultName: 42 } as unknown as McBoard)).toBeNull();
  });

  it('derives the wait-line’s ids: the OPEN blockers first, the raw blocked-by as fallback', () => {
    expect(blockerIdsOf(ticket('a', { blocked: ['T-0002', 'T-0003'] }))).toEqual([
      'T-0002',
      'T-0003',
    ]);
    expect(blockerIdsOf(ticket('a', { blocked: [], meta: { blockedBy: ['T-0009'] } }))).toEqual([
      'T-0009',
    ]);
    expect(blockerIdsOf(ticket('a', { blocked: [], meta: {} }))).toEqual([]);
    expect(blockerIdsOf(ticket('a'))).toEqual([]);
  });

  it('formats the cost slot German-style; absent, zero and junk hide the slot', () => {
    expect(costLabelOf(0.44)).toBe('0,44 $');
    expect(costLabelOf(1.87)).toBe('1,87 $');
    expect(costLabelOf(12)).toBe('12,00 $');
    expect(costLabelOf(null)).toBeNull();
    expect(costLabelOf(undefined)).toBeNull();
    expect(costLabelOf(0)).toBeNull();
    expect(costLabelOf(-3)).toBeNull();
    expect(costLabelOf(Number.NaN)).toBeNull();
    expect(costLabelOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('labels the Σ token slot off the usage; absent, zero and junk hide it', () => {
    expect(tokensSumLabelOf({ tokensIn: 48000, tokensOut: 6000, cost: 1.87, runs: 2 })).toBe('Σ 54k');
    expect(tokensSumLabelOf({ tokensIn: 999, tokensOut: 1, cost: null, runs: 1 })).toBe('Σ 1k');
    expect(tokensSumLabelOf({ tokensIn: 1_700_000, tokensOut: 0, cost: null, runs: 1 })).toBe('Σ 1.7M');
    expect(tokensSumLabelOf({ tokensIn: 0, tokensOut: 800, cost: null, runs: 1 })).toBe('Σ 800');
    expect(tokensSumLabelOf({ tokensIn: 0, tokensOut: 0, cost: 1.17, runs: 1 })).toBeNull();
    expect(tokensSumLabelOf({ tokensIn: 'x', tokensOut: null, cost: null, runs: 0 } as unknown as Parameters<typeof tokensSumLabelOf>[0])).toBeNull();
    expect(tokensSumLabelOf(undefined)).toBeNull();
    expect(tokensSumLabelOf(null)).toBeNull();
  });

  it('rounds the ctx slot to a 1–100 percent; 0 and out-of-range junk hide the bar', () => {
    expect(ctxPercentOf(58.4)).toBe(58);
    expect(ctxPercentOf(1)).toBe(1);
    expect(ctxPercentOf(100)).toBe(100);
    expect(ctxPercentOf(0)).toBeNull();
    expect(ctxPercentOf(101)).toBeNull();
    expect(ctxPercentOf(null)).toBeNull();
    expect(ctxPercentOf(undefined)).toBeNull();
    expect(ctxPercentOf(Number.NaN)).toBeNull();
  });

  it('takes the persona chip’s initial from the title’s first character, uppercased', () => {
    expect(personaInitialOf('Pia')).toBe('P');
    expect(personaInitialOf('tessa')).toBe('T');
    expect(personaInitialOf('  Ralf ')).toBe('R');
    expect(personaInitialOf('')).toBe('');
  });

  it('counts the fleet’s live runs; without run data the count stays unknown (null)', () => {
    const run = (state: string): McRun => ({ state });
    expect(liveRunCountOf([run('running'), run('starting'), run('done'), run('failed')])).toBe(2);
    expect(liveRunCountOf([run('stopping'), run('detached')])).toBe(2);
    expect(liveRunCountOf([run('stopped'), run('done'), { state: null }, {}])).toBe(0);
    expect(liveRunCountOf([])).toBe(0);
    expect(liveRunCountOf(null)).toBeNull();
    expect(liveRunCountOf(undefined)).toBeNull();
  });

  it('labels the Fleet chip: the count when data exist, the bare word without', () => {
    expect(fleetLabelOf(3)).toBe('3 aktiv');
    expect(fleetLabelOf(0)).toBe('0 aktiv');
    expect(fleetLabelOf(null)).toBe('Fleet');
  });
});

// --- the component class -----------------------------------------------------------

describe('Work', () => {
  const board: McBoard = {
    columns: [
      { phase: { id: 'inbox', title: 'Inbox' }, tickets: [ticket('T-0001', { title: 'An idea' })] },
      {
        phase: { id: 'build', title: 'Build' },
        tickets: [ticket('T-0002', { title: 'Build it', summary: 'The what and the why' })],
      },
      { phase: { id: 'done', title: 'Done' }, tickets: [] },
    ],
  };

  it('renders no groups without a bound state', () => {
    const work = setup(null);
    const vm = surface(work);
    expect(vm.groups()).toEqual([]);
    expect(vm.readOnly()).toBe(false);
  });

  it('derives the groups from the fake state, Braucht dich first', () => {
    const { state } = makeFake({ needs: [need('permission', 'Allow deploy?')], board });
    const vm = surface(setup(state));
    expect(vm.groups().map((g) => g.title)).toEqual(['Braucht dich', 'Inbox', 'Build', 'Done']);
  });

  it('reads the header sub tolerantly from the board payload', () => {
    const { state } = makeFake({ board });
    expect(surface(setup(state)).vaultTitle()).toBeNull();

    const named = makeFake({ board: { ...board, vaultName: 'lariscus' } });
    expect(surface(setup(named.state)).vaultTitle()).toBe('lariscus');

    const folder = makeFake({ board: { ...board, vaultName: '', activeVaultName: 'vault-dir' } });
    expect(surface(setup(folder.state)).vaultTitle()).toBe('vault-dir');
  });

  it('shows the Fleet chip live while runs are live, idle without run data', () => {
    const live = makeFake({ board, runs: [{ state: 'running' }, { state: 'starting' }] });
    const liveVm = surface(setup(live.state));
    expect(liveVm.liveRuns()).toBe(2);
    expect(liveVm.fleetLabel()).toBe('2 aktiv');
    expect(liveVm.fleetLive()).toBe(true);

    const quiet = makeFake({ board, runs: [{ state: 'done' }] });
    const quietVm = surface(setup(quiet.state));
    expect(quietVm.fleetLabel()).toBe('0 aktiv');
    expect(quietVm.fleetLive()).toBe(false);

    const blind = makeFake({ board });
    const blindVm = surface(setup(blind.state));
    expect(blindVm.liveRuns()).toBeNull();
    expect(blindVm.fleetLabel()).toBe('Fleet');
    expect(blindVm.fleetLive()).toBe(false);
  });

  it('the Fleet tap toasts the live count — only when runs are actually live', () => {
    const toasts: string[] = [];
    const { state } = makeFake({
      board,
      runs: [{ state: 'running' }, { state: 'running' }, { state: 'starting' }],
    });
    state.toast = (message: string) => toasts.push(message);
    const vm = surface(setup(state));
    vm.onFleetTap();
    expect(toasts).toEqual(['Runner: 3 Runs live']);

    const quiet = makeFake({ board, runs: [{ state: 'done' }] });
    quiet.state.toast = (message: string) => toasts.push(message);
    surface(setup(quiet.state)).onFleetTap();

    const blind = makeFake({ board });
    blind.state.toast = (message: string) => toasts.push(message);
    surface(setup(blind.state)).onFleetTap();

    expect(toasts).toEqual(['Runner: 3 Runs live']);
  });

  it('the Fleet tap is a no-op when the adapter offers no toast', () => {
    const { state } = makeFake({ board, runs: [{ state: 'running' }] });
    const vm = surface(setup(state));
    expect(() => vm.onFleetTap()).not.toThrow();
  });

  it('surfaces the readOnly flag', () => {
    const { state } = makeFake({ board, readOnly: true });
    expect(surface(setup(state)).readOnly()).toBe(true);
  });

  it('opens the sheet on card tap and closes it again', () => {
    const { state } = makeFake({ board });
    const vm = surface(setup(state));
    const buildGroup = vm.groups().find((g) => g.kind === 'phase' && g.phaseId === 'build')!;
    const card = firstCard(buildGroup);
    expect(card).not.toBeNull();

    vm.openSheet(card!);
    expect(vm.openCard()?.id).toBe('T-0002');
    expect(vm.moveTarget()?.phaseId).toBe('done');
    expect(vm.moveError()).toBeNull();

    vm.closeSheet();
    expect(vm.openCard()).toBeNull();
    expect(vm.moveTarget()).toBeNull();
  });

  it('offers no move from the last phase', () => {
    const { state } = makeFake({
      board: { columns: [{ phase: { id: 'done', title: 'Done' }, tickets: [ticket('T-0009')] }] },
    });
    const vm = surface(setup(state));
    const card = firstCard(vm.groups()[0]);
    vm.openSheet(card!);
    expect(vm.moveTarget()).toBeNull();
  });

  it('moves the card to the next phase and closes the sheet on success', async () => {
    const { state, calls } = makeFake({ board });
    const vm = surface(setup(state));
    const buildGroup = vm.groups().find((g) => g.kind === 'phase' && g.phaseId === 'build')!;
    vm.openSheet(buildGroup.kind === 'phase' ? buildGroup.tickets[0]! : (null as never));

    await vm.moveOn();
    expect(calls).toEqual([{ ticketId: 'T-0002', phaseId: 'done' }]);
    expect(vm.openCard()).toBeNull();
    expect(vm.movePending()).toBe(false);
  });

  it('shows the refusal inline and keeps the sheet open on failure', async () => {
    const { state, calls } = makeFake({
      board,
      moveResults: [{ ok: false, error: 'the gate is red' }],
    });
    const vm = surface(setup(state));
    const buildGroup = vm.groups().find((g) => g.kind === 'phase' && g.phaseId === 'build')!;
    vm.openSheet(buildGroup.kind === 'phase' ? buildGroup.tickets[0]! : (null as never));

    await vm.moveOn();
    expect(calls).toHaveLength(1);
    expect(vm.moveError()).toBe('the gate is red');
    expect(vm.openCard()?.id).toBe('T-0002');
  });

  it('falls back to a generic message when the refusal carries none', async () => {
    const { state } = makeFake({ board, moveResults: [{ ok: false }] });
    const vm = surface(setup(state));
    const buildGroup = vm.groups().find((g) => g.kind === 'phase' && g.phaseId === 'build')!;
    vm.openSheet(buildGroup.kind === 'phase' ? buildGroup.tickets[0]! : (null as never));

    await vm.moveOn();
    expect(vm.moveError()).toBe('The move failed.');
  });

  it('reports a generic error when the call itself rejects', async () => {
    const { state } = makeFake({ board });
    state.moveTicket = () => Promise.reject(new Error('offline'));
    const vm = surface(setup(state));
    const buildGroup = vm.groups().find((g) => g.kind === 'phase' && g.phaseId === 'build')!;
    vm.openSheet(buildGroup.kind === 'phase' ? buildGroup.tickets[0]! : (null as never));

    await vm.moveOn();
    expect(vm.moveError()).toBe('The move failed.');
    expect(vm.openCard()?.id).toBe('T-0002');
  });

  it('never moves on a read-only device', async () => {
    const { state, calls } = makeFake({ board, readOnly: true });
    const vm = surface(setup(state));
    const buildGroup = vm.groups().find((g) => g.kind === 'phase' && g.phaseId === 'build')!;
    vm.openSheet(buildGroup.kind === 'phase' ? buildGroup.tickets[0]! : (null as never));

    await vm.moveOn();
    expect(calls).toEqual([]);
    expect(vm.openCard()?.id).toBe('T-0002');
  });

  it('is a no-op with no card open', async () => {
    const { state, calls } = makeFake({ board });
    const vm = surface(setup(state));
    await vm.moveOn();
    expect(calls).toEqual([]);
  });
});

// --- the improvements need card (E6) -------------------------------------------------

describe('improvements needs', () => {
  const improvementsNeed = (vm: WorkSurface): NeedVm => {
    const group = vm.groups()[0];
    if (group?.kind !== 'needs') {
      throw new Error('expected the needs group');
    }
    return group.needs[0]!;
  };

  it('is tappable only when the adapter offers openPersona — and only for that kind', () => {
    const plain = makeFake({ needs: [need('improvements', 'Pia')] });
    const plainVm = surface(setup(plain.state));
    expect(plainVm.needTappable(improvementsNeed(plainVm))).toBe(false);

    const { state } = makeFake({
      needs: [need('improvements', 'Pia'), need('question', 'Ask away')],
    });
    state.openPersona = () => undefined;
    const vm = surface(setup(state));
    expect(vm.needTappable(improvementsNeed(vm))).toBe(true);
    const group = vm.groups()[0]!;
    const question =
      group.kind === 'needs'
        ? group.needs.find((n) => n.need.kind === 'question')!
        : (null as never);
    expect(vm.needTappable(question)).toBe(false);
  });

  it('tapping resolves the persona title against the directory at call time and opens the 1:1', () => {
    const opened: string[] = [];
    const { state } = makeFake({
      needs: [need('improvements', 'Pia')],
      personas: [{ id: 'pia', title: 'Pia', color: '#ff0000' }],
    });
    state.openPersona = (idOrTitle: string) => opened.push(idOrTitle);
    const vm = surface(setup(state));

    vm.openNeedPersona(improvementsNeed(vm));

    expect(opened).toEqual(['pia']);
  });

  it('an unknown persona falls back to the raw title — the adapter accepts either', () => {
    const opened: string[] = [];
    const { state } = makeFake({ needs: [need('improvements', 'Pia')] });
    state.openPersona = (idOrTitle: string) => opened.push(idOrTitle);
    const vm = surface(setup(state));

    vm.openNeedPersona(improvementsNeed(vm));

    expect(opened).toEqual(['Pia']);
  });

  it('tapping without the adapter (or another kind) is a no-op', () => {
    const { state } = makeFake({ needs: [need('improvements', 'Pia')] });
    const vm = surface(setup(state));
    expect(() => vm.openNeedPersona(improvementsNeed(vm))).not.toThrow();

    const { state: withOpen } = makeFake({ needs: [need('question', 'Ask away')] });
    withOpen.openPersona = () => undefined;
    const vm2 = surface(setup(withOpen));
    const group = vm2.groups()[0]!;
    const question = group.kind === 'needs' ? group.needs[0]! : (null as never);
    expect(() => vm2.openNeedPersona(question)).not.toThrow();
  });
});

// --- the scout report card (E8) -----------------------------------------------------

describe('report needs (E8)', () => {
  const REPORT: McScoutReport = {
    writtenAt: '2026-11-02T14:32:00Z',
    by: 'pia',
    summary: 'The repo carries two index implementations.',
    decisions: [
      {
        key: 'D1',
        question: 'Which storage should back the index?',
        recommendation: 'SQLite',
        resolved: false,
      },
      { key: 'D2', question: 'Migrate existing data?', recommendation: null, resolved: true },
    ],
  };

  interface ReportSurface {
    groups: Signal<WorkGroup[]>;
    readOnly: Signal<boolean>;
    reportOfNeed(vm: NeedVm): McScoutReport | null;
    canPromote(vm: NeedVm): boolean;
    promoteTicket(vm: NeedVm): void;
  }

  function reportNeedOf(vm: ReportSurface, kind: string): NeedVm {
    const group = vm.groups()[0];
    if (group?.kind !== 'needs') {
      throw new Error('expected the needs group');
    }
    return group.needs.find((n) => n.need.kind === kind) ?? group.needs[0]!;
  }

  function setupReport(patch: Partial<FakeState> = {}): { vm: ReportSurface; promoted: string[] } {
    const promoted: string[] = [];
    const { state } = makeFake({
      needs: [
        need('report', 'Which storage backs the index?', {
          ticketId: 'T-0004',
          summary: '1 of 2 decisions open',
          report: REPORT,
        }),
      ],
      ...patch,
    });
    state.promote = (ticketId: string) => promoted.push(ticketId);
    const work = setup(state);
    return { vm: work as unknown as ReportSurface, promoted };
  }

  it('surfaces the parsed report on the card; a headline-only need renders without one', () => {
    const { vm } = setupReport();
    expect(vm.reportOfNeed(reportNeedOf(vm, 'report'))).toEqual(REPORT);

    const { state } = makeFake({ needs: [need('report', 'Bare', { ticketId: 'T-0005' })] });
    const bare = setup(state) as unknown as ReportSurface;
    expect(bare.reportOfNeed(reportNeedOf(bare, 'report'))).toBeNull();
  });

  it('offers promote only on a report card with an adapter, an id and a writable device', () => {
    const { vm } = setupReport();
    expect(vm.canPromote(reportNeedOf(vm, 'report'))).toBe(true);

    const withoutAdapter = makeFake({
      needs: [need('report', 'R', { ticketId: 'T-1', report: REPORT })],
    });
    const noAdapter = setup(withoutAdapter.state) as unknown as ReportSurface;
    expect(noAdapter.canPromote(reportNeedOf(noAdapter, 'report'))).toBe(false);

    const wrongKind = setupReport({ needs: [need('question', 'Ask away', { ticketId: 'T-1' })] });
    expect(wrongKind.vm.canPromote(reportNeedOf(wrongKind.vm, 'question'))).toBe(false);

    const readOnly = setupReport({ readOnly: true });
    expect(readOnly.vm.canPromote(reportNeedOf(readOnly.vm, 'report'))).toBe(false);

    const noId = setupReport({ needs: [need('report', 'R', { report: REPORT })] });
    expect(noId.vm.canPromote(reportNeedOf(noId.vm, 'report'))).toBe(false);
  });

  it("promoting hands the ticket id to the adapter — the chat prefill is the shell's job", () => {
    const { vm, promoted } = setupReport();
    vm.promoteTicket(reportNeedOf(vm, 'report'));
    expect(promoted).toEqual(['T-0004']);

    const { state } = makeFake({ needs: [need('report', 'Bare')] });
    const bare = setup(state) as unknown as ReportSurface;
    bare.promoteTicket(reportNeedOf(bare, 'report'));
    expect(promoted).toEqual(['T-0004']);
  });
});
