import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIORITY_CONFIG, type PriorityConfig } from '../contracts/tickets';
import { parseEnvelope, validateChatCommand } from './chat-intents';

/** A three-word custom vocabulary (`p0` jumps, `p1` is the default, `p2` waits). */
const CUSTOM: PriorityConfig = { order: ['p0', 'p1', 'p2'], default: 'p1' };

describe('parseEnvelope', () => {
  it('reads the strict envelope the bridge prompts for', () => {
    const reply =
      'Here you go:\n{"say":"Done — the card is ready.","thought":"The owner wants T-0086 moved; build is its current phase.","commands":[{"kind":"transition","id":"T-0086","from":"build","to":"review"}]}\n';
    expect(parseEnvelope(reply)).toEqual({
      say: 'Done — the card is ready.',
      thought: 'The owner wants T-0086 moved; build is its current phase.',
      commands: [{ kind: 'transition', id: 'T-0086', from: 'build', to: 'review' }],
    });
  });

  it('accepts an envelope without commands or thought', () => {
    expect(parseEnvelope('{"say":"The team runs three tickets right now."}')).toEqual({
      say: 'The team runs three tickets right now.',
      thought: null,
      commands: [],
    });
  });

  it('returns null when no JSON object is there', () => {
    expect(parseEnvelope('plain prose, no envelope')).toBeNull();
    expect(parseEnvelope('{"say": broken')).toBeNull();
    expect(parseEnvelope('[1,2,3]')).toBeNull();
  });

  it('drops invalid commands instead of guessing', () => {
    const reply = {
      say: 'partial',
      commands: [
        { kind: 'transition', id: 'T-0086', from: 'build', to: 'review' },
        { kind: 'transition', id: 'nope', from: 'build', to: 'review' },
        { kind: 'deleteEverything' },
        'garbage',
      ],
    };
    const parsed = parseEnvelope(JSON.stringify(reply));
    expect(parsed).not.toBeNull();
    expect(parsed!.commands).toEqual([{ kind: 'transition', id: 'T-0086', from: 'build', to: 'review' }]);
  });
});

describe('validateChatCommand', () => {
  it('validates createTicket with a sane default for the description', () => {
    expect(
      validateChatCommand({ kind: 'createTicket', title: 'Tidy worktrees', phase: 'ideas', priority: 'normal' }),
    ).toEqual({ kind: 'createTicket', title: 'Tidy worktrees', description: '', priority: 'normal', phase: 'ideas' });
  });

  it('refuses shapes outside the union', () => {
    expect(validateChatCommand({ kind: 'archive', id: 'T-0086' })).toBeNull();
    expect(validateChatCommand({ kind: 'setPriority', id: 'T-0086', priority: 'yesterday' })).toBeNull();
    expect(validateChatCommand({ kind: 'transition', id: 'T-1', from: 'build', to: 'review' })).toBeNull();
    expect(validateChatCommand(null)).toBeNull();
    expect(validateChatCommand('transition')).toBeNull();
  });

  it('validates promote with a schema ticket id', () => {
    expect(validateChatCommand({ kind: 'promote', id: 'T-0086' })).toEqual({ kind: 'promote', id: 'T-0086' });
    expect(validateChatCommand({ kind: 'promote', id: 'T-1' })).toBeNull();
    expect(validateChatCommand({ kind: 'promote' })).toBeNull();
  });

  it('validates setChain with a string list', () => {
    expect(validateChatCommand({ kind: 'setChain', id: 'T-0086', chain: ['insert design after review'] })).toEqual({
      kind: 'setChain',
      id: 'T-0086',
      chain: ['insert design after review'],
    });
    expect(validateChatCommand({ kind: 'setChain', id: 'T-0086', chain: [] })).toEqual({
      kind: 'setChain',
      id: 'T-0086',
      chain: [],
    });
    expect(validateChatCommand({ kind: 'setChain', id: 'T-0086', chain: ['ok', 4] })).toBeNull();
    expect(validateChatCommand({ kind: 'setChain', id: 'T-0086' })).toBeNull();
    expect(validateChatCommand({ kind: 'setChain', id: 'T-1', chain: [] })).toBeNull();
  });

  it('validates setBlockedBy with a ticket-id list — an empty list clears', () => {
    expect(validateChatCommand({ kind: 'setBlockedBy', id: 'T-0002', blockedBy: ['T-0001', 'T-0003'] })).toEqual({
      kind: 'setBlockedBy',
      id: 'T-0002',
      blockedBy: ['T-0001', 'T-0003'],
    });
    expect(validateChatCommand({ kind: 'setBlockedBy', id: 'T-0002', blockedBy: [] })).toEqual({
      kind: 'setBlockedBy',
      id: 'T-0002',
      blockedBy: [],
    });
    expect(validateChatCommand({ kind: 'setBlockedBy', id: 'T-0002' })).toBeNull();
    expect(validateChatCommand({ kind: 'setBlockedBy', id: 'T-0002', blockedBy: 'T-0001' })).toBeNull();
    expect(validateChatCommand({ kind: 'setBlockedBy', id: 'T-0002', blockedBy: ['T-1'] })).toBeNull();
    expect(validateChatCommand({ kind: 'setBlockedBy', id: 'T-0002', blockedBy: ['T-0001', 4] })).toBeNull();
    expect(validateChatCommand({ kind: 'setBlockedBy', id: 'T-1', blockedBy: [] })).toBeNull();
  });

  it('validates priorities against the vocabulary handed in, not a hard-coded list', () => {
    // The custom vocabulary accepts its own words and refuses the defaults.
    expect(validateChatCommand({ kind: 'setPriority', id: 'T-0002', priority: 'p0' }, CUSTOM)).toEqual({
      kind: 'setPriority',
      id: 'T-0002',
      priority: 'p0',
    });
    expect(validateChatCommand({ kind: 'setPriority', id: 'T-0002', priority: 'urgent' }, CUSTOM)).toBeNull();
    expect(
      validateChatCommand({ kind: 'createTicket', title: 'X', phase: 'inbox', priority: 'p2' }, CUSTOM),
    ).toEqual({ kind: 'createTicket', title: 'X', description: '', priority: 'p2', phase: 'inbox' });
    // The default vocabulary stays the default parameter.
    expect(validateChatCommand({ kind: 'setPriority', id: 'T-0002', priority: 'urgent' })).toEqual({
      kind: 'setPriority',
      id: 'T-0002',
      priority: 'urgent',
    });
    expect(DEFAULT_PRIORITY_CONFIG.order).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('parseEnvelope threads the vocabulary into the commands it keeps', () => {
    const reply =
      '{"say":"Blocked.","commands":[{"kind":"setBlockedBy","id":"T-0002","blockedBy":["T-0001"]},{"kind":"setPriority","id":"T-0002","priority":"p0"},{"kind":"setPriority","id":"T-0002","priority":"low"}]}';
    expect(parseEnvelope(reply, CUSTOM)).toEqual({
      say: 'Blocked.',
      thought: null,
      commands: [
        { kind: 'setBlockedBy', id: 'T-0002', blockedBy: ['T-0001'] },
        { kind: 'setPriority', id: 'T-0002', priority: 'p0' },
      ],
    });
  });
});
