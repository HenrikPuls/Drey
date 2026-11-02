import { describe, expect, it } from 'vitest';
import { canSaveOf, discardArmOf, isDirtyOf } from './edit';

const TICKET = '---\nid: T-0001\n---\n# Title\n';

describe('isDirtyOf', () => {
  it('is clean when the draft equals the loaded text', () => {
    expect(isDirtyOf(TICKET, TICKET)).toBe(false);
  });

  it('is dirty when one character differs', () => {
    expect(isDirtyOf(TICKET, TICKET.replace('Title', 'Titles'))).toBe(true);
  });

  it('is dirty on a stray trailing newline — a raw file is parsed byte-for-byte', () => {
    expect(isDirtyOf(TICKET, `${TICKET}\n`)).toBe(true);
  });

  it('is clean when both sides are empty', () => {
    expect(isDirtyOf('', '')).toBe(false);
  });

  it('is dirty when the draft drops content', () => {
    expect(isDirtyOf(TICKET, '---\nid: T-0001\n')).toBe(true);
  });
});

describe('canSaveOf', () => {
  it('refuses a clean draft even when it holds content', () => {
    expect(canSaveOf(TICKET, TICKET)).toBe(false);
  });

  it('allows a dirty draft with content', () => {
    expect(canSaveOf(TICKET, `${TICKET}more\n`)).toBe(true);
  });

  it('refuses an empty draft — an empty file is not a ticket', () => {
    expect(canSaveOf(TICKET, '')).toBe(false);
  });

  it('refuses a whitespace-only draft', () => {
    expect(canSaveOf(TICKET, '   \n\n ')).toBe(false);
  });

  it('refuses when both sides are empty', () => {
    expect(canSaveOf('', '')).toBe(false);
  });
});

describe('discardArmOf', () => {
  it('arms on the first tap without confirming', () => {
    expect(discardArmOf('idle', 'tap')).toEqual({ state: 'armed', confirmed: false });
  });

  it('confirms on the second tap and disarms behind the close', () => {
    expect(discardArmOf('armed', 'tap')).toEqual({ state: 'idle', confirmed: true });
  });

  it('a reset keeps the idle state unconfirmed', () => {
    expect(discardArmOf('idle', 'reset')).toEqual({ state: 'idle', confirmed: false });
  });

  it('a reset disarms an armed question — an edit answers it', () => {
    expect(discardArmOf('armed', 'reset')).toEqual({ state: 'idle', confirmed: false });
  });

  it('a reset really clears the arm: the next tap arms again instead of confirming', () => {
    const armed = discardArmOf('idle', 'tap');
    const reset = discardArmOf(armed.state, 'reset');
    expect(discardArmOf(reset.state, 'tap')).toEqual({ state: 'armed', confirmed: false });
  });
});
