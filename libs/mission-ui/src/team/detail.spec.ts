/**
 * The persona detail's specs (E6 — the 1:1, concept §4.8): the pure
 * split/preview logic, then the component class against a fake vm — no
 * DOM (the unit-test builder runs these under jsdom, but nothing here
 * renders a template).
 */
import { signal, type Signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ImprovementProposalView,
  PersonaImprovementsView,
  PersonaMemoryView,
  PersonaPatch,
  PersonaThreadView,
} from '../api/dto';
import { ACCEPT_ARM_WINDOW_MS, type AcceptArmState } from '../ticket/ticket.model';
import {
  CARD_SNIPPET_CAP,
  CONTENT_PREVIEW_LINES,
  EVIDENCE_PREVIEW_CAP,
  MC_TEAM_DETAIL,
  PersonaDetail,
  ROUTER_CYCLE,
  WORKER_OPTIONS,
  chatIntentOf,
  contentPreviewOf,
  evidencePreviewOf,
  nextRouterOf,
  poolWordsOf,
  proposalsSplitOf,
  skillsToggled,
  snippetOf,
  timeWordsOf,
  type CoachingCardVm,
  type PersonaFacts,
  type ProposalSplit,
  type TeamDetailVm,
} from './detail';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- fakes -------------------------------------------------------------------------

function proposal(
  id: string,
  extra: Partial<ImprovementProposalView> = {},
): ImprovementProposalView {
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

const PIA_FACTS: PersonaFacts = {
  id: 'pia',
  title: 'Pia',
  role: 'Planner',
  color: '#ff0000',
  worker: 'claude-code',
  model: 'zai/glm-5.3',
  pool: ['zai/glm-5.3', 'sonnet'],
};

type ActionReply = { ok: boolean; error?: string };

interface FakeVm extends TeamDetailVm {
  openState: { id: string } | null;
  facts: PersonaFacts | null;
  view: PersonaImprovementsView | null;
  error: string | null;
  readonly: boolean;
  threadValue: PersonaThreadView | null;
  threadErrorValue: string | null;
  memoryValue: PersonaMemoryView | null;
  memoryErrorValue: string | null;
  applied: ImprovementProposalView[];
  dismissed: ImprovementProposalView[];
  applyReplies: ActionReply[];
  dismissReplies: ActionReply[];
  reloads: number;
  closes: number;
  sent: string[];
  sendReplies: ActionReply[];
  threadErrorSet: string | null;
  addedMemory: string[];
  addReplies: ActionReply[];
  pins: { index: number; pinned: boolean }[];
  pinReplies: ActionReply[];
  patched: PersonaPatch[];
  patchReplies: ActionReply[];
  prefilled: string[];
  toasts: { message: string; kind?: 'ok' | 'warn' | 'error' }[];
}

function makeVm(patch: Partial<FakeVm> = {}): FakeVm {
  return {
    openState: { id: 'pia' },
    facts: PIA_FACTS,
    view: view(),
    error: null,
    readonly: false,
    threadValue: { messages: [] },
    threadErrorValue: null,
    memoryValue: { entries: [] },
    memoryErrorValue: null,
    applied: [],
    dismissed: [],
    applyReplies: [{ ok: true }],
    dismissReplies: [{ ok: true }],
    reloads: 0,
    closes: 0,
    sent: [],
    sendReplies: [{ ok: true }],
    threadErrorSet: null,
    addedMemory: [],
    addReplies: [{ ok: true }],
    pins: [],
    pinReplies: [{ ok: true }],
    patched: [],
    patchReplies: [{ ok: true }],
    prefilled: [],
    toasts: [],
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
    thread() {
      return this.threadValue;
    },
    threadError() {
      return this.threadErrorValue;
    },
    async sendThread(text) {
      this.sent.push(text);
      return this.sendReplies.shift() ?? { ok: true };
    },
    memory() {
      return this.memoryValue;
    },
    memoryError() {
      return this.memoryErrorValue;
    },
    async addMemory(text) {
      this.addedMemory.push(text);
      return this.addReplies.shift() ?? { ok: true };
    },
    async pinMemory(index, pinned) {
      this.pins.push({ index, pinned });
      return this.pinReplies.shift() ?? { ok: true };
    },
    async patchPersona(p) {
      this.patched.push(p);
      return this.patchReplies.shift() ?? { ok: true };
    },
    prefillChat(text) {
      this.prefilled.push(text);
    },
    toast(message, kind) {
      this.toasts.push({ message, kind });
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
  openId: Signal<string>;
  readOnly: Signal<boolean>;
  tab: WritableSignal<string>;
  setTab(tab: string): void;
  improveCount: Signal<number>;
  memCount: Signal<number>;
  thread: Signal<PersonaThreadView | null>;
  threadError: Signal<string | null>;
  draft: WritableSignal<string>;
  sending: Signal<boolean>;
  sendError: Signal<string | null>;
  cards: Signal<readonly CoachingCardVm[]>;
  onDraftInput(event: Event): void;
  send(): Promise<void>;
  snippet(card: CoachingCardVm): string;
  applyCard(card: CoachingCardVm): Promise<void>;
  dismissCard(card: CoachingCardVm): void;
  errorForCard(card: CoachingCardVm): string | null;
  improvements: Signal<PersonaImprovementsView | null>;
  loadError: Signal<string | null>;
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
  evidenceWords(proposal: ImprovementProposalView): string;
  reload(): void;
  close(): void;
  memory: Signal<PersonaMemoryView | null>;
  memoryError: Signal<string | null>;
  memDraft: WritableSignal<string>;
  memError: Signal<string | null>;
  pinBusy: Signal<number | null>;
  pinError: Signal<string | null>;
  onMemDraftInput(event: Event): void;
  addMemory(): Promise<void>;
  togglePin(index: number, pinned: boolean): Promise<void>;
  routerLocal: WritableSignal<string | null>;
  routerValue: Signal<string>;
  skillsLocal: WritableSignal<readonly string[] | null>;
  skillsValue: Signal<readonly string[]>;
  promptDraft: WritableSignal<string>;
  promptError: Signal<string | null>;
  setupBusy: Signal<string | null>;
  setupError: Signal<string | null>;
  sheet: WritableSignal<'model' | 'worker' | null>;
  modelOptions: Signal<readonly string[]>;
  poolWords: Signal<string>;
  workerOptions: Signal<readonly string[]>;
  skillOn(name: string): boolean;
  onPromptInput(event: Event): void;
  openSheet(which: 'model' | 'worker'): void;
  closeSheet(): void;
  pick(kind: 'model' | 'worker', value: string): Promise<void>;
  cycleRouter(): Promise<void>;
  toggleSkill(name: string): Promise<void>;
  savePrompt(): Promise<void>;
  poolTap(): void;
}

function surface(detail: PersonaDetail): DetailSurface {
  return detail as unknown as DetailSurface;
}

function setup(vm: TeamDetailVm | null): PersonaDetail {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: vm === null ? [] : [{ provide: MC_TEAM_DETAIL, useValue: vm }],
  });
  const detail = TestBed.runInInjectionContext(() => new PersonaDetail());
  // The open-reset effect schedules on the microtask queue — flush it so
  // the fresh-1:1 state is in place before the test acts.
  TestBed.flushEffects();
  return detail;
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
    expect(evidencePreviewOf(['a', 'b', 'c', 'd', 'e'])).toEqual({
      shown: ['a', 'b', 'c'],
      more: 2,
    });
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
    const content = Array.from(
      { length: CONTENT_PREVIEW_LINES + 2 },
      (_, i) => `line ${i + 1}`,
    ).join('\n');
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
    const vm = surface(
      setup(makeVm({ view: view({ proposals: [open, done], openCount: 1, frictionCount: 2 }) })),
    );
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
    const fake = makeVm({
      applyReplies: [{ ok: false, error: 'the proposal is already decided' }],
    });
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

// --- the chat's client-side intents (pure logic) -------------------------------------

describe('chatIntentOf', () => {
  it('reads a "New ticket:" line as the create intent', () => {
    expect(chatIntentOf('New ticket: Column editor')).toBe('ticket');
    expect(chatIntentOf('please new   ticket: something')).toBe('ticket');
  });

  it('reads prompt coaching from prompt, rule or instruction', () => {
    expect(chatIntentOf('Remember this rule for the prompt')).toBe('prompt');
    expect(chatIntentOf('new instruction: measure first')).toBe('prompt');
  });

  it('reads memory coaching from remember or memory', () => {
    expect(chatIntentOf('remember: rank fields win')).toBe('memory');
    expect(chatIntentOf('memory: read history first')).toBe('memory');
    expect(chatIntentOf('put it in memory')).toBe('memory');
    expect(chatIntentOf('that goes into memory')).toBe('memory');
  });

  it('everything else is a plain message', () => {
    expect(chatIntentOf('Why did you want to take the ranks over?')).toBe('plain');
    expect(chatIntentOf('')).toBe('plain');
  });

  it('the ticket intent wins over prompt and memory', () => {
    expect(chatIntentOf('New ticket: with a rule in the prompt')).toBe('ticket');
  });
});

describe('snippetOf and timeWordsOf', () => {
  it('clips long wording at 90 characters with an ellipsis', () => {
    const long = 'a'.repeat(120);
    expect(snippetOf(long)).toBe(`${'a'.repeat(CARD_SNIPPET_CAP)}…`);
    expect(snippetOf('short')).toBe('short');
    expect(CARD_SNIPPET_CAP).toBe(90);
  });

  it('formats a readable ` · HH:MM` stamp and reads junk as none', () => {
    expect(timeWordsOf('2026-11-01T13:58:00')).toBe(' · 13:58');
    expect(timeWordsOf('')).toBe('');
    expect(timeWordsOf('not a date')).toBe('');
  });
});

describe('the setup tab’s pure moves', () => {
  it('the router cycle walks off → budget → escalate-on-fail → off', () => {
    expect(ROUTER_CYCLE).toEqual(['off', 'budget', 'escalate-on-fail']);
    expect(nextRouterOf('off')).toBe('budget');
    expect(nextRouterOf('budget')).toBe('escalate-on-fail');
    expect(nextRouterOf('escalate-on-fail')).toBe('off');
  });

  it('the skill toggle drops a carried name and adds a missing one', () => {
    expect(skillsToggled(['a', 'b'], 'a')).toEqual(['b']);
    expect(skillsToggled(['b'], 'a')).toEqual(['b', 'a']);
  });

  it('the pool words join the models and read empty as none', () => {
    expect(poolWordsOf(['opus', 'sonnet', 'glm-5.2'])).toBe('opus · sonnet · glm-5.2');
    expect(poolWordsOf([])).toBe('');
    expect(poolWordsOf(['', 'opus'])).toBe('opus');
  });

  it('the worker sheet offers the desk’s harnesses', () => {
    expect(WORKER_OPTIONS).toEqual(['claude-code', 'opencode']);
  });
});

// --- the four tabs ----------------------------------------------------------------------

describe('the four tabs', () => {
  it('a fresh 1:1 opens on the chat tab with the local state cleared', () => {
    const openSignal = signal<{ id: string } | null>({ id: 'pia' });
    const fake = makeVm();
    fake.open = () => openSignal();
    const vm = surface(setup(fake));
    expect(vm.isOpen()).toBe(true);
    expect(vm.tab()).toBe('chat');

    vm.setTab('setup');
    vm.draft.set('leftover');
    vm.promptDraft.set('leftover prompt');
    expect(vm.tab()).toBe('setup');
    expect(vm.draft()).toBe('leftover');

    // The same persona re-opened: everything resets to the chat tab.
    openSignal.set({ id: 'pia' });
    TestBed.flushEffects();
    expect(vm.tab()).toBe('chat');
    expect(vm.draft()).toBe('');
    expect(vm.promptDraft()).toBe('');
    expect(vm.cards()).toEqual([]);
  });

  it('the closed vm renders nothing; the header falls back to the facts or the open id', () => {
    const vm = surface(setup(makeVm({ openState: null })));
    expect(vm.isOpen()).toBe(false);
    // The facts still ride along harmlessly — the template gates on isOpen.
    expect(vm.title()).toBe('Pia');

    const ghost = surface(setup(makeVm({ facts: null, openState: { id: 'ghost' } })));
    expect(ghost.openId()).toBe('ghost');
    expect(ghost.title()).toBe('ghost');
  });

  it('the tab badges count open proposals and memory entries, hiding at zero', () => {
    const open = proposal('imp-1');
    const vm = surface(
      setup(
        makeVm({ view: view({ proposals: [open, proposal('imp-2', { state: 'accepted' })] }) }),
      ),
    );
    expect(vm.improveCount()).toBe(1);
    expect(vm.memCount()).toBe(0);

    const withMemory = surface(
      setup(
        makeVm({
          memoryValue: {
            entries: [
              { text: 'a', pinned: false },
              { text: 'b', pinned: true },
            ],
          },
        }),
      ),
    );
    expect(withMemory.memCount()).toBe(2);
  });
});

// --- the chat tab: the pattern cards -----------------------------------------------------

describe('the chat tab’s pattern cards', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  async function sendText(vm: DetailSurface, text: string): Promise<void> {
    vm.draft.set(text);
    await vm.send();
    await flush();
  }

  it('a plain line sends without a card', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await sendText(vm, 'Why the ranks?');
    expect(fake.sent).toEqual(['Why the ranks?']);
    expect(vm.cards()).toEqual([]);
    expect(vm.sendError()).toBeNull();
  });

  it('a prompt line offers the patch card; applying PATCHes the prompt and toasts the commit', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await sendText(vm, 'New rule: read the repo history first');
    const cards = vm.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe('prompt');
    expect(cards[0]!.decided).toBeNull();
    expect(vm.snippet(cards[0]!)).toContain('New rule');

    await vm.applyCard(cards[0]!);
    expect(fake.patched).toEqual([{ prompt: 'New rule: read the repo history first' }]);
    expect(vm.cards()[0]!.decided).toBe('applied');
    expect(fake.toasts).toEqual([{ message: 'Prompt updated (commit)', kind: 'ok' }]);
  });

  it('a memory line offers the proposal card; applying appends the whole line as the entry', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await sendText(vm, 'remember: rank fields win over derived order');
    const cards = vm.cards();
    expect(cards[0]!.kind).toBe('memory');

    await vm.applyCard(cards[0]!);
    expect(fake.addedMemory).toEqual(['remember: rank fields win over derived order']);
    expect(fake.patched).toEqual([]);
    expect(fake.toasts).toEqual([{ message: 'Memory entry added (commit)', kind: 'ok' }]);
  });

  it('a "New ticket:" line hands through to Mission Control instead of patching', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await sendText(vm, 'New ticket: Column editor with preview');
    expect(fake.prefilled).toEqual(['New ticket: Column editor with preview']);
    expect(fake.patched).toEqual([]);
    expect(fake.addedMemory).toEqual([]);
    expect(vm.cards().map((card) => card.kind)).toEqual(['ticket']);
  });

  it('a card refusal lands inline on the card and the card stays waiting', async () => {
    const fake = makeVm({ patchReplies: [{ ok: false, error: 'the desk refused' }] });
    const vm = surface(setup(fake));
    await sendText(vm, 'prompt: always cite the ticket');
    const card = vm.cards()[0]!;
    await vm.applyCard(card);
    expect(vm.errorForCard(card)).toBe('the desk refused');
    expect(card.decided).toBeNull();
    expect(fake.toasts).toEqual([]);
  });

  it('discarding folds the card and toasts that nothing changed', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await sendText(vm, 'prompt: always cite the ticket');
    const card = vm.cards()[0]!;
    vm.dismissCard(card);
    expect(vm.cards()[0]!.decided).toBe('dismissed');
    expect(fake.patched).toEqual([]);
    expect(fake.toasts).toEqual([{ message: 'Discarded — nothing changed', kind: 'ok' }]);
  });

  it('a send refusal surfaces inline and never throws', async () => {
    const fake = makeVm({ sendReplies: [{ ok: false, error: 'the desk did not take it' }] });
    const vm = surface(setup(fake));
    await sendText(vm, 'plain hello');
    expect(vm.sendError()).toBe('the desk did not take it');
    expect(vm.sending()).toBe(false);

    const throwing = makeVm();
    throwing.sendThread = () => Promise.reject(new Error('offline'));
    const vm2 = surface(setup(throwing));
    await sendText(vm2, 'plain hello');
    expect(vm2.sendError()).toBe('The message did not go through.');
  });

  it('read-only devices never send and never offer cards', async () => {
    const fake = makeVm({ readonly: true });
    const vm = surface(setup(fake));
    vm.draft.set('prompt: something');
    await vm.send();
    expect(fake.sent).toEqual([]);
    expect(vm.cards()).toEqual([]);
  });
});

// --- the memory tab ----------------------------------------------------------------------

describe('the memory tab', () => {
  it('pins and unpins route through the vm with the flipped value and the index', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await vm.togglePin(1, true);
    await vm.togglePin(2, false);
    expect(fake.pins).toEqual([
      { index: 1, pinned: false },
      { index: 2, pinned: true },
    ]);
    expect(vm.pinBusy()).toBeNull();
    expect(vm.pinError()).toBeNull();
  });

  it('a pin refusal lands inline and never throws', async () => {
    const fake = makeVm({ pinReplies: [{ ok: false, error: 'the desk refused' }] });
    const vm = surface(setup(fake));
    await vm.togglePin(0, false);
    expect(vm.pinError()).toBe('the desk refused');

    const throwing = makeVm();
    throwing.pinMemory = () => Promise.reject(new Error('offline'));
    const vm2 = surface(setup(throwing));
    await vm2.togglePin(0, false);
    expect(vm2.pinError()).toBe('The pin did not take.');
  });

  it('the manual add trims and refuses an empty draft silently', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    vm.memDraft.set('   ');
    await vm.addMemory();
    expect(fake.addedMemory).toEqual([]);
    expect(vm.memError()).toBeNull();

    vm.memDraft.set('  read history first  ');
    await vm.addMemory();
    expect(fake.addedMemory).toEqual(['read history first']);
    expect(vm.memDraft()).toBe('');
  });

  it('an add refusal lands inline', async () => {
    const fake = makeVm({ addReplies: [{ ok: false, error: 'no such persona' }] });
    const vm = surface(setup(fake));
    vm.memDraft.set('one line');
    await vm.addMemory();
    expect(vm.memError()).toBe('no such persona');
  });

  it('read-only devices never add or pin', async () => {
    const fake = makeVm({ readonly: true });
    const vm = surface(setup(fake));
    vm.memDraft.set('one line');
    await vm.addMemory();
    await vm.togglePin(0, false);
    expect(fake.addedMemory).toEqual([]);
    expect(fake.pins).toEqual([]);
  });
});

// --- the setup tab -----------------------------------------------------------------------

describe('the setup tab', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('the router row cycles off → budget → escalate-on-fail → off with one PATCH per tap', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    expect(vm.routerValue()).toBe('off');

    await vm.cycleRouter();
    expect(vm.routerValue()).toBe('budget');
    await vm.cycleRouter();
    expect(vm.routerValue()).toBe('escalate-on-fail');
    await vm.cycleRouter();
    expect(vm.routerValue()).toBe('off');
    expect(fake.patched).toEqual([
      { router: 'budget' },
      { router: 'escalate-on-fail' },
      { router: 'off' },
    ]);
    await flush();
  });

  it('the router commit toasts the commit words; a refusal reverts the local mirror', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await vm.cycleRouter();
    expect(fake.toasts[0]?.message).toBe('personas: pia router → budget (commit)');

    const refused = makeVm({ patchReplies: [{ ok: false, error: 'the desk refused' }] });
    const vm2 = surface(setup(refused));
    await vm2.cycleRouter();
    expect(vm2.routerValue()).toBe('off');
    expect(vm2.setupError()).toBe('the desk refused');
  });

  it('the model sheet offers the pool (the current model as the fallback) and picks with a PATCH', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    expect(vm.modelOptions()).toEqual(['zai/glm-5.3', 'sonnet']);

    vm.openSheet('model');
    expect(vm.sheet()).toBe('model');
    await vm.pick('model', 'sonnet');
    expect(fake.patched).toEqual([{ model: 'sonnet' }]);
    expect(vm.sheet()).toBeNull();

    const bare = makeVm({ facts: { ...PIA_FACTS, pool: [], model: 'opus' } });
    const vm2 = surface(setup(bare));
    expect(vm2.modelOptions()).toEqual(['opus']);
    await vm2.pick('model', 'opus');
    expect(bare.patched).toEqual([{ model: 'opus' }]);
  });

  it('the worker sheet offers the harnesses and picks with a PATCH', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await vm.pick('worker', 'opencode');
    expect(fake.patched).toEqual([{ worker: 'opencode' }]);
    expect(vm.workerOptions()).toEqual(['claude-code', 'opencode']);
  });

  it('the skill switch PATCHes the new list and toggles at once', async () => {
    const fake = makeVm({
      facts: { ...PIA_FACTS, skills: ['repo-recherche.md', 'diff-review.md'] },
    });
    const vm = surface(setup(fake));
    expect(vm.skillsValue()).toEqual(['repo-recherche.md', 'diff-review.md']);
    expect(vm.skillOn('diff-review.md')).toBe(true);

    await vm.toggleSkill('diff-review.md');
    expect(vm.skillsValue()).toEqual(['repo-recherche.md']);
    expect(fake.patched).toEqual([{ skills: ['repo-recherche.md'] }]);

    await vm.toggleSkill('diff-review.md');
    expect(vm.skillsValue()).toEqual(['repo-recherche.md', 'diff-review.md']);
    expect(fake.patched[1]).toEqual({ skills: ['repo-recherche.md', 'diff-review.md'] });
    await flush();
  });

  it('the prompt editor refuses an empty draft and saves with one PATCH plus the toast', async () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    await vm.savePrompt();
    expect(fake.patched).toEqual([]);

    vm.promptDraft.set('You are the planner.');
    await vm.savePrompt();
    expect(fake.patched).toEqual([{ prompt: 'You are the planner.' }]);
    expect(vm.promptDraft()).toBe('');
    expect(fake.toasts).toEqual([{ message: 'Prompt updated (commit)', kind: 'ok' }]);
  });

  it('a prompt refusal lands inline and never throws', async () => {
    const fake = makeVm({ patchReplies: [{ ok: false, error: 'the desk refused' }] });
    const vm = surface(setup(fake));
    vm.promptDraft.set('New text');
    await vm.savePrompt();
    expect(vm.promptError()).toBe('the desk refused');

    const throwing = makeVm();
    throwing.patchPersona = () => Promise.reject(new Error('offline'));
    const vm2 = surface(setup(throwing));
    vm2.promptDraft.set('New text');
    await vm2.savePrompt();
    expect(vm2.promptError()).toBe('The prompt did not save.');
  });

  it('the pool row toasts the follow-up and patches nothing', () => {
    const fake = makeVm();
    const vm = surface(setup(fake));
    vm.poolTap();
    expect(fake.patched).toEqual([]);
    expect(fake.toasts).toEqual([{ message: 'Pool editing — to come', kind: 'ok' }]);
    expect(vm.poolWords()).toBe('zai/glm-5.3 · sonnet');
  });

  it('read-only devices never patch: the sheets stay closed and the rows stay still', async () => {
    const fake = makeVm({ readonly: true });
    const vm = surface(setup(fake));
    vm.openSheet('model');
    await vm.cycleRouter();
    await vm.toggleSkill('diff-review.md');
    vm.promptDraft.set('New text');
    await vm.savePrompt();
    expect(fake.patched).toEqual([]);
    expect(vm.sheet()).toBeNull();
    expect(vm.routerValue()).toBe('off');
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// --- E12-4 / D8: Chat and 1:1 are one conversation -------------------------------------

describe('the merged 1:1 tab', () => {
  function render(vm: FakeVm): HTMLElement {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: MC_TEAM_DETAIL, useValue: vm }] });
    const fixture = TestBed.createComponent(PersonaDetail);
    fixture.detectChanges();
    TestBed.flushEffects();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('has three tabs — 1:1, Memory, Setup — with the open drafts as the 1:1 badge', () => {
    const el = render(makeVm({ view: view({ proposals: [proposal('imp-1')], openCount: 1 }) }));
    const tabs = Array.from(el.querySelectorAll('[role="tab"]')).map((t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(tabs).toEqual(['1:1 · 1', 'Memory', 'Setup']);
  });

  it('shows the improvement drafts, the thread and the composer in the one pane', () => {
    const el = render(
      makeVm({
        view: view({ proposals: [proposal('imp-1')], openCount: 1 }),
        threadValue: { messages: [{ role: 'owner', text: 'Why the ranks?', at: '' }] },
      }),
    );
    expect(el.querySelectorAll('.imp')).toHaveLength(1);
    expect(el.querySelector('.thread .bubble')?.textContent).toContain('Why the ranks?');
    expect(el.querySelector('.composer input')).not.toBeNull();
  });
});
