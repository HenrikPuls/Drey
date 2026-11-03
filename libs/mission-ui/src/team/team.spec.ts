import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  MC_TEAM_STATE,
  Team,
  chainStripOf,
  dailySumOf,
  dayCostFootOf,
  headerSubOf,
  initialsOf,
  isPersonaPaused,
  phasesFootOf,
  runStateClass,
  type ChainStripVm,
  type McTeamPersona,
  type McTeamState,
} from './team';

describe('initialsOf', () => {
  it('takes the first letter of each of the first two words', () => {
    expect(initialsOf('Claude Code')).toBe('CC');
  });

  it('upper-cases lowercase titles', () => {
    expect(initialsOf('docs steward')).toBe('DS');
  });

  it('keeps a single-word title to one initial', () => {
    expect(initialsOf('Scrutiny')).toBe('S');
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(initialsOf('  QA   review ')).toBe('QR');
  });

  it('ignores words past the second', () => {
    expect(initialsOf('Claude Code Reviewer')).toBe('CC');
  });

  it('returns an empty string for an empty title', () => {
    expect(initialsOf('')).toBe('');
    expect(initialsOf('   ')).toBe('');
  });
});

describe('runStateClass', () => {
  it('colours a running run with the accent', () => {
    expect(runStateClass('running')).toBe('run-live');
  });

  it('colours a starting run with the accent', () => {
    expect(runStateClass('starting')).toBe('run-live');
  });

  it('colours a failed run with danger', () => {
    expect(runStateClass('failed')).toBe('run-failed');
  });

  it('colours a finished or stopped run dim', () => {
    expect(runStateClass('done')).toBe('run-dim');
    expect(runStateClass('stopped')).toBe('run-dim');
  });

  it('colours a waiting or unwatchable run dim', () => {
    expect(runStateClass('stopping')).toBe('run-dim');
    expect(runStateClass('detached')).toBe('run-dim');
  });
});

// --- the component ----------------------------------------------------------------

interface TeamSurface {
  personas: Signal<readonly McTeamPersona[] | null>;
  headerSub: Signal<string | null>;
  chainStrip: Signal<{ label: string; mono: string | null; on: boolean; checked: boolean }>;
  pausedPersonas: Signal<readonly string[]>;
  canOpen: Signal<boolean>;
  canOpenTicket: Signal<boolean>;
  canPause: Signal<boolean>;
  open(persona: McTeamPersona): void;
  openRunTicket(persona: McTeamPersona): void;
  isPaused(persona: McTeamPersona): boolean;
  toggleMaster(): void;
  togglePause(persona: McTeamPersona): void;
}

function surface(team: Team): TeamSurface {
  return team as unknown as TeamSurface;
}

function setup(state: McTeamState | null): Team {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: state === null ? [] : [{ provide: MC_TEAM_STATE, useValue: state }],
  });
  return TestBed.runInInjectionContext(() => new Team());
}

const PIA: McTeamPersona = {
  id: 'pia',
  title: 'Pia',
  role: 'Planner',
  worker: 'opencode',
  model: 'zai/glm-5.3',
  pool: [],
  color: '#ff0000',
  currentRun: null,
  budget: null,
};

describe('dayCostFootOf', () => {
  it('reads the day’s costs against the budget, prototype-style', () => {
    expect(dayCostFootOf({ budget: 5, dailyCost: 0.42 })).toEqual({
      text: '0,42 $ / 5 $ today',
      over: false,
    });
    expect(dayCostFootOf({ budget: 4.5, dailyCost: 1.4 })).toEqual({
      text: '1,40 $ / 4,50 $ today',
      over: false,
    });
    // No budget: the day's costs alone.
    expect(dayCostFootOf({ budget: null, dailyCost: 0.19 })).toEqual({
      text: '0,19 $ today',
      over: false,
    });
  });

  it('goes over the budget only against one that exists', () => {
    expect(dayCostFootOf({ budget: 5, dailyCost: 5.01 })).toEqual({
      text: '5,01 $ / 5 $ today',
      over: true,
    });
    // At the budget exactly: not over yet.
    expect(dayCostFootOf({ budget: 5, dailyCost: 5 })?.over).toBe(false);
    expect(dayCostFootOf({ budget: null, dailyCost: 99 })?.over).toBe(false);
  });

  it('drops the slot when the desk carries no day costs — never a fake 0', () => {
    expect(dayCostFootOf({ budget: 5, dailyCost: undefined })).toBeNull();
    expect(dayCostFootOf({ budget: 5 })).toBeNull();
    // Junk on the figure hides the slot too.
    expect(dayCostFootOf({ budget: 5, dailyCost: Number.NaN })).toBeNull();
    expect(dayCostFootOf({ budget: null })).toBeNull();
  });
});

// --- the chain strip, the header sub and the foot phases (prototype convergence) ----

describe('chainStripOf', () => {
  it('shows the running face for master: run', () => {
    expect(chainStripOf('run')).toEqual({
      label: 'Chain running',
      mono: 'master: run',
      on: true,
      checked: true,
    });
  });

  it('shows the halted face for master: halted', () => {
    expect(chainStripOf('halted')).toEqual({
      label: 'Chain halted',
      mono: 'master: off',
      on: false,
      checked: false,
    });
  });

  it('shows the idle face while unknown — never a guessed position', () => {
    expect(chainStripOf(null)).toEqual({ label: 'Chain', mono: null, on: false, checked: false });
    expect(chainStripOf(undefined)).toEqual({
      label: 'Chain',
      mono: null,
      on: false,
      checked: false,
    });
  });

  it('documents the render slice', () => {
    const vm: ChainStripVm = chainStripOf('run');
    expect(vm.label).toContain('Chain');
  });
});

describe('isPersonaPaused', () => {
  it('the persona flag wins when the desk sent one', () => {
    expect(isPersonaPaused({ id: 'pia', paused: true }, [])).toBe(true);
    expect(isPersonaPaused({ id: 'pia', paused: false }, ['pia'])).toBe(false);
  });

  it('falls back to the fleet’s paused list when the flag is absent', () => {
    expect(isPersonaPaused({ id: 'pia' }, ['pia', 'ralf'])).toBe(true);
    expect(isPersonaPaused({ id: 'pia' }, ['ralf'])).toBe(false);
  });

  it('reads a missing list as none', () => {
    expect(isPersonaPaused({ id: 'pia' }, null)).toBe(false);
    expect(isPersonaPaused({ id: 'pia' }, undefined)).toBe(false);
    expect(isPersonaPaused({ id: 'pia' }, [])).toBe(false);
  });
});

describe('phasesFootOf', () => {
  it('joins the phases prototype-style', () => {
    expect(phasesFootOf({ phases: ['plan', 'shape', 'build'] })).toBe('plan · shape · build');
  });

  it('reads absent, empty or junk-cleared phases as no slot', () => {
    expect(phasesFootOf({})).toBeNull();
    expect(phasesFootOf({ phases: [] })).toBeNull();
    expect(phasesFootOf({ phases: ['', '  '] })).toBeNull();
  });
});

describe('dailySumOf and headerSubOf', () => {
  it('sums only the known day costs', () => {
    expect(dailySumOf([{ dailyCost: 0.42 }, { dailyCost: 1.19 }])).toBeCloseTo(1.61);
    expect(dailySumOf([{ dailyCost: 0.42 }, {}])).toBeCloseTo(0.42);
  });

  it('sums to null when no persona settled a known cost — never a fake 0', () => {
    expect(dailySumOf([{}, {}])).toBeNull();
    expect(dailySumOf([])).toBeNull();
    expect(dailySumOf([{ dailyCost: Number.NaN }])).toBeNull();
  });

  it('the header sub counts the personas and adds the day sum when known', () => {
    expect(headerSubOf([PIA, PIA, PIA, PIA])).toBe('4 personas');
    expect(headerSubOf([{ ...PIA, dailyCost: 2.41 }])).toBe('1 persona · today 2,41 $');
    expect(
      headerSubOf([
        { ...PIA, dailyCost: 0.42 },
        { ...PIA, dailyCost: 1.99 },
      ]),
    ).toBe('2 personas · today 2,41 $');
  });

  it('the header sub hides while the list is still loading', () => {
    expect(headerSubOf(null)).toBeNull();
  });
});

describe('Team', () => {
  it('the factory default binds an empty, read-only state', () => {
    const vm = surface(setup(null));
    expect(vm.personas()).toBeNull();
    expect(vm.canOpen()).toBe(false);
    expect(() => vm.open(PIA)).not.toThrow();
  });

  it('cards are not tappable when the state offers no openPersona', () => {
    const vm = surface(setup({ team: signal([PIA]) }));
    expect(vm.canOpen()).toBe(false);
    expect(vm.personas()?.map((p) => p.id)).toEqual(['pia']);
  });

  it('a card tap opens the persona’s 1:1 with the persona id', () => {
    const opened: string[] = [];
    const vm = surface(setup({ team: signal([PIA]), openPersona: (id) => opened.push(id) }));
    expect(vm.canOpen()).toBe(true);

    vm.open(PIA);

    expect(opened).toEqual(['pia']);
  });

  it('the header sub counts and sums; the strip shows the idle face without a chain signal', () => {
    const vm = surface(setup({ team: signal([{ ...PIA, dailyCost: 2.41 }]) }));
    expect(vm.headerSub()).toBe('1 persona · today 2,41 $');
    expect(vm.chainStrip()).toEqual({ label: 'Chain', mono: null, on: false, checked: false });
    expect(vm.pausedPersonas()).toEqual([]);
  });

  it('the strip mirrors the fleet snapshot’s chain master', () => {
    const vm = surface(
      setup({
        team: signal([PIA]),
        chainMaster: signal<'run' | 'halted' | null>('run'),
        pausedPersonas: signal<readonly string[]>([]),
      }),
    );
    expect(vm.chainStrip()).toEqual({
      label: 'Chain running',
      mono: 'master: run',
      on: true,
      checked: true,
    });
  });

  it('the master toggle flips toward the opposite of the current face', () => {
    const toggles: boolean[] = [];
    const running = surface(
      setup({
        team: signal([PIA]),
        chainMaster: signal<'run' | 'halted' | null>('run'),
        toggleChainMaster: (paused) => {
          toggles.push(paused);
        },
      }),
    );
    running.toggleMaster();
    expect(toggles).toEqual([true]);

    const halted = surface(
      setup({
        team: signal([PIA]),
        chainMaster: signal<'run' | 'halted' | null>('halted'),
        toggleChainMaster: (paused) => {
          toggles.push(paused);
        },
      }),
    );
    halted.toggleMaster();
    // Unknown reads as the idle face — the toggle resumes.
    const unknown = surface(
      setup({
        team: signal([PIA]),
        toggleChainMaster: (paused) => {
          toggles.push(paused);
        },
      }),
    );
    unknown.toggleMaster();
    expect(toggles).toEqual([true, false, false]);
  });

  it('the master toggle stays silent without a bound action', () => {
    const vm = surface(setup({ team: signal([PIA]) }));
    expect(() => vm.toggleMaster()).not.toThrow();
  });

  it('the run ghost hands the live run’s ticket to the shell', () => {
    const opened: string[] = [];
    const running: McTeamPersona = { ...PIA, currentRun: { ticketId: 'T-0091', state: 'running' } };
    const vm = surface(setup({ team: signal([running]), openTicket: (id) => opened.push(id) }));
    expect(vm.canOpenTicket()).toBe(true);
    vm.openRunTicket(running);
    expect(opened).toEqual(['T-0091']);
    vm.openRunTicket({ ...PIA, currentRun: null });
    expect(opened).toEqual(['T-0091']);
  });

  it('pause and resume route through the bound state with the flipped target', () => {
    const calls: { id: string; paused: boolean }[] = [];
    const vm = surface(
      setup({
        team: signal([PIA]),
        pausedPersonas: signal<readonly string[]>(['pia']),
        personaPause: (id, paused) => {
          calls.push({ id, paused });
        },
      }),
    );
    expect(vm.isPaused(PIA)).toBe(true);
    expect(vm.canPause()).toBe(true);

    vm.togglePause(PIA);
    vm.togglePause({ ...PIA, paused: false });

    expect(calls).toEqual([
      { id: 'pia', paused: false },
      { id: 'pia', paused: true },
    ]);
  });

  it('the pause ghost stays silent without a bound action', () => {
    const vm = surface(setup({ team: signal([PIA]) }));
    expect(vm.canPause()).toBe(false);
    expect(() => vm.togglePause(PIA)).not.toThrow();
  });
});
