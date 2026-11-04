import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Signal, type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActiveSession, ChatFailureView, ChatMessageView, ChatProposalView, ChatStateView, McChainEntry, McPlanStatus, WorkView } from '../api/dto';
import { DEFAULT_PRIORITY_CONFIG } from '../api/dto';
import type { McChatState, McChatUploadReply } from './chat.model';
import {
  Chat,
  TimelineProposal,
  TimelineSession,
  attachmentToastOf,
  basenameOf,
  cardPriorityOf,
  chainCompareOf,
  composerRowsOf,
  errorOf,
  historyGroupsOf,
  isTurnStreaming,
  phaseDirOf,
  proposalDetailOf,
  relativeAge,
  thinkFoldLabel,
  thinkSecondsLabel,
  timelineOf,
} from './chat';
import { MC_CHAT_STATE } from './chat.model';

// -- fixtures ---------------------------------------------------------------

function msg(role: 'owner' | 'mission', text: string, at: string, thought: string | null = null): ChatMessageView {
  return { role, text, at, thought };
}

function proposal(
  id: string,
  state: 'pending' | 'confirmed' | 'dismissed',
  at?: string,
  options: { decidedAt?: string | null; outcome?: string | null; summary?: string; chain?: TimelineProposal['chain'] } = {},
): TimelineProposal {
  const item: TimelineProposal = {
    id,
    state,
    summary: options.summary ?? `summary ${id}`,
    outcome: options.outcome ?? null,
    ...(options.chain !== undefined ? { chain: options.chain } : {}),
  };
  if (at !== undefined) {
    (item as { at?: string }).at = at;
  }
  if (options.decidedAt !== undefined) {
    (item as { decidedAt?: string | null }).decidedAt = options.decidedAt;
  }
  return item;
}

function session(messages: readonly ChatMessageView[], proposals: readonly TimelineProposal[]): TimelineSession {
  return { messages, proposals };
}

// -- timelineOf: the stamped path (proposals carry their arrival stamps) -----

describe('timelineOf with stamped proposals', () => {
  it('merges messages and proposals by order of arrival', () => {
    const owner = msg('owner', 'Move T-0086 to review', '2026-11-02T09:00:00Z');
    const mission = msg('mission', 'Done.', '2026-11-02T09:01:00Z');
    const card = proposal('p-1', 'pending', '2026-11-02T09:01:30Z');
    const items = timelineOf(session([owner, mission], [card]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'proposal']);
    expect(items[2]).toMatchObject({ kind: 'proposal', proposal: card });
  });

  it('places a pending proposal between messages by its stamp', () => {
    const owner = msg('owner', 'one', '2026-11-02T09:00:00Z');
    const card = proposal('p-1', 'pending', '2026-11-02T09:00:30Z');
    const later = msg('owner', 'two', '2026-11-02T09:05:00Z');
    const items = timelineOf(session([owner, later], [card]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'proposal', 'message']);
  });

  it('renders a decided proposal as a history entry at its decision time', () => {
    const mission = msg('mission', 'Shall I?', '2026-11-02T09:01:00Z');
    const owner = msg('owner', 'yes', '2026-11-02T09:02:00Z');
    const later = msg('mission', 'It is done.', '2026-11-02T09:03:00Z');
    const decided = proposal('p-1', 'confirmed', '2026-11-02T09:01:30Z', {
      decidedAt: '2026-11-02T09:05:00Z',
      outcome: 'ok',
    });
    const items = timelineOf(session([mission, owner, later], [decided]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'message', 'decision']);
    const last = items[3]!;
    expect(last.at).toBe('2026-11-02T09:05:00Z');
    if (last.kind === 'decision') {
      expect(last.proposal.id).toBe('p-1');
      expect(last.proposal.outcome).toBe('ok');
    }
  });

  it('keeps the mission message before its same-stamp proposal (file order)', () => {
    const stamp = '2026-11-02T09:01:44Z';
    const mission = msg('mission', 'Done.', stamp);
    const card = proposal('p-1', 'pending', stamp);
    const items = timelineOf(session([mission], [card]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'proposal']);
  });

  it('falls back to the proposal stamp when a decision carries none', () => {
    const mission = msg('mission', 'Done.', '2026-11-02T09:01:00Z');
    const decided = proposal('p-1', 'dismissed', '2026-11-02T09:01:30Z', { decidedAt: null });
    const items = timelineOf(session([mission], [decided]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'decision']);
    expect(items[1]!.at).toBe('2026-11-02T09:01:30Z');
  });
});

// -- timelineOf: the fallback (the view DTO dropped the stamps) ---------------

describe('timelineOf without stamps', () => {
  it('keeps the messages first and the proposals in array order', () => {
    const owner = msg('owner', 'one', '2026-11-02T09:00:00Z');
    const mission = msg('mission', 'two', '2026-11-02T09:01:00Z');
    const decided = proposal('p-1', 'confirmed', undefined, { outcome: 'ok' });
    const card = proposal('p-2', 'pending');
    const items = timelineOf(session([owner, mission], [decided, card]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'decision', 'proposal']);
    expect(items[2]).toMatchObject({ kind: 'decision', proposal: decided });
    expect(items[3]).toMatchObject({ kind: 'proposal', proposal: card });
  });

  it('falls back as soon as a single proposal lacks its stamp', () => {
    const owner = msg('owner', 'one', '2026-11-02T09:00:00Z');
    const stamped = proposal('p-1', 'pending', '2026-11-02T09:00:30Z');
    const unstamped = proposal('p-2', 'pending');
    const items = timelineOf(session([owner], [stamped, unstamped]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'proposal', 'proposal']);
  });

  it('returns an empty timeline for an empty session', () => {
    expect(timelineOf(session([], []))).toEqual([]);
  });

  it('does not mutate the session arrays', () => {
    const owner = msg('owner', 'one', '2026-11-02T09:05:00Z');
    const mission = msg('mission', 'two', '2026-11-02T09:00:00Z');
    const card = proposal('p-1', 'pending', '2026-11-02T09:01:00Z');
    const s = session([owner, mission], [card]);
    timelineOf(s);
    expect(s.messages.map((m) => m.at)).toEqual(['2026-11-02T09:05:00Z', '2026-11-02T09:00:00Z']);
    expect(s.proposals.map((p) => p.id)).toEqual(['p-1']);
  });
});

// -- isTurnStreaming -----------------------------------------------------------

describe('isTurnStreaming', () => {
  it('is false when no turn runs', () => {
    expect(isTurnStreaming([], false)).toBe(false);
    expect(isTurnStreaming([msg('owner', 'hi', '2026-11-02T09:00:00Z')], false)).toBe(false);
  });

  it('is true while the owner message waits for the mission reply', () => {
    expect(isTurnStreaming([], true)).toBe(true);
    expect(isTurnStreaming([msg('owner', 'hi', '2026-11-02T09:00:00Z')], true)).toBe(true);
  });

  it('is false once mission text has landed', () => {
    const messages = [msg('owner', 'hi', '2026-11-02T09:00:00Z'), msg('mission', 'partial', '2026-11-02T09:00:10Z')];
    expect(isTurnStreaming(messages, true)).toBe(false);
  });
});

// -- composerRowsOf --------------------------------------------------------------

describe('composerRowsOf', () => {
  it('starts at one row', () => {
    expect(composerRowsOf('')).toBe(1);
    expect(composerRowsOf('single line')).toBe(1);
  });

  it('grows with newline-separated lines', () => {
    expect(composerRowsOf('a\nb\nc')).toBe(3);
  });

  it('caps at five rows', () => {
    expect(composerRowsOf('1\n2\n3\n4\n5')).toBe(5);
    expect(composerRowsOf(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))).toBe(5);
  });

  it('honours a custom cap', () => {
    expect(composerRowsOf('a\nb\nc', 2)).toBe(2);
  });
});

// -- relativeAge -------------------------------------------------------------------

describe('relativeAge', () => {
  // Local-noon anchor keeps the calendar-day cases timezone-independent.
  const now = new Date(2026, 10, 2, 12, 0, 0).getTime();
  const at = (date: Date): string => date.toISOString();

  it('reads now under 45 seconds', () => {
    expect(relativeAge(at(new Date(now - 30_000)), now)).toBe('now');
  });

  it('reads minutes under an hour', () => {
    expect(relativeAge(at(new Date(now - 5 * 60_000)), now)).toBe('5 min');
  });

  it('reads hours under a day', () => {
    expect(relativeAge(at(new Date(now - 3 * 3_600_000)), now)).toBe('3 h');
    expect(relativeAge(at(new Date(now - 23 * 3_600_000)), now)).toBe('23 h');
  });

  it('reads yesterday for the previous calendar day', () => {
    expect(relativeAge(at(new Date(2026, 10, 1, 8, 0, 0)), now)).toBe('yesterday');
  });

  it('reads whole days beyond yesterday', () => {
    expect(relativeAge(at(new Date(2026, 9, 30, 12, 0, 0)), now)).toBe('3 d');
  });

  it('returns an empty string for an unreadable stamp', () => {
    expect(relativeAge('not-a-date', now)).toBe('');
  });
});

// -- errorOf ------------------------------------------------------------------------

describe('errorOf', () => {
  it('is null for a successful reply', () => {
    expect(errorOf({ ok: true })).toBeNull();
    expect(errorOf({ ok: true, error: 'ignored' })).toBeNull();
  });

  it('surfaces the error sentence of a failed reply', () => {
    expect(errorOf({ ok: false, error: 'no such proposal' })).toBe('no such proposal');
  });

  it('falls back to a generic sentence for a bare failure', () => {
    expect(errorOf({ ok: false })).toBe('Something went wrong — try again.');
  });

  it('surfaces an error without an ok flag', () => {
    expect(errorOf({ error: 'heads-up' })).toBe('heads-up');
  });

  it('is null when there is nothing to read', () => {
    expect(errorOf(undefined)).toBeNull();
    expect(errorOf(null)).toBeNull();
    expect(errorOf('plain string')).toBeNull();
    expect(errorOf({})).toBeNull();
  });
});

// -- proposalDetailOf: the rich cards' fields off the summary sentence ---------

describe('proposalDetailOf', () => {
  it('reads a transition card’s id, from and to', () => {
    expect(proposalDetailOf('Move T-0086 from build to verify')).toEqual({
      kind: 'transition',
      id: 'T-0086',
      from: 'build',
      to: 'verify',
    });
  });

  it('reads a create card’s title and phase', () => {
    expect(proposalDetailOf('Create ticket "Wochenkosten als CSV" in ideas')).toEqual({
      kind: 'create',
      title: 'Wochenkosten als CSV',
      phase: 'ideas',
    });
  });

  it('reads a blocked-by card’s id list', () => {
    expect(proposalDetailOf('Block T-0002 by T-0001, T-0003')).toEqual({
      kind: 'blocked',
      id: 'T-0002',
      ids: ['T-0001', 'T-0003'],
    });
  });

  it('reads a cleared blockers card as the empty id list', () => {
    expect(proposalDetailOf('Clear T-0002 blockers')).toEqual({ kind: 'blocked', id: 'T-0002', ids: [] });
  });

  it('reads a setPriority card’s target priority', () => {
    expect(proposalDetailOf('Set T-0086 priority to urgent')).toEqual({
      kind: 'priority',
      id: 'T-0086',
      to: 'urgent',
    });
  });

  it('reads a promote card’s ticket id', () => {
    expect(proposalDetailOf('Promote T-0090 to a ship ticket')).toEqual({ kind: 'promote', id: 'T-0090' });
  });

  it('returns null for anything the engine does not mint — the summary line shows', () => {
    expect(proposalDetailOf('Set T-0086 chain to 2 entries')).toBeNull();
    expect(proposalDetailOf('Return T-0086 to the standard flow')).toBeNull();
    expect(proposalDetailOf('')).toBeNull();
    expect(proposalDetailOf('Create ticket without quotes in ideas')).toBeNull();
  });
});

// -- phaseDirOf: the create diffbox's directory ---------------------------------

describe('phaseDirOf', () => {
  const board = {
    columns: [
      {
        phase: { id: 'inbox', title: 'Inbox' },
        tickets: [{ id: 'T-0001', path: 'tickets/10-inbox/T-0001.md' }],
      },
      {
        phase: { id: 'build', title: 'Build' },
        tickets: [{ id: 'T-0002', path: 'tickets/25-build/T-0002.md' }],
      },
      { phase: { id: 'ideas', title: 'Ideas' }, tickets: [] },
    ],
  };

  it('reuses the directory a sibling ticket in the phase sits in', () => {
    expect(phaseDirOf(board, 'build')).toBe('25-build');
  });

  it('derives the NN-id name when the phase has no sibling yet', () => {
    expect(phaseDirOf(board, 'ideas')).toBe('30-ideas');
  });

  it('returns null for a phase the board does not know — no path line', () => {
    expect(phaseDirOf(board, 'archive')).toBeNull();
    expect(phaseDirOf(null, 'ideas')).toBeNull();
    expect(phaseDirOf(board, '')).toBeNull();
  });
});

// -- cardPriorityOf: the priority card's "from" side -----------------------------

describe('cardPriorityOf', () => {
  const board = {
    columns: [
      {
        phase: { id: 'build', title: 'Build' },
        tickets: [
          { id: 'T-0001', meta: { priority: 'high' } },
          { id: 'T-0002', meta: {} },
        ],
      },
    ],
  };

  it('reads the ticket’s current priority off the board', () => {
    expect(cardPriorityOf(board, 'T-0001')).toBe('high');
  });

  it('is null without a readable priority or a missing card', () => {
    expect(cardPriorityOf(board, 'T-0002')).toBeNull();
    expect(cardPriorityOf(board, 'T-9999')).toBeNull();
    expect(cardPriorityOf(null, 'T-0001')).toBeNull();
  });
});

// -- the thinking trace's fold ------------------------------------------------------

describe('think fold labels', () => {
  it('formats the measured window as German seconds with one decimal', () => {
    expect(thinkSecondsLabel(1_000, 3_400)).toBe('2,4 s');
    expect(thinkSecondsLabel(0, 10_050)).toBe('10,1 s');
  });

  it('is null while the window is not measurable', () => {
    expect(thinkSecondsLabel(null, 1_000)).toBeNull();
    expect(thinkSecondsLabel(1_000, null)).toBeNull();
    expect(thinkSecondsLabel(2_000, 1_000)).toBeNull();
    // Text arrived with the thought: nothing measurable happened.
    expect(thinkSecondsLabel(1_000, 1_050)).toBeNull();
  });

  it('folds with the duration when measured, else without seconds', () => {
    expect(thinkFoldLabel(null)).toBe('Thought');
    expect(thinkFoldLabel('2,4 s')).toBe('Thought · 2,4 s');
  });
});

// -- the constructor's prefill adoption (E8) --------------------------------------

describe('Chat prefill adoption (E8)', () => {
  interface FakeChatState {
    chatPrefill: WritableSignal<string | null>;
    chat: Signal<ChatStateView>;
  }

  function fakeState(prefill: string | null, active: ActiveSession | null = null): FakeChatState {
    return {
      chatPrefill: signal(prefill),
      chat: signal<ChatStateView>({ sessions: [], active }),
    };
  }

  // The template-facing surface is protected/private; these specs drive
  // the class directly, so expose it through one typed lens.
  interface ChatSurface {
    draft(): string;
    viewMode(): 'empty' | 'composer' | 'session';
    planChip(): string | null;
    planOn(): boolean;
    togglePlanEdits(): void;
  }

  function setup(fake: FakeChatState): { vm: ChatSurface; fake: FakeChatState } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: MC_CHAT_STATE, useValue: fake as unknown as McChatState }],
    });
    const chat = TestBed.runInInjectionContext(() => new Chat());
    return { vm: chat as unknown as ChatSurface, fake };
  }

  it('shows the plan chip while edits wait, lets the owner leave them out, and shows none without a plan', () => {
    const plan = signal<McPlanStatus | null>({ version: 3, edits: 2, summary: '2 edits', marks: [] });
    const planEdits = signal(true);
    const fake = { ...fakeState(null), chatPlan: plan, planEdits };
    const { vm } = setup(fake as unknown as FakeChatState);
    expect(vm.planChip()).toBe('2 new edits of yours go along');
    expect(vm.planOn()).toBe(true);
    vm.togglePlanEdits();
    expect(planEdits()).toBe(false);
    expect(vm.planOn()).toBe(false);
    plan.set({ version: 3, edits: 0, summary: null, marks: [] });
    expect(vm.planChip()).toBeNull();

    expect(setup(fakeState(null)).vm.planChip()).toBeNull();
  });

  it('opens empty when nothing waits', () => {
    const { vm, fake } = setup(fakeState(null));
    expect(vm.draft()).toBe('');
    expect(vm.viewMode()).toBe('empty');
    expect(fake.chatPrefill()).toBeNull();
  });

  it('adopts the prefill into a fresh composer when no session is open', () => {
    const { vm, fake } = setup(fakeState('promote T-0004'));
    expect(vm.draft()).toBe('promote T-0004');
    expect(vm.viewMode()).toBe('composer');
    // One-shot: consumed on adoption.
    expect(fake.chatPrefill()).toBeNull();
  });

  it("with an open session the prefill sits in that session's composer", () => {
    const active: ActiveSession = { file: 'f.md', title: 'F', createdAt: '', messages: [], proposals: [] };
    const { vm, fake } = setup(fakeState('promote T-0004', active));
    expect(vm.draft()).toBe('promote T-0004');
    expect(vm.viewMode()).toBe('session');
    expect(fake.chatPrefill()).toBeNull();
  });
});

// -- chainCompareOf: the setChain before/after (E9) --------------------------------

describe('chainCompareOf', () => {
  const phases = [
    { id: 'inbox', title: 'Inbox', checkpoint: false },
    { id: 'build', title: 'Build', checkpoint: false },
    { id: 'verify', title: 'Verify', checkpoint: true },
    { id: 'done', title: 'Done', checkpoint: false },
  ];
  const skipVerify: McChainEntry = { kind: 'skip', phase: 'verify', anchor: null, position: null, persona: null, notify: false };

  it('merges the current delta into "before" and the proposed entries into "after"', () => {
    const compare = chainCompareOf(phases, 'build', [skipVerify], ['skip verify', 'notify build']);
    expect(compare.before.map((step) => step.id)).toEqual(['inbox', 'build', 'verify', 'done']);
    expect(compare.before.find((step) => step.id === 'verify')?.skipped).toBe(true);
    expect(compare.before.find((step) => step.id === 'build')?.notify).toBe(false);
    expect(compare.after.find((step) => step.id === 'build')?.notify).toBe(true);
    expect(compare.after.find((step) => step.id === 'verify')?.skipped).toBe(true);
  });

  it('splices inserted gates into the after strip only', () => {
    const compare = chainCompareOf(phases, 'build', [], ['insert design(pia, notify) after build']);
    expect(compare.before.map((step) => step.id)).not.toContain('design');
    const at = compare.after.findIndex((step) => step.id === 'design');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(compare.after[at! - 1]?.id).toBe('build');
    expect(compare.after[at!]).toMatchObject({ inserted: true, persona: 'pia', notify: true });
  });

  it('drops proposed entries the grammar does not read — never a guess', () => {
    const compare = chainCompareOf(phases, 'build', [], ['notify build', 'make tea', '']);
    expect(compare.after.map((step) => step.id)).toEqual(['inbox', 'build', 'verify', 'done']);
    expect(compare.after.find((step) => step.id === 'build')?.notify).toBe(true);
  });

  it('marks nothing current when the ticket sits outside the chain', () => {
    const compare = chainCompareOf(phases, 'limbo', [], ['notify build']);
    expect(compare.after.every((step) => step.state === 'future')).toBe(true);
  });
});

// -- the component's chainCompareFor (E9) ------------------------------------------

describe('Chat setChain before/after card (E9)', () => {
  interface ChainFakeState {
    chatPrefill: WritableSignal<string | null>;
    chat: Signal<ChatStateView>;
    board: Signal<unknown>;
    work: Signal<WorkView>;
  }

  const BOARD = {
    checkpoints: ['verify'],
    columns: [
      { phase: { id: 'inbox', title: 'Inbox' }, tickets: [] },
      {
        phase: { id: 'build', title: 'Build' },
        tickets: [{ id: 'T-1', phase: 'build', meta: { chain: [{ kind: 'skip', phase: 'verify' }] } }],
      },
      { phase: { id: 'verify', title: 'Verify' }, tickets: [] },
      { phase: { id: 'done', title: 'Done' }, tickets: [] },
    ],
  };

  const WORK: WorkView = {
    groups: [
      { id: 'inbox', title: 'Inbox', cards: [] },
      { id: 'build', title: 'Build', cards: [] },
      { id: 'verify', title: 'Verify', cards: [] },
      { id: 'done', title: 'Done', cards: [] },
    ],
    priorities: DEFAULT_PRIORITY_CONFIG,
  };

  function fakeState(board: unknown, work: WorkView): ChainFakeState {
    return {
      chatPrefill: signal(null),
      chat: signal<ChatStateView>({ sessions: [], active: null }),
      board: signal(board),
      work: signal(work),
    };
  }

  interface ChainSurface {
    chainCompareFor(proposal: TimelineProposal): { before: readonly { id: string; skipped: boolean; notify: boolean }[]; after: readonly { id: string; skipped: boolean; notify: boolean }[] } | null;
  }

  function setup(fake: ChainFakeState): ChainSurface {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: MC_CHAT_STATE, useValue: fake as unknown as McChatState }],
    });
    return TestBed.runInInjectionContext(() => new Chat()) as unknown as ChainSurface;
  }

  const setChain: TimelineProposal = {
    id: 'p-1',
    state: 'pending',
    summary: 'Set T-1 chain to 1 entry',
    outcome: null,
    chain: { id: 'T-1', chain: ['notify build'] },
  };

  it('renders the ticket’s current delta as "before" and the proposal as "after"', () => {
    const vm = setup(fakeState(BOARD, WORK));
    const compare = vm.chainCompareFor(setChain);
    expect(compare).not.toBeNull();
    expect(compare!.before.find((step) => step.id === 'verify')?.skipped).toBe(true);
    expect(compare!.before.find((step) => step.id === 'build')?.notify).toBe(false);
    expect(compare!.after.find((step) => step.id === 'build')?.notify).toBe(true);
  });

  it('returns null for proposals that wrap no setChain command', () => {
    const vm = setup(fakeState(BOARD, WORK));
    const other: TimelineProposal = { id: 'p-2', state: 'pending', summary: 'Move T-1', outcome: null };
    expect(vm.chainCompareFor(other)).toBeNull();
  });

  it('renders a setBlockedBy proposal by its summary alone — no chain compare', () => {
    // The card's compare strips exist for setChain only; a setBlockedBy
    // command carries no gate delta, so the rich body reads the summary.
    const vm = setup(fakeState(BOARD, WORK));
    const setBlockedBy: TimelineProposal = {
      id: 'p-3',
      state: 'pending',
      summary: 'Block T-0002 by T-0001',
      outcome: null,
    };
    expect(vm.chainCompareFor(setBlockedBy)).toBeNull();
    const cleared: TimelineProposal = {
      id: 'p-4',
      state: 'pending',
      summary: 'Clear T-0002 blockers',
      outcome: null,
    };
    expect(vm.chainCompareFor(cleared)).toBeNull();
  });

  it('degrades to an all-future "before" when the board holds no such card', () => {
    const vm = setup(fakeState({ checkpoints: [], columns: [] }, WORK));
    const compare = vm.chainCompareFor(setChain);
    expect(compare).not.toBeNull();
    expect(compare!.before.every((step) => !step.skipped)).toBe(true);
    expect(compare!.after.find((step) => step.id === 'build')?.notify).toBe(true);
  });
});

// -- the cards' kickers (the mono .ck labels) ---------------------------------------

describe('Chat card kickers', () => {
  function setup(chatView: ChatStateView): { vm: CardSurface } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MC_CHAT_STATE,
          useValue: {
            chatPrefill: signal(null),
            chat: signal<ChatStateView>(chatView),
            board: signal(null),
            work: signal<WorkView>({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
          } as unknown as McChatState,
        },
      ],
    });
    return { vm: TestBed.runInInjectionContext(() => new Chat()) as unknown as CardSurface };
  }

  interface CardSurface {
    ckOf(proposal: TimelineProposal): string;
    ckDoneOf(proposal: TimelineProposal): string;
  }

  it('labels each kind’s pending card', () => {
    const { vm } = setup({ sessions: [], active: null });
    expect(vm.ckOf(proposal('p-1', 'pending', undefined, { chain: { id: 'T-1', chain: [] } }))).toBe('T-1 · Chain');
    expect(vm.ckOf(proposal('p-2', 'pending', undefined, { summary: 'Move T-0086 from build to verify' }))).toBe(
      'Transition · confirmation',
    );
    expect(vm.ckOf(proposal('p-3', 'pending', undefined, { summary: 'Create ticket "CSV" in ideas' }))).toBe(
      'New ticket · confirmation',
    );
    expect(vm.ckOf(proposal('p-4', 'pending', undefined, { summary: 'Block T-0002 by T-0001' }))).toBe(
      'Blocker · confirmation',
    );
    expect(vm.ckOf(proposal('p-5', 'pending', undefined, { summary: 'Set T-0086 priority to urgent' }))).toBe(
      'Priority · confirmation',
    );
    expect(vm.ckOf(proposal('p-6', 'pending', undefined, { summary: 'Promote T-0090 to a ship ticket' }))).toBe(
      'Promote · confirmation',
    );
    expect(vm.ckOf(proposal('p-7', 'pending'))).toBe('Needs confirmation');
  });

  it('labels the done card — the create announces itself as angelegt', () => {
    const { vm } = setup({ sessions: [], active: null });
    expect(vm.ckDoneOf(proposal('p-1', 'confirmed', undefined, { summary: 'Create ticket "CSV" in ideas' }))).toBe(
      'Angelegt',
    );
    expect(vm.ckDoneOf(proposal('p-2', 'confirmed', undefined, { summary: 'Move T-1 from build to verify' }))).toBe(
      'Confirmed',
    );
  });
});

// -- decisions: dismiss dim + toasts, confirm outcome toast -------------------------

describe('Chat card decisions (toasts)', () => {
  interface DecisionFakeState {
    chatPrefill: WritableSignal<string | null>;
    chat: WritableSignal<ChatStateView>;
    board: Signal<unknown>;
    work: Signal<WorkView>;
    toasts: [string, string | undefined][];
    toast(message: string, kind?: string): void;
    openSession(file: string): Promise<void>;
    confirm(file: string, id: string): Promise<unknown>;
    dismiss(file: string, id: string): Promise<unknown>;
    send(text: string): Promise<unknown>;
    newSession(text: string): Promise<unknown>;
  }

  function view(extra: Partial<ChatProposalView> & { id: string }): ChatProposalView {
    return {
      state: 'pending',
      summary: 'Move T-0086 from build to verify',
      at: '2026-11-02T09:00:00Z',
      decidedAt: null,
      outcome: null,
      ...extra,
    } as ChatProposalView;
  }

  function activeOf(file: string, proposals: readonly ChatProposalView[]): ActiveSession {
    return { file, title: file, createdAt: '', messages: [], proposals };
  }

  function fakeState(
    active: ActiveSession | null,
    hooks: { confirm?: (file: string, id: string) => unknown; dismiss?: (file: string, id: string) => unknown } = {},
  ): DecisionFakeState {
    const toasts: [string, string | undefined][] = [];
    const state: DecisionFakeState = {
      toasts,
      chatPrefill: signal(null),
      chat: signal<ChatStateView>({ sessions: [], active }),
      board: signal(null),
      work: signal<WorkView>({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
      toast: (message, kind) => toasts.push([message, kind]),
      openSession: (file) => {
        state.chat.update((chat) => ({ ...chat, active: activeOf(file, []) }));
        return Promise.resolve();
      },
      confirm: (file, id) =>
        Promise.resolve(
          hooks.confirm !== undefined
            ? hooks.confirm(file, id)
            : (() => {
                state.chat.update((chat) => {
                  const open = chat.active;
                  if (open === null) {
                    return chat;
                  }
                  const proposals = open.proposals.map((p) =>
                    p.id === id ? { ...p, state: 'confirmed' as const, decidedAt: '2026-11-02T09:01:00Z' } : p,
                  );
                  return { ...chat, active: { ...open, proposals } };
                });
                return { ok: true };
              })(),
        ),
      dismiss: (file, id) =>
        Promise.resolve(
          hooks.dismiss !== undefined
            ? hooks.dismiss(file, id)
            : (() => {
                state.chat.update((chat) => {
                  const open = chat.active;
                  if (open === null) {
                    return chat;
                  }
                  const proposals = open.proposals.map((p) =>
                    p.id === id ? { ...p, state: 'dismissed' as const, decidedAt: '2026-11-02T09:01:00Z' } : p,
                  );
                  return { ...chat, active: { ...open, proposals } };
                });
                return { ok: true };
              })(),
        ),
      send: () => Promise.resolve({ ok: true }),
      newSession: () => Promise.resolve({ ok: true }),
    };
    return state;
  }

  interface DecisionSurface {
    confirm(id: string): Promise<void>;
    dismiss(id: string): Promise<void>;
    isDimmed(id: string): boolean;
    cardError(id: string): string | null;
    readOnly(): boolean;
    toasts(): readonly [string, string | undefined][];
  }

  function setup(fake: DecisionFakeState, active: ActiveSession): DecisionSurface {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: MC_CHAT_STATE, useValue: fake as unknown as McChatState }],
    });
    fake.chat.set({ sessions: [], active });
    const chat = TestBed.runInInjectionContext(() => new Chat());
    const surface = chat as unknown as DecisionSurface & { toasts: [string, string | undefined][] };
    return {
      confirm: (id) => surface.confirm(id),
      dismiss: (id) => surface.dismiss(id),
      isDimmed: (id) => surface.isDimmed(id),
      cardError: (id) => surface.cardError(id),
      readOnly: () => surface.readOnly(),
      toasts: () => fake.toasts,
    };
  }

  it('dismiss dims the card at once and toasts that nothing changed', async () => {
    const fake = fakeState(null);
    const vm = setup(fake, activeOf('s.md', [view({ id: 'p-1' })]));
    await vm.dismiss('p-1');
    expect(vm.isDimmed('p-1')).toBe(true);
    expect(vm.toasts()).toContainEqual(['Discarded — nothing was changed', 'warn']);
  });

  it('a refused dismiss lifts the dim and stays on the card, without the toast', async () => {
    const fake = fakeState(null, { dismiss: () => ({ ok: false, error: 'already decided' }) });
    const vm = setup(fake, activeOf('s.md', [view({ id: 'p-1' })]));
    await vm.dismiss('p-1');
    expect(vm.isDimmed('p-1')).toBe(false);
    expect(vm.cardError('p-1')).toBe('already decided');
    expect(vm.toasts()).toEqual([]);
  });

  it('confirm toasts the engine’s outcome line with the commit reference', async () => {
    const fake = fakeState(null, {
      confirm: (_file, id) => {
        fake.chat.update((chat) => {
          const open = chat.active;
          if (open === null) {
            return chat;
          }
          const proposals = open.proposals.map((p) =>
            p.id === id
              ? { ...p, state: 'confirmed' as const, outcome: 'tickets/40-verify/T-0086-plan.md' }
              : p,
          );
          return { ...chat, active: { ...open, proposals } };
        });
        return { ok: true };
      },
    });
    const vm = setup(fake, activeOf('s.md', [view({ id: 'p-1' })]));
    await vm.confirm('p-1');
    expect(vm.toasts()).toContainEqual(['Confirmed — tickets/40-verify/T-0086-plan.md (Commit)', 'ok']);
  });

  it('confirm without an outcome toasts plain', async () => {
    const fake = fakeState(null);
    const vm = setup(fake, activeOf('s.md', [view({ id: 'p-1' })]));
    await vm.confirm('p-1');
    expect(vm.toasts()).toContainEqual(['Confirmed', 'ok']);
  });
});

// -- the sessions sheet: live vs read-only -----------------------------------------

describe('Chat sessions sheet (read-only views)', () => {
  interface SheetFakeState {
    chatPrefill: WritableSignal<string | null>;
    chat: WritableSignal<ChatStateView>;
    board: Signal<unknown>;
    work: Signal<WorkView>;
    toasts: [string, string | undefined][];
    toast(message: string, kind?: string): void;
    openSession(file: string): Promise<void>;
    send(text: string): Promise<unknown>;
    newSession(text: string): Promise<unknown>;
  }

  function fakeState(sessions: readonly { file: string; title: string }[]): SheetFakeState {
    const toasts: [string, string | undefined][] = [];
    const metas = sessions.map((s) => ({ ...s, createdAt: '', updatedAt: '', pending: 0 }));
    const state: SheetFakeState = {
      toasts,
      chatPrefill: signal(null),
      chat: signal<ChatStateView>({ sessions: metas, active: null }),
      board: signal(null),
      work: signal<WorkView>({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
      toast: (message, kind) => toasts.push([message, kind]),
      openSession: (file) => {
        const meta = metas.find((m) => m.file === file);
        state.chat.update((chat) => ({
          ...chat,
          active: meta === undefined ? null : { ...meta, messages: [], proposals: [] },
        }));
        return Promise.resolve();
      },
      send: vi.fn(() => Promise.resolve({ ok: true })),
      newSession: vi.fn(() => Promise.resolve({ ok: true })),
    };
    return state;
  }

  interface SheetSurface {
    openFromSheet(entry: { file: string; title: string }): Promise<void>;
    liveEntry(): { file: string; title: string } | null;
    readOnly(): boolean;
    sheetError(): string | null;
    sheetOpen(): boolean;
    toasts(): readonly [string, string | undefined][];
    send(): Promise<void>;
  }

  function setup(fake: SheetFakeState): SheetSurface {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: MC_CHAT_STATE, useValue: fake as unknown as McChatState }],
    });
    const chat = TestBed.runInInjectionContext(() => new Chat()) as unknown as {
      openFromSheet(entry: { file: string; title: string }): Promise<void>;
      liveEntry(): { file: string; title: string } | null;
      readOnly(): boolean;
      sheetError(): string | null;
      sheetOpen(): boolean;
      draft: WritableSignal<string>;
      send(): Promise<void>;
    };
    return {
      openFromSheet: (entry) => chat.openFromSheet(entry),
      liveEntry: () => chat.liveEntry(),
      readOnly: () => chat.readOnly(),
      sheetError: () => chat.sheetError(),
      sheetOpen: () => chat.sheetOpen(),
      toasts: () => fake.toasts,
      send: () => {
        chat.draft.set('hello');
        return chat.send();
      },
    };
  }

  it('the first opened session becomes the live one — continuable, quiet', async () => {
    const fake = fakeState([
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]);
    const vm = setup(fake);
    await vm.openFromSheet({ file: 'a.md', title: 'A' });
    expect(vm.liveEntry()?.file).toBe('a.md');
    expect(vm.readOnly()).toBe(false);
    expect(vm.toasts()).toEqual([]);
  });

  it('a non-live session opens read-only with the warn toast', async () => {
    const fake = fakeState([
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]);
    const vm = setup(fake);
    await vm.openFromSheet({ file: 'a.md', title: 'A' });
    await vm.openFromSheet({ file: 'b.md', title: 'B' });
    expect(vm.readOnly()).toBe(true);
    expect(vm.toasts()).toContainEqual(['Session opened: B — read-only', 'warn']);
  });

  it('the read-only view refuses sends', async () => {
    const fake = fakeState([
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]);
    const vm = setup(fake);
    await vm.openFromSheet({ file: 'a.md', title: 'A' });
    await vm.openFromSheet({ file: 'b.md', title: 'B' });
    await vm.send();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('returning to the live session lifts the lock and announces it', async () => {
    const fake = fakeState([
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]);
    const vm = setup(fake);
    await vm.openFromSheet({ file: 'a.md', title: 'A' });
    await vm.openFromSheet({ file: 'b.md', title: 'B' });
    const live = vm.liveEntry()!;
    await vm.openFromSheet(live);
    expect(vm.readOnly()).toBe(false);
    expect(vm.toasts()).toContainEqual(['Back in the current conversation', 'ok']);
    await vm.send();
    expect(fake.send).toHaveBeenCalledWith('hello');
  });

  it('a failed open keeps the pane and reports inside the sheet', async () => {
    const fake = fakeState([{ file: 'a.md', title: 'A' }]);
    (fake as { openSession(file: string): Promise<void> }).openSession = () => {
      fake.chat.update((chat) => ({ ...chat, active: null }));
      return Promise.resolve();
    };
    const vm = setup(fake);
    await vm.openFromSheet({ file: 'gone.md', title: 'Gone' });
    expect(vm.readOnly()).toBe(false);
    expect(vm.sheetError()).toBe('The session could not be opened: Gone');
    expect(vm.sheetOpen()).toBe(true);
  });
});

// -- the attach sheet: the composer's uploads (concept §6) ---------------------------

describe('basenameOf', () => {
  it('keeps a bare name and strips a stored path', () => {
    expect(basenameOf('img-a.png')).toBe('img-a.png');
    expect(basenameOf('tickets/attachments/img-a.png')).toBe('img-a.png');
  });
});

describe('attachmentToastOf', () => {
  it('names one stored file in the singular', () => {
    expect(attachmentToastOf(['tickets/attachments/img-a.png'])).toEqual({
      message: 'File attached: img-a.png',
      kind: 'warn',
    });
  });

  it('counts several stored files and keeps only their names', () => {
    const note = attachmentToastOf(['tickets/attachments/img-a.png', 'img-b.jpeg']);
    expect(note.message).toBe('2 files attached: img-a.png, img-b.jpeg');
    expect(note.kind).toBe('warn');
  });
});

describe('Chat attach sheet (composer uploads)', () => {
  interface AttachFakeState {
    chatPrefill: WritableSignal<string | null>;
    chat: WritableSignal<ChatStateView>;
    board: Signal<unknown>;
    work: Signal<WorkView>;
    toasts: [string, string | undefined][];
    toast(message: string, kind?: string): void;
    uploadAttachment?(files: File[]): Promise<McChatUploadReply>;
    openSession(file: string): Promise<void>;
    send(text: string): Promise<unknown>;
    newSession(text: string): Promise<unknown>;
  }

  function fakeState(
    upload?: (files: File[]) => Promise<McChatUploadReply>,
    sessions: readonly { file: string; title: string }[] = [],
  ): AttachFakeState {
    const toasts: [string, string | undefined][] = [];
    const metas = sessions.map((s) => ({ ...s, createdAt: '', updatedAt: '', pending: 0 }));
    const state: AttachFakeState = {
      toasts,
      chatPrefill: signal(null),
      chat: signal<ChatStateView>({ sessions: metas, active: null }),
      board: signal(null),
      work: signal<WorkView>({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
      toast: (message, kind) => toasts.push([message, kind]),
      ...(upload === undefined ? {} : { uploadAttachment: (files: File[]) => upload(files) }),
      openSession: (file) => {
        const meta = metas.find((m) => m.file === file);
        state.chat.update((chat) => ({
          ...chat,
          active: meta === undefined ? null : { ...meta, messages: [], proposals: [] },
        }));
        return Promise.resolve();
      },
      send: () => Promise.resolve({ ok: true }),
      newSession: () => Promise.resolve({ ok: true }),
    };
    return state;
  }

  interface AttachSurface {
    attachDisabled(): boolean;
    attachSheetOpen(): boolean;
    uploading(): boolean;
    attachments(): readonly { name: string; url: string | null }[];
    composerError(): string | null;
    openAttachSheet(): void;
    closeAttachSheet(): void;
    openFromSheet(entry: { file: string; title: string }): Promise<void>;
    uploadPicked(files: File[]): Promise<void>;
    send(): Promise<void>;
  }

  function setup(fake: AttachFakeState): { vm: AttachSurface; fake: AttachFakeState } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: MC_CHAT_STATE, useValue: fake as unknown as McChatState }],
    });
    const chat = TestBed.runInInjectionContext(() => new Chat()) as unknown as AttachSurface & {
      draft: WritableSignal<string>;
    };
    const vm: AttachSurface = {
      attachDisabled: () => chat.attachDisabled(),
      attachSheetOpen: () => chat.attachSheetOpen(),
      uploading: () => chat.uploading(),
      attachments: () => chat.attachments(),
      composerError: () => chat.composerError(),
      openAttachSheet: () => chat.openAttachSheet(),
      closeAttachSheet: () => chat.closeAttachSheet(),
      openFromSheet: (entry) => chat.openFromSheet(entry),
      uploadPicked: (files) => chat.uploadPicked(files),
      send: () => {
        chat.draft.set('hallo');
        return chat.send();
      },
    };
    return { vm, fake };
  }

  const png = (): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });

  it('keeps the attach button disabled while the state wires no uploadAttachment', () => {
    const { vm } = setup(fakeState());
    expect(vm.attachDisabled()).toBe(true);
  });

  it('enables the attach button once the state uploads', () => {
    const { vm } = setup(fakeState(async () => ({ ok: true, stored: [] })));
    expect(vm.attachDisabled()).toBe(false);
  });

  it('disables the attach button again in a read-only session', async () => {
    const { vm } = setup(
      fakeState(async () => ({ ok: true, stored: [] }), [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ]),
    );
    await vm.openFromSheet({ file: 'a.md', title: 'A' });
    await vm.openFromSheet({ file: 'b.md', title: 'B' });
    expect(vm.attachDisabled()).toBe(true);
  });

  it('opens and closes the sheet', () => {
    const { vm } = setup(fakeState(async () => ({ ok: true, stored: [] })));
    expect(vm.attachSheetOpen()).toBe(false);
    vm.openAttachSheet();
    expect(vm.attachSheetOpen()).toBe(true);
    vm.closeAttachSheet();
    expect(vm.attachSheetOpen()).toBe(false);
  });

  it('uploads the picked files, lays their chips and toasts the stored names', async () => {
    const uploads: string[][] = [];
    const { vm, fake } = setup(
      fakeState(async (files) => {
        uploads.push(files.map((file) => file.name));
        return { ok: true, stored: ['tickets/attachments/img-x.png'] };
      }),
    );
    vm.openAttachSheet();
    await vm.uploadPicked([png(), new File([new Uint8Array([1])], 'notiz.md', { type: 'text/markdown' })]);
    expect(uploads).toEqual([['shot.png', 'notiz.md']]);
    expect(vm.attachSheetOpen()).toBe(false);
    expect(vm.uploading()).toBe(false);
    // The thumbnail rides the platform's object URLs — where there are none the chip keeps the name alone.
    expect(vm.attachments().map((chip) => chip.name)).toEqual(['shot.png', 'notiz.md']);
    expect(vm.attachments().every((chip) => chip.url === null || chip.url.startsWith('blob:'))).toBe(true);
    expect(fake.toasts).toEqual([['File attached: img-x.png', 'warn']]);
  });

  it('surfaces a refusal inline at the composer and as an error toast, no chips', async () => {
    const { vm, fake } = setup(
      fakeState(async () => ({ ok: false, error: 'the file is not a PNG, JPEG, GIF or WebP image' })),
    );
    vm.openAttachSheet();
    await vm.uploadPicked([new File([new Uint8Array([1, 2, 3])], 'brief.pdf', { type: 'application/pdf' })]);
    expect(vm.composerError()).toBe('the file is not a PNG, JPEG, GIF or WebP image');
    expect(fake.toasts).toEqual([['the file is not a PNG, JPEG, GIF or WebP image', 'error']]);
    expect(vm.attachments()).toEqual([]);
    expect(vm.attachSheetOpen()).toBe(false);
  });

  it('surfaces a thrown upload like a refusal', async () => {
    const { vm, fake } = setup(
      fakeState(async () => {
        throw new Error('the desk does not answer');
      }),
    );
    await vm.uploadPicked([png()]);
    expect(vm.composerError()).toBe('the desk does not answer');
    expect(fake.toasts).toEqual([['the desk does not answer', 'error']]);
    expect(vm.uploading()).toBe(false);
  });

  it('ignores an empty pick', async () => {
    let calls = 0;
    const { vm, fake } = setup(
      fakeState(async () => {
        calls++;
        return { ok: true, stored: ['tickets/attachments/img-x.png'] };
      }),
    );
    vm.openAttachSheet();
    await vm.uploadPicked([]);
    expect(calls).toBe(0);
    expect(vm.attachSheetOpen()).toBe(true);
    expect(fake.toasts).toEqual([]);
  });

  it('ignores a second pick while one upload runs', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { vm } = setup(
      fakeState(async () => {
        calls++;
        await gate;
        return { ok: true, stored: ['tickets/attachments/img-x.png'] };
      }),
    );
    const first = vm.uploadPicked([png()]);
    await vm.uploadPicked([png()]);
    release!();
    await first;
    expect(calls).toBe(1);
    expect(vm.attachments().length).toBe(1);
    expect(vm.uploading()).toBe(false);
  });

  it('clears the chips once the message is sent', async () => {
    const { vm } = setup(fakeState(async () => ({ ok: true, stored: ['tickets/attachments/img-x.png'] })));
    await vm.uploadPicked([png()]);
    expect(vm.attachments().length).toBe(1);
    await vm.send();
    expect(vm.attachments()).toEqual([]);
  });
});

// -- the fixed column: header / messages / composer (owner ruling 2026-11-03) -----

/**
 * A fake state rich enough to render the session template: the chat view
 * signal, the prefill and the two lazy computed sources (board, work).
 * Everything else the template touches degrades to optional/undefined.
 */
function renderChat(active: ActiveSession | null, prefill: string | null = null): {
  fixture: ReturnType<typeof TestBed.createComponent<Chat>>;
  chat: WritableSignal<ChatStateView>;
  el: HTMLElement;
} {
  const chat = signal<ChatStateView>({ sessions: [], active });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MC_CHAT_STATE,
        useValue: {
          chat,
          chatPrefill: signal(prefill),
          board: signal(null),
          work: signal({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
          toast: () => undefined,
        } as unknown as McChatState,
      },
    ],
  });
  const fixture = TestBed.createComponent(Chat);
  fixture.detectChanges();
  return { fixture, chat, el: fixture.nativeElement as HTMLElement };
}

function activeSession(): ActiveSession {
  return {
    file: 'chat-a.md',
    title: 'A',
    createdAt: '',
    messages: [msg('owner', 'one', '2026-11-02T09:00:00Z'), msg('mission', 'two', '2026-11-02T09:01:00Z')],
    proposals: [],
  };
}

/** jsdom has no layout — the thread element gets explicit scroll geometry. */
function withScrollGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): HTMLElement {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  return el;
}

describe('Chat column structure (header / messages / composer)', () => {
  it('renders the fixed column: header first, the scrolling thread in the middle, the composer last', () => {
    const { el } = renderChat(activeSession());
    const column = el.querySelector('.chat');
    expect(column).not.toBeNull();
    const faces = Array.from(column!.children).map((child) => child.classList[0]);
    expect(faces).toEqual(['hdr', 'thread', 'composer']);
  });

  it('carries the title and the two icon buttons in the header — and no sub line', () => {
    const { el } = renderChat(activeSession());
    const hdr = el.querySelector('.chat > .hdr')!;
    expect(hdr.querySelector('.ttl')!.textContent).toContain('Mission Control');
    expect(hdr.querySelectorAll('button.hbtn').length).toBe(2);
    expect(hdr.querySelector('.sub')).toBeNull();
    expect(el.querySelector('.sub')).toBeNull();
  });

  it('keeps the empty-state body to the functional menu pointer only', () => {
    const { el } = renderChat(null, 'promote T-0004');
    const empties = Array.from(el.querySelectorAll('.body .empty')).map((p) => p.textContent ?? '');
    expect(empties).toEqual(['Earlier chats are in the menu (top left).']);
  });
});

describe('Chat error card (D-1: the model could not answer)', () => {
  function renderWithFailure(failure: ChatFailureView | null, active: ActiveSession = activeSession()) {
    const chatFailure = signal<ChatFailureView | null>(failure);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MC_CHAT_STATE,
          useValue: {
            chat: signal<ChatStateView>({ sessions: [], active }),
            chatPrefill: signal(null),
            chatFailure,
            board: signal(null),
            work: signal({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
            toast: () => undefined,
          } as unknown as McChatState,
        },
      ],
    });
    const fixture = TestBed.createComponent(Chat);
    fixture.detectChanges();
    return { fixture, chatFailure, el: fixture.nativeElement as HTMLElement };
  }

  const unreachable: ChatFailureView = {
    code: 'unreachable',
    providerLabel: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    model: 'glm-5.3-flash',
    reason: 'could not be reached — connection refused — nothing is listening there.',
  };

  it('shows provider, endpoint, model and reason under the thread', () => {
    const { el } = renderWithFailure(unreachable);
    const card = el.querySelector('.errcard');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('role')).toBe('alert');
    expect(card!.querySelector('.ck')!.textContent).toBe('Pia cannot reach the model');
    const text = card!.textContent ?? '';
    expect(text).toContain('LM Studio');
    expect(text).toContain('http://localhost:1234/v1');
    expect(text).toContain('glm-5.3-flash');
    expect(text).toContain('nothing is listening there');
  });

  it('speaks as Paul in a shape session', () => {
    const { el } = renderWithFailure(
      { ...unreachable, code: 'unsupported', providerLabel: 'GitHub Copilot CLI', baseUrl: null },
      { ...activeSession(), ticket: 'T-0130' },
    );
    expect(el.querySelector('.errcard .ck')!.textContent).toBe('Paul cannot use this provider');
    expect(el.querySelector('.errcard')!.textContent).not.toContain('Endpoint');
  });

  it('belongs to its session only, and Dismiss clears it', () => {
    const other = renderWithFailure({ ...unreachable, file: 'chat-b.md' });
    expect(other.el.querySelector('.errcard')).toBeNull();

    const own = renderWithFailure({ ...unreachable, file: 'chat-a.md' });
    expect(own.el.querySelector('.errcard')).not.toBeNull();
    (own.el.querySelector('.errcard button') as HTMLButtonElement).click();
    own.fixture.detectChanges();
    expect(own.chatFailure()).toBeNull();
    expect(own.el.querySelector('.errcard')).toBeNull();
  });

  it('shows no card when nothing failed', () => {
    expect(renderWithFailure(null).el.querySelector('.errcard')).toBeNull();
  });
});

describe('Chat thread auto-scroll (follow gate)', () => {
  const geometry = { scrollHeight: 937, clientHeight: 700 };

  function setup(): {
    fixture: ReturnType<typeof TestBed.createComponent<Chat>>;
    chat: WritableSignal<ChatStateView>;
    thread: HTMLElement;
  } {
    const { fixture, chat, el } = renderChat(activeSession());
    const thread = withScrollGeometry(
      el.querySelector('.chat > .thread')!,
      geometry.scrollHeight,
      geometry.clientHeight,
    );
    // Re-announce the session as a fresh object — what the app does when
    // the desk's session lands or a delta grows the timeline — and flush
    // the pin effect against it.
    const active = chat().active;
    chat.set({ sessions: [], active: active === null ? null : { ...active } });
    fixture.detectChanges();
    return { fixture, chat, thread };
  }

  function scroll(thread: HTMLElement, top: number): void {
    thread.scrollTop = top;
    thread.dispatchEvent(new Event('scroll'));
  }

  it('pins to the newest line when the session lands', () => {
    const { thread } = setup();
    expect(thread.scrollTop).toBe(geometry.scrollHeight);
  });

  it('keeps following while the user sits at the bottom', () => {
    const { fixture, chat, thread } = setup();
    scroll(thread, geometry.scrollHeight - geometry.clientHeight);
    const session = chat().active!;
    chat.set({
      sessions: [],
      active: { ...session, messages: [...session.messages, msg('mission', 'three', '2026-11-02T09:02:00Z')] },
    });
    fixture.detectChanges();
    expect(thread.scrollTop).toBe(geometry.scrollHeight);
  });

  it('stops the yank once the user scrolled away to read history', () => {
    const { fixture, chat, thread } = setup();
    scroll(thread, 50);
    const session = chat().active!;
    chat.set({
      sessions: [],
      active: { ...session, messages: [...session.messages, msg('mission', 'three', '2026-11-02T09:02:00Z')] },
    });
    fixture.detectChanges();
    expect(thread.scrollTop).toBe(50);
  });

  it('re-arms when the user scrolls back to the bottom', () => {
    const { fixture, chat, thread } = setup();
    scroll(thread, 50);
    scroll(thread, geometry.scrollHeight - geometry.clientHeight);
    const session = chat().active!;
    chat.set({
      sessions: [],
      active: { ...session, messages: [...session.messages, msg('mission', 'three', '2026-11-02T09:02:00Z')] },
    });
    fixture.detectChanges();
    expect(thread.scrollTop).toBe(geometry.scrollHeight);
  });

  it('always shows the latest line of a newly opened session', () => {
    const { fixture, chat, thread } = setup();
    scroll(thread, 50);
    expect(thread.scrollTop).toBe(50);
    chat.set({
      sessions: [],
      active: { ...activeSession(), file: 'chat-b.md', title: 'B' },
    });
    fixture.detectChanges();
    expect(thread.scrollTop).toBe(geometry.scrollHeight);
  });
});

// -- the history list (E12-2) -------------------------------------------------------

describe('historyGroupsOf', () => {
  const meta = (file: string, title: string, updatedAt: string) => ({
    file,
    title,
    createdAt: updatedAt,
    updatedAt,
    pending: 0,
  });
  const now = new Date(2026, 10, 3, 15, 0).getTime();
  const at = (daysAgo: number, hour: number): string => new Date(2026, 10, 3 - daysAgo, hour, 0).toISOString();

  it('groups by calendar day, newest first, empty groups left out', () => {
    const groups = historyGroupsOf(
      [
        meta('old.md', 'Cost export', at(6, 9)),
        meta('a.md', 'Morning', at(0, 8)),
        meta('y.md', 'Yesterday chat', at(1, 20)),
        meta('b.md', 'Noon', at(0, 12)),
      ],
      now,
      '',
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Earlier']);
    expect(groups[0]!.entries.map((e) => e.file)).toEqual(['b.md', 'a.md']);
    const onlyOld = historyGroupsOf([meta('old.md', 'Cost export', at(6, 9))], now, '');
    expect(onlyOld.map((g) => g.label)).toEqual(['Earlier']);
  });

  it('filters by title, case-insensitively', () => {
    const groups = historyGroupsOf(
      [meta('a.md', 'What did the week cost?', at(0, 8)), meta('b.md', 'Away until 18:00', at(0, 9))],
      now,
      ' COST ',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.file)).toEqual(['a.md']);
  });

  it('puts an unreadable timestamp under Earlier', () => {
    expect(historyGroupsOf([meta('x.md', 'X', 'not a date')], now, '')[0]!.label).toBe('Earlier');
  });
});

describe('Chat menu request (E12-2)', () => {
  function chatWith(menu: WritableSignal<boolean> | undefined): { sheetOpen(): boolean } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MC_CHAT_STATE,
          useValue: {
            chatPrefill: signal(null),
            ...(menu === undefined ? {} : { chatMenu: menu }),
            chat: signal<ChatStateView>({ sessions: [], active: null }),
            board: signal(null),
            work: signal<WorkView>({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
            toast: () => undefined,
          } as unknown as McChatState,
        },
      ],
    });
    return TestBed.runInInjectionContext(() => new Chat()) as unknown as { sheetOpen(): boolean };
  }

  it('opens the history on mount and consumes the one-shot', () => {
    const menu = signal(true);
    expect(chatWith(menu).sheetOpen()).toBe(true);
    expect(menu()).toBe(false);
  });

  it('stays closed without the request, and without the signal', () => {
    expect(chatWith(signal(false)).sheetOpen()).toBe(false);
    expect(chatWith(undefined).sheetOpen()).toBe(false);
  });
});

// -- dictation in the composer (E12-8, milestone 149) -----------------------------

describe('Chat dictation (the microphone in the composer)', () => {
  interface FakeEngine {
    lang: string;
    onstart: (() => void) | null;
    onresult: ((event: { results: unknown }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
  }
  const engines: FakeEngine[] = [];

  class Engine implements FakeEngine {
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onstart: (() => void) | null = null;
    onresult: ((event: { results: unknown }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      engines.push(this);
    }
    start(): void {}
    stop(): void {}
    abort(): void {}
  }

  const win = window as unknown as Record<string, unknown>;

  function install(secure = true): void {
    win['webkitSpeechRecognition'] = Engine;
    Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  }

  afterEach(() => {
    engines.length = 0;
    delete win['webkitSpeechRecognition'];
    delete win['SpeechRecognition'];
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
  });

  const said = (...parts: [string, boolean][]): { results: unknown } => ({
    results: Object.assign(
      parts.map(([transcript, isFinal]) => ({ isFinal, length: 1, 0: { transcript } })),
      {},
    ),
  });

  it('is hidden where the browser has no speech engine', () => {
    const { el } = renderChat(activeSession());
    expect(el.querySelector('.composer .mic')).toBeNull();
  });

  it('is hidden on a page that is not a secure context (plain http)', () => {
    install(false);
    const { el } = renderChat(activeSession());
    expect(el.querySelector('.composer .mic')).toBeNull();
  });

  it('shows a 44 pt "Dictate" button, not pressed, between the field and Send', () => {
    install();
    const { el } = renderChat(activeSession());
    const mic = el.querySelector<HTMLButtonElement>('.composer .mic')!;
    expect(mic.getAttribute('aria-label')).toBe('Dictate');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    const row = Array.from(el.querySelector('.composer-row')!.children).map((c) => c.className.split(' ')[0]);
    expect(row).toEqual(['attach', 'composer-input', 'mic', 'send']);
  });

  it('records on tap: pressed, the recording line, speech fills the field live and nothing is sent', async () => {
    install();
    const { fixture, el } = renderChat(activeSession());
    const send = vi.fn();
    (fixture.componentInstance as unknown as { state: { send: unknown } }).state.send = send;
    el.querySelector<HTMLButtonElement>('.composer .mic')!.click();
    fixture.detectChanges();
    const engine = engines[0]!;
    expect(engine.lang).toBeTruthy();
    engine.onstart?.();
    fixture.detectChanges();
    const mic = el.querySelector<HTMLButtonElement>('.composer .mic')!;
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('.recording')?.textContent).toContain('Recording');
    expect(el.querySelector('.rec-clock')?.textContent?.trim()).toBe('0:00');
    engine.onresult?.(said(['move T-0084', false]));
    fixture.detectChanges();
    const field = el.querySelector<HTMLTextAreaElement>('.composer-input')!;
    expect(field.value).toBe('move T-0084');
    engine.onresult?.(said(['move T-0084 back to Ralf', true]));
    fixture.detectChanges();
    expect(field.value).toBe('move T-0084 back to Ralf');
    expect(send).not.toHaveBeenCalled();
  });

  it('typing ends the dictation and keeps the text; a late result no longer lands', () => {
    install();
    const { fixture, el } = renderChat(activeSession());
    el.querySelector<HTMLButtonElement>('.composer .mic')!.click();
    const engine = engines[0]!;
    engine.onstart?.();
    engine.onresult?.(said(['hello', true]));
    fixture.detectChanges();
    const field = el.querySelector<HTMLTextAreaElement>('.composer-input')!;
    field.value = 'hello there';
    field.dispatchEvent(new Event('input'));
    engine.onresult?.(said(['hello', true], ['again', true]));
    fixture.detectChanges();
    expect(field.value).toBe('hello there');
    expect(el.querySelector('.recording')).toBeNull();
  });

  it('shows the refusal inline when the microphone is blocked', () => {
    install();
    const { fixture, el } = renderChat(activeSession());
    el.querySelector<HTMLButtonElement>('.composer .mic')!.click();
    const engine = engines[0]!;
    engine.onerror?.({ error: 'not-allowed' });
    engine.onend?.();
    fixture.detectChanges();
    expect(el.querySelector('.composer .inline-error')?.textContent).toMatch(/Microphone access is blocked/);
    expect(el.querySelector('.recording')).toBeNull();
  });

  it('a send cancels the dictation', () => {
    install();
    const { fixture, el } = renderChat(activeSession());
    el.querySelector<HTMLButtonElement>('.composer .mic')!.click();
    const engine = engines[0]!;
    const abort = vi.spyOn(engine, 'abort');
    engine.onstart?.();
    engine.onresult?.(said(['go', true]));
    fixture.detectChanges();
    void (fixture.componentInstance as unknown as { send(): Promise<void> }).send();
    expect(abort).toHaveBeenCalled();
  });
});
