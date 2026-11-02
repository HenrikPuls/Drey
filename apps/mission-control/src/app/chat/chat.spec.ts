import { describe, expect, it } from 'vitest';
import type { ChatMessageView } from '../api/dto';
import {
  TimelineProposal,
  TimelineSession,
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
