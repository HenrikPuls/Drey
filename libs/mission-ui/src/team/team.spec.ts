import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  MC_TEAM_STATE,
  Team,
  dayCostFootOf,
  initialsOf,
  runStateClass,
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
  canOpen: Signal<boolean>;
  open(persona: McTeamPersona): void;
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
    expect(dayCostFootOf({ budget: 5, dailyCost: 0.42 })).toEqual({ text: '0,42 $ / 5 $ heute', over: false });
    expect(dayCostFootOf({ budget: 4.5, dailyCost: 1.4 })).toEqual({ text: '1,40 $ / 4,50 $ heute', over: false });
    // No budget: the day's costs alone.
    expect(dayCostFootOf({ budget: null, dailyCost: 0.19 })).toEqual({ text: '0,19 $ heute', over: false });
  });

  it('goes over the budget only against one that exists', () => {
    expect(dayCostFootOf({ budget: 5, dailyCost: 5.01 })).toEqual({ text: '5,01 $ / 5 $ heute', over: true });
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
});
