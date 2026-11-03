import { describe, expect, it } from 'vitest';
import { appendThreadOwner, newThreadText, parseThread, threadPathFor } from './persona-thread';

/**
 * The persona thread (U4, concept §4.5): the coaching protocol under
 * `tickets/_meta/personas/<id>/thread.md`, shaped like a chat session.
 * Writes are strict — one line per message; the reader forgives: a broken
 * line is skipped, never a guess (ADR-0076's asymmetric tolerance).
 */

const AT = new Date('2026-11-03T09:01:00.000Z');

describe('threadPathFor', () => {
  it('addresses the persona thread under the personas dir', () => {
    expect(threadPathFor('pia')).toBe('tickets/_meta/personas/pia/thread.md');
  });
});

describe('newThreadText', () => {
  it('opens a chat-session-shaped file with the persona as the title', () => {
    expect(newThreadText('Pia', AT)).toBe(`---\ntitle: "Pia"\ncreated: '2026-11-03T09:01:00.000Z'\n---\n\n`);
  });

  it('falls back to "Coaching" when the persona has no title', () => {
    expect(newThreadText('  ', AT)).toContain('title: "Coaching"');
  });
});

describe('appendThreadOwner', () => {
  it('appends one owner line in the chat-session shape', () => {
    const text = newThreadText('Pia', AT);
    expect(appendThreadOwner(text, AT, "Treat rank fields as the owner's word")).toBe(
      `---\ntitle: "Pia"\ncreated: '2026-11-03T09:01:00.000Z'\n---\n\n` +
        `- '2026-11-03T09:01:00.000Z' owner — Treat rank fields as the owner's word\n`,
    );
  });

  it('appends to a headerless hand-written file without adding one', () => {
    expect(appendThreadOwner('- earlier note\n', AT, 'later')).toBe(`- earlier note\n- '2026-11-03T09:01:00.000Z' owner — later\n`);
  });

  it('flattens a multi-line message to one line — the format is one line per message', () => {
    const line = appendThreadOwner('- earlier\n', AT, 'first rule\n\nsecond rule');
    expect(line).toBe(`- earlier\n- '2026-11-03T09:01:00.000Z' owner — first rule second rule\n`);
  });

  it('refuses an empty message', () => {
    expect(() => appendThreadOwner('', AT, '   \n  ')).toThrow('non-empty');
  });
});

describe('parseThread', () => {
  it('reads the owner messages back, file order', () => {
    const text = [
      '---',
      'title: "Pia"',
      "created: '2026-11-03T09:00:00.000Z'",
      '---',
      '',
      "- '2026-11-03T09:01:00.000Z' owner — first lesson",
      "- '2026-11-03T09:05:00.000Z' owner — second lesson",
      '',
    ].join('\n');
    expect(parseThread(text)).toEqual([
      { at: '2026-11-03T09:01:00.000Z', role: 'owner', text: 'first lesson' },
      { at: '2026-11-03T09:05:00.000Z', role: 'owner', text: 'second lesson' },
    ]);
  });

  it('skips broken lines and stray prose, never guesses', () => {
    const text = [
      '---',
      'title: "Pia"',
      '---',
      '',
      'hand-written prose between messages',
      '- broken line without a stamp',
      "- '2026-11-03T09:01:00.000Z' owner — the one readable message",
    ].join('\n');
    expect(parseThread(text)).toEqual([{ at: '2026-11-03T09:01:00.000Z', role: 'owner', text: 'the one readable message' }]);
  });

  it('reads a headerless file too, and an empty file as no messages', () => {
    expect(parseThread("- '2026-11-03T09:01:00.000Z' owner — only the line\n")).toEqual([
      { at: '2026-11-03T09:01:00.000Z', role: 'owner', text: 'only the line' },
    ]);
    expect(parseThread('---\ntitle: "Pia"\n---\n\n')).toEqual([]);
    expect(parseThread('')).toEqual([]);
  });
});
