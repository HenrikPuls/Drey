import { describe, expect, it } from 'vitest';
import { parseEnvelope, validateChatCommand } from './chat-intents';

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
});
