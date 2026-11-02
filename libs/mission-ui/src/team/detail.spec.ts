/**
 * The persona detail's specs (E6 — the 1:1, concept §4.8): the pure
 * split/preview logic, then the component class against a fake vm — no
 * DOM (the unit-test builder runs these under jsdom, but nothing here
 * renders a template).
 */
import type { Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImprovementProposalView, PersonaImprovementsView } from '../api/dto';
import { ACCEPT_ARM_WINDOW_MS, type AcceptArmState } from '../ticket/ticket.model';
import {
  CONTENT_PREVIEW_LINES,
  EVIDENCE_PREVIEW_CAP,
  MC_TEAM_DETAIL,
  PersonaDetail,
  contentPreviewOf,
  evidencePreviewOf,
  proposalsSplitOf,
  type PersonaFacts,
  type ProposalSplit,
  type TeamDetailVm,
} from './detail';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- fakes -------------------------------------------------------------------------

function proposal(id: string, extra: Partial<ImprovementProposalView> = {}): ImprovementProposalView {
  return {
    id,
    state: 'open',
    target: 'prompt.md',
    title: `Proposal ${id}`,
    evidence: [],
    content: 'the replacement text',
    lesson: null,
    at: '',
    decidedAt: null,
    ...extra,
  };
}

function view(extra: Partial<PersonaImprovementsView> = {}): PersonaImprovementsView {
  return { persona: null, proposals: [], openCount: 0, frictionCount: 0, ...extra };
}

const PIA_FACTS: PersonaFacts = { id: 'pia', title: 'Pia', role: 'Planner', color: '#ff0000' };

type ActionReply = { ok: boolean; error?: string };

interface FakeVm extends TeamDetailVm {
  openState: { id: string } | null;
  facts: PersonaFacts | null;
  view: PersonaImprovementsView | null;
  error: string | null;
  readonly: boolean;
  applied: ImprovementProposalView[];
  dismissed: ImprovementProposalView[];
  applyReplies: ActionReply[];
  dismissReplies: ActionReply[];
  reloads: number;
  closes: number;
}

function makeVm(patch: Partial<FakeVm> = {}): FakeVm {
  return {
    openState: { id: 'pia' },
    facts: PIA_FACTS,
    view: view(),
    error: null,
    readonly: false,
    applied: [],
    dismissed: [],
    applyReplies: [{ ok: true }],
    dismissReplies: [{ ok: true }],
    reloads: 0,
    closes: 0,
    open() {
      return this.openState;
    },
    persona() {
      return this.facts;
    },
    improvements() {
      return this.view;
    },
    loadError() {
      return this.error;
    },
    readOnly() {
      return this.readonly;
    },
    async reload() {
      this.reloads += 1;
    },
    close() {
      this.closes += 1;
    },
    async apply(p) {
      this.applied.push(p);
      return this.applyReplies.shift() ?? { ok: true };
    },
    async dismiss(p) {
      this.dismissed.push(p);
      return this.dismissReplies.shift() ?? { ok: true };
    },
    ...patch,
  };
}

interface DetailSurface {
  isOpen: Signal<boolean>;
  persona: Signal<PersonaFacts | null>;
  title: Signal<string>;
  role: Signal<string>;
  color: Signal<string>;
  improvements: Signal<PersonaImprovementsView | null>;
  loadError: Signal<string | null>;
  readOnly: Signal<boolean>;
  loading: Signal<boolean>;
  empty: Signal<boolean>;
  frictionLine: Signal<string | null>;
  split: Signal<ProposalSplit>;
  expanded: Signal<readonly string[]>;
  arm: Signal<AcceptArmState>;
  armTarget: Signal<string | null>;
  busyId: Signal<string | null>;
  actionError: Signal<{ id: string; text: string } | null>;
  isExpanded(id: string): boolean;
  toggleExpanded(id: string): void;
  busy(proposal: ImprovementProposalView): boolean;
  errorFor(proposal: ImprovementProposalView): string | null;
  applyTap(proposal: ImprovementProposalView): void;
  dismiss(proposal: ImprovementProposalView): Promise<void>;
  reload(): void;
  close(): void;
}

function surface(detail: PersonaDetail): DetailSurface {
  return detail as unknown as DetailSurface;
}

function setup(vm: TeamDetailVm | null): PersonaDetail {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: vm === null ? [] : [{ provide: MC_TEAM_DETAIL, useValue: vm }],
  });
  return TestBed.runInInjectionContext(() => new PersonaDetail());
}

// --- the pure logic ------------------------------------------------------------------

describe('proposalsSplitOf', () => {
  it('buckets open vs decided, keeping the file order inside each bucket', () => {
    const openA = proposal('imp-1');
    const accepted = proposal('imp-2', { state: 'accepted', decidedAt: 't5' });
    const openB = proposal('imp-3');
    const dismissed = proposal('imp-4', { state: 'dismissed', decidedAt: 't6' });
    expect(proposalsSplitOf(view({ proposals: [openA, accepted, openB, dismissed] }))).toEqual({
      open: [openA, openB],
      history: [accepted, dismissed],
    });
  });

  it('reads a null view as both-empty (the loading state)', () => {
    expect(proposalsSplitOf(null)).toEqual({ open: [], history: [] });
  });
});

describe('evidencePreviewOf', () => {
  it('caps at three lines and counts the rest honestly', () => {
    expect(evidencePreviewOf(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
    expect(evidencePreviewOf(['a'])).toEqual({ shown: ['a'], more: 0 });
    expect(evidencePreviewOf([])).toEqual({ shown: [], more: 0 });
  });

  it('documents the cap', () => {
    expect(EVIDENCE_PREVIEW_CAP).toBe(3);
  });
});

describe('contentPreviewOf', () => {
  it('takes the first lines and drops trailing blank ones', () => {
    const content = ['one', 'two', 'three', 'four', 'five', ''].join('\n');
    expect(contentPreviewOf(content)).toBe(['one', 'two', 'three', 'four'].join('\n'));
  });

  it('keeps short content whole', () => {
    expect(contentPreviewOf('short')).toBe('short');
    expect(contentPreviewOf('')).toBe('');
  });

  it('previews exactly CONTENT_PREVIEW_LINES lines', () => {
    const content = Array.from({ length: CONTENT_PREVIEW_LINES + 2 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(contentPreviewOf(content).split('\n')).toHaveLength(CONTENT_PREVIEW_LINES);
  });
});

// --- the screen states -----------------------------------------------------------------

describe('PersonaDetail', () => {
  it('the factory default renders closed', () => {
    const vm = surface(setup(null));
    expect(vm.isOpen()).toBe(false);
    expect(vm.title()).toBe('');
  });

  it('a closed vm renders nothing', () => {
    const vm = surface(setup(makeVm({ openState: null })));
    expect(vm.isOpen()).toBe(false);
  });

  it('open with no view and no error is the loading state', () => {
    const vm = surface(setup(makeVm({ view: null })));
    expect(vm.isOpen()).toBe(true);
    expect(vm.loading()).toBe(true);
    expect(vm.empty()).toBe(false);
  });

  it('a load failure surfaces with the desk wording and retries', () => {
    const fake = makeVm({ view: null, error: 'the desk did not answer' });
    const vm = surface(setup(fake));
    expect(vm.loadError()).toBe('the desk did not answer');
    expect(vm.loading()).toBe(false);
    vm.reload();
    expect(fake.reloads).toBe(1);
  });

  it('an empty file is the empty state', () => {
    const vm = surface(setup(makeVm({ view: view() })));
    expect(vm.empty()).toBe(true);
    expect(vm.split()).toEqual({ open: [], history: [] });
  });

  it('a populated view splits into open cards and dim history', () => {
    const open = proposal('imp-1');
    const done = proposal('imp-2', { state: 'accepted', decidedAt: 't5' });
    const vm = surface(setup(makeVm({ view: view({ proposals: [open, done], openCount: 1, frictionCount: 2 }) })));
    expect(vm.loading()).toBe(false);
    expect(vm.empty()).toBe(false);
    expect(vm.split().open.map((p) => p.id)).toEqual(['imp-1']);
    expect(vm.split().history.map((p) => p.id)).toEqual(['imp-2']);
  });

  it('the header takes the persona facts and falls back to the open id', () => {
    const withFacts = surface(setup(makeVm()));
    expect(withFacts.title()).toBe('Pia');
    expect(withFacts.role()).toBe('Planner');
    expect(withFacts.color()).toBe('#ff0000');

    const without = surface(setup(makeVm({ facts: null, openState: { id: 'ghost' } })));
    expect(without.title()).toBe('ghost');
    expect(without.role()).toBe('');
    expect(without.color()).toBe('#7aa2f7');
  });

  it('the friction line counts findings, singular and plural, and hides at zero', () => {
    expect(surface(setup(makeVm({ view: view({ frictionCount: 3 }) }))).frictionLine()).toBe(
      '3 unaggregated friction findings',
    );
    expect(surface(setup(makeVm({ view: view({ frictionCount: 1 }) }))).frictionLine()).toBe(
      '1 unaggregated friction finding',
    );
    expect(surface(setup(makeVm({ view: view({ frictionCount: 0 }) }))).frictionLine()).toBeNull();
    expect(surface(setup(makeVm({ view: null }))).frictionLine()).toBeNull();
  });

  it('close hands back to the shell', () => {
    const fake = makeVm();
    surface(setup(fake)).close();
    expect(fake.closes).toBe(1);
  });

  it('the content preview toggles per proposal', () => {
    const vm = surface(setup(makeVm()));
    expect(vm.isExpanded('imp-1')).toBe(false);
    vm.toggleExpanded('imp-1');
    expect(vm.isExpanded('imp-1')).toBe(true);
    expect(vm.isExpanded('imp-2')).toBe(false);
    vm.toggleExpanded('imp-1');
    expect(vm.isExpanded('imp-1')).toBe(false);
  });
});

// --- the armed two-step Apply -------------------------------------------------------------

describe('the armed two-step Apply', () => {
  it('the first tap arms, the second inside the window executes', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    const p = proposal('imp-1');

    vm.applyTap(p);
    expect(vm.arm().armed).toBe(true);
    expect(vm.armTarget()).toBe('imp-1');
    expect(fake.applied).toEqual([]);

    vm.applyTap(p);
    expect(vm.arm().armed).toBe(false);
    expect(vm.armTarget()).toBeNull();
    // The vm call ran synchronously up to its reply; the busy state clears on flush.
    expect(fake.applied).toEqual([p]);
    expect(vm.busyId()).toBe(p.id);
    await flush();
    expect(vm.busyId()).toBeNull();
    expect(vm.errorFor(p)).toBeNull();
  });

  it('a tap on another card abandons the arm — nothing applies by accident', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    const a = proposal('imp-1');
    const b = proposal('imp-2');

    vm.applyTap(a);
    vm.applyTap(b);

    expect(fake.applied).toEqual([]);
    expect(vm.armTarget()).toBe('imp-2');

    vm.applyTap(b);
    expect(fake.applied).toEqual([b]);
    await flush();
  });

  it('an abandoned arm expires after the window', () => {
    vi.useFakeTimers();
    try {
      const vm = surface(setup(makeVm()));
      vm.applyTap(proposal('imp-1'));
      expect(vm.arm().armed).toBe(true);
      vi.advanceTimersByTime(ACCEPT_ARM_WINDOW_MS);
      expect(vm.arm().armed).toBe(false);
      expect(vm.armTarget()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the busy state marks exactly the deciding card', async () => {
    let release!: (reply: ActionReply) => void;
    const fake = makeVm();
    fake.apply = () =>
      new Promise<ActionReply>((resolve) => {
        release = resolve;
      });
    const vm = surface(setup(fake));
    const p = proposal('imp-1');

    vm.applyTap(p);
    vm.applyTap(p);

    expect(vm.busy(p)).toBe(true);
    expect(vm.busy(proposal('imp-2'))).toBe(false);

    release({ ok: true });
    await flush();
    expect(vm.busy(p)).toBe(false);
  });

  it('a refusal lands inline on the proposal', async () => {
    const fake = makeVm({ applyReplies: [{ ok: false, error: 'the proposal is already decided' }] });
    const vm = surface(setup(fake));
    const p = proposal('imp-1');

    vm.applyTap(p);
    vm.applyTap(p);
    await flush();

    expect(vm.errorFor(p)).toBe('the proposal is already decided');
    expect(vm.busy(p)).toBe(false);
    expect(vm.errorFor(proposal('imp-2'))).toBeNull();
  });

  it('a rejecting apply reports the generic failure', async () => {
    const fake = makeVm();
    fake.apply = () => Promise.reject(new Error('offline'));
    const vm = surface(setup(fake));
    const p = proposal('imp-1');

    vm.applyTap(p);
    vm.applyTap(p);
    await flush();

    expect(vm.errorFor(p)).toBe('The apply failed.');
    expect(vm.busy(p)).toBe(false);
  });

  it('no decision starts while one is in flight', async () => {
    let release!: (reply: ActionReply) => void;
    const fake = makeVm();
    fake.apply = () =>
      new Promise<ActionReply>((resolve) => {
        release = resolve;
      });
    const vm = surface(setup(fake));
    const p = proposal('imp-1');

    vm.applyTap(p);
    vm.applyTap(p);
    await vm.dismiss(p);

    expect(fake.dismissed).toEqual([]);
    release({ ok: true });
    await flush();
    expect(fake.dismissed).toEqual([]);
  });

  it('read-only devices never apply', () => {
    const fake = makeVm({ readonly: true });
    const vm = surface(setup(fake));
    vm.applyTap(proposal('imp-1'));
    expect(vm.arm().armed).toBe(false);
    expect(fake.applied).toEqual([]);
  });
});

// --- Dismiss ---------------------------------------------------------------------------------

describe('Dismiss', () => {
  it('dismisses through the vm and leaves no error or busy state', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    const p = proposal('imp-1');

    await vm.dismiss(p);

    expect(fake.dismissed).toEqual([p]);
    expect(vm.busy(p)).toBe(false);
    expect(vm.errorFor(p)).toBeNull();
  });

  it('a refusal lands inline with the desk wording', async () => {
    const fake = makeVm({ dismissReplies: [{ ok: false, error: 'the desk refused' }] });
    const vm = surface(setup(fake));
    const p = proposal('imp-1');

    await vm.dismiss(p);

    expect(vm.errorFor(p)).toBe('the desk refused');
    expect(vm.busy(p)).toBe(false);
  });

  it('read-only devices never dismiss', async () => {
    const fake = makeVm({ readonly: true });
    const vm = surface(setup(fake));
    await vm.dismiss(proposal('imp-1'));
    expect(fake.dismissed).toEqual([]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
