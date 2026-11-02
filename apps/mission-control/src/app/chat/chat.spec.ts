import { describe, expect, it } from 'vitest';
import { type Signal, type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActiveSession, ChatMessageView, ChatStateView, McChainEntry, WorkView } from '../api/dto';
import { DEFAULT_PRIORITY_CONFIG } from '../api/dto';
import type { McState } from '../api/state';
import {
  Chat,
  MC_CHAT_STATE,
  TimelineProposal,
  TimelineSession,
  chainCompareOf,
  composerRowsOf,
  errorOf,
  isTurnStreaming,
  relativeAge,
  timelineOf,
} from './chat';

// -- fixtures ---------------------------------------------------------------

function msg(role: 'owner' | 'mission', text: string, at: string, thought: string | null = null): ChatMessageView {
  return { role, text, at, thought };
}

function proposal(
  id: string,
  state: 'pending' | 'confirmed' | 'dismissed',
  at?: string,
  options: { decidedAt?: string | null; outcome?: string | null } = {},
): TimelineProposal {
  const item: TimelineProposal = { id, state, summary: `summary ${id}`, outcome: options.outcome ?? null };
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
    viewMode(): 'list' | 'composer' | 'session';
  }

  function setup(fake: FakeChatState): { vm: ChatSurface; fake: FakeChatState } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: MC_CHAT_STATE, useValue: fake as unknown as McState }],
    });
    const chat = TestBed.runInInjectionContext(() => new Chat());
    return { vm: chat as unknown as ChatSurface, fake };
  }

  it('opens on the session list when nothing waits', () => {
    const { vm, fake } = setup(fakeState(null));
    expect(vm.draft()).toBe('');
    expect(vm.viewMode()).toBe('list');
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
      providers: [{ provide: MC_CHAT_STATE, useValue: fake as unknown as McState }],
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
    // command (the block/unblock proposal) carries no gate delta, so the
    // generic rendering shows the summary line alone.
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
