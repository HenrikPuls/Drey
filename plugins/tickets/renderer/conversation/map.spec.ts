import { describe, expect, it } from 'vitest';
import type { ChatSession } from '../../../../packages/tickets-engine/src/contracts/chat';
import { errorMessageOf, threadOfPersona, threadOfSession, VIA_MISSION_CONTROL } from './map';

const base: ChatSession = {
  file: 'tickets/_meta/chat/20261104-100000-demo.md',
  title: 'Demo',
  createdAt: '2026-11-04T10:00:00Z',
  messages: [
    { role: 'owner', text: 'Create a ticket', at: '2026-11-04T10:00:01Z', thought: null },
    { role: 'mission', text: 'Proposed.', at: '2026-11-04T10:00:05Z', thought: 'thinking' },
  ],
  proposals: [
    {
      id: 'p-1',
      state: 'pending',
      summary: 'Create ticket "Fix the login"',
      command: { kind: 'createTicket', title: 'Fix the login', description: '', priority: 'normal', phase: 'inbox' },
      at: '2026-11-04T10:00:06Z',
      decidedAt: null,
      outcome: null,
    },
  ],
};

describe('threadOfSession', () => {
  it('maps roles and puts a pending proposal on the mission message it followed, with Confirm and Dismiss', () => {
    const thread = threadOfSession(base);
    expect(thread.id).toBe(base.file);
    expect(thread.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    const card = thread.messages[1]?.cards?.[0];
    expect(card).toMatchObject({ id: 'p-1', kind: 'card', text: 'Create ticket "Fix the login"' });
    expect(card?.actions?.map((a) => a.id)).toEqual(['confirm', 'dismiss']);
    expect(thread.messages[1]?.thought).toBe('thinking');
    expect(thread.messages[1]?.via).toBeUndefined();
  });

  it('shows a decided proposal as a note without buttons', () => {
    const decided = {
      ...base,
      proposals: [{ ...base.proposals[0]!, state: 'confirmed' as const, decidedAt: 'x', outcome: 'T-0140' }],
    };
    const card = threadOfSession(decided).messages[1]?.cards?.[0];
    expect(card?.actions).toEqual([]);
    expect(card?.note).toBe('Done — T-0140');
  });

  it('makes Paul the author of relays in a shape session, via Mission Control', () => {
    const thread = threadOfSession({ ...base, ticket: 'T-0130' });
    expect(thread.messages[1]).toMatchObject({ author: 'Paul', via: VIA_MISSION_CONTROL });
  });

  it('offers the last question as an answer card and an undecided split as a card', () => {
    const asked = threadOfSession({
      ...base,
      proposals: [],
      messages: [
        ...base.messages,
        {
          role: 'mission',
          text: 'How many parts?',
          at: '2026-11-04T10:01:00Z',
          thought: null,
          kind: 'question',
          options: [{ label: '3 parts', recommended: true }, { label: '2 parts', recommended: false }],
        },
      ],
    });
    const question = asked.messages[2];
    expect(question?.author).toBe('Paul');
    expect(question?.cards?.[0]).toMatchObject({ kind: 'choices' });
    expect(question?.cards?.[0]?.choices?.map((c) => c.label)).toEqual(['3 parts', '2 parts']);

    const split = threadOfSession({
      ...base,
      proposals: [],
      messages: [{ role: 'mission', text: 'Split?', at: 'a', thought: null, kind: 'split', parts: 3, decision: null }],
    });
    expect(split.messages[0]?.cards?.[0]?.actions?.map((a) => a.id)).toEqual(['split', 'keep']);
  });

  it('does not offer an answered question again', () => {
    const answered = threadOfSession({
      ...base,
      proposals: [],
      messages: [
        { role: 'mission', text: 'Which?', at: 'a', thought: null, kind: 'question', options: [{ label: 'A', recommended: false }] },
        { role: 'owner', text: 'A', at: 'b', thought: null },
      ],
    });
    expect(answered.messages[0]?.cards).toBeUndefined();
  });
});

describe('errorMessageOf', () => {
  it('uses the D-1 failure lines when there is one, else the bare error', () => {
    const failed = errorMessageOf(
      {
        code: 'unsupported',
        provider: 'claude-code',
        providerLabel: 'Claude Code',
        baseUrl: null,
        model: null,
        reason: 'the CLI providers cannot drive the chat',
        message: 'x',
      },
      undefined,
    );
    expect(failed.error?.title).toBe('Claude Code could not answer');
    expect(failed.error?.lines).toEqual(['the CLI providers cannot drive the chat']);
    expect(errorMessageOf(undefined, 'boom').error?.lines).toEqual(['boom']);
  });
});

describe('threadOfPersona', () => {
  it('maps the owner messages and names who reads the thread', () => {
    const thread = threadOfPersona('ben', 'Ben', { ok: true, messages: [{ at: 'a', role: 'owner', text: 'Prefer small commits' }] });
    expect(thread.messages).toEqual([{ id: 't-0', role: 'user', text: 'Prefer small commits' }]);
    expect(thread.notice).toBe('Ben reads this thread before the next run.');
  });

  it('turns a failed read into an error message', () => {
    const thread = threadOfPersona('ben', 'Ben', { ok: false, error: 'no such persona' });
    expect(thread.messages[0]?.error?.lines).toEqual(['no such persona']);
  });
});
