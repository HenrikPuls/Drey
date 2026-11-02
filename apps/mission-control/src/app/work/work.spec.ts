/**
 * The work tab's specs: the pure group/next-phase logic, then the
 * component class against a fake state object — no DOM (the unit-test
 * builder runs these under jsdom, but nothing here renders a template).
 */
import type { Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Work } from './work';
import {
  MC_WORK_STATE,
  NEED_KIND_LABELS,
  displayTitleOf,
  groupsOf,
  isBlockedTicket,
  isFlaggedTicket,
  needKindLabelOf,
  nextPhaseOf,
  personaMapOf,
  type McBoard,
  type McNeed,
  type McPersona,
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
  openCard: Signal<TicketVm | null>;
  moveError: Signal<string | null>;
  movePending: Signal<boolean>;
  moveTarget: Signal<{ phaseId: string; title: string } | null>;
  openSheet(card: TicketVm): void;
  closeSheet(): void;
  moveOn(): Promise<void>;
  needTappable(vm: NeedVm): boolean;
  openNeedPersona(vm: NeedVm): void;
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
    expect(groups.map((g) => g.title)).toEqual(['Needs you', 'Inbox', 'Build', 'lost']);
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
      return group?.kind === 'needs' ? group.needs.find((n) => n.need.title === title)?.key : undefined;
    };
    const first = groupsOf([need('improvements', 'Pia', { ticketId: '' }), need('question', 'Ask')], null, []);
    const refreshed = groupsOf([need('question', 'New one'), need('improvements', 'Pia', { ticketId: '' })], null, []);
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
    expect(first.flagged).toBe(false);
    expect(first.blocked).toBe(false);
    expect(first.phaseColor).toBe('#123456');
    expect(second.title).toBe('T-0002');
    expect(second.flagged).toBe(true);
    expect(second.blocked).toBe(true);
    expect(second.persona?.color).toBe('#ff8800');
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
    expect(NEED_KIND_LABELS['checkpoint']).toBe('Checkpoint');
    expect(NEED_KIND_LABELS['improvements']).toBe('Improvements');
    expect(needKindLabelOf('question')).toBe('Asks you');
    expect(needKindLabelOf('improvements')).toBe('Improvements');
    expect(needKindLabelOf('mystery')).toBe('mystery');
  });

  it('falls back to the id when the title is absent or blank', () => {
    expect(displayTitleOf(ticket('T-0001'))).toBe('T-0001');
    expect(displayTitleOf(ticket('T-0001', { title: '  ' }))).toBe('T-0001');
    expect(displayTitleOf(ticket('T-0001', { title: 'Ship it' }))).toBe('Ship it');
  });

  it('flags only urgent and high priorities', () => {
    expect(isFlaggedTicket(ticket('a', { meta: { priority: 'urgent' } }))).toBe(true);
    expect(isFlaggedTicket(ticket('b', { meta: { priority: 'high' } }))).toBe(true);
    expect(isFlaggedTicket(ticket('c', { meta: { priority: 'normal' } }))).toBe(false);
    expect(isFlaggedTicket(ticket('d'))).toBe(false);
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

  it('derives the groups from the fake state, needs first', () => {
    const { state } = makeFake({ needs: [need('permission', 'Allow deploy?')], board });
    const vm = surface(setup(state));
    expect(vm.groups().map((g) => g.title)).toEqual(['Needs you', 'Inbox', 'Build', 'Done']);
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
    const { state, calls } = makeFake({ board, moveResults: [{ ok: false, error: 'the gate is red' }] });
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

    const { state } = makeFake({ needs: [need('improvements', 'Pia'), need('question', 'Ask away')] });
    state.openPersona = () => undefined;
    const vm = surface(setup(state));
    expect(vm.needTappable(improvementsNeed(vm))).toBe(true);
    const group = vm.groups()[0]!;
    const question = group.kind === 'needs' ? group.needs.find((n) => n.need.kind === 'question')! : (null as never);
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
