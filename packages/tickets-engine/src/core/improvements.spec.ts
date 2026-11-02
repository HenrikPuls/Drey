import { describe, expect, it } from 'vitest';
import {
  nextImprovementId,
  parseFriction,
  parseImprovements,
  renderImprovements,
  validateDraft,
  type ImprovementsFile,
} from './improvements';

describe('parseFriction', () => {
  it('reads the strict line shape and forgives the rest', () => {
    const lines = parseFriction(
      '- 2026-11-01 · T-0007 · guessed the order.md shape\n- 2026-11-02 · Context pack missed the ledger\nnot a friction line\n- · broken\n',
    );
    expect(lines).toEqual([
      { at: '2026-11-01', ticket: 'T-0007', text: 'guessed the order.md shape' },
      { at: '2026-11-02', ticket: null, text: 'Context pack missed the ledger' },
    ]);
  });
});

const FILE: ImprovementsFile = {
  lastAggregation: '2026-11-02T10:00:00Z',
  proposals: [
    {
      id: 'imp-1',
      state: 'open',
      target: 'prompt.md',
      title: 'Order the context pack by name',
      evidence: ['2026-11-01 · T-0007 · guessed the order.md shape'],
      content: 'You build in the ticket worktree.\nRead the pack first.',
      lesson: 'Keep the pack recipe explicit.',
      at: '2026-11-02T10:00:00Z',
      decidedAt: null,
    },
    {
      id: 'imp-2',
      state: 'dismissed',
      target: 'models.default',
      title: 'Try sonnet as default',
      evidence: [],
      content: 'sonnet',
      lesson: null,
      at: '2026-11-02T10:00:00Z',
      decidedAt: '2026-11-02T11:00:00Z',
    },
  ],
};

describe('renderImprovements / parseImprovements round-trip', () => {
  it('round-trips the canonical file', () => {
    const text = renderImprovements('pia', FILE);
    expect(parseImprovements(text)).toEqual(FILE);
  });

  it('reads a hand-edited file tolerantly and skips broken proposals', () => {
    const text = `${renderImprovements('pia', FILE)}\n- imp-9 open bogus.target — Sneaky\n  - content:\n      x\n`;
    const parsed = parseImprovements(text);
    expect(parsed.proposals).toHaveLength(2);
    expect(nextImprovementId(text)).toBe('imp-10');
  });

  it('reads an absent file as empty', () => {
    expect(parseImprovements('')).toEqual({ lastAggregation: null, proposals: [] });
  });
});

describe('validateDraft', () => {
  it('accepts a sane aggregator output', () => {
    expect(
      validateDraft({ target: 'prompt.md', title: 'T', evidence: ['e'], content: 'new text', lesson: 'l' }),
    ).toEqual({ target: 'prompt.md', title: 'T', evidence: ['e'], content: 'new text', lesson: 'l' });
  });

  it('refuses unknown targets, empty content and oversize payloads', () => {
    expect(validateDraft({ target: 'worker', title: 'T', content: 'x' })).toBeNull();
    expect(validateDraft({ target: 'prompt.md', title: 'T', content: '   ' })).toBeNull();
    expect(validateDraft({ target: 'prompt.md', title: '', content: 'x' })).toBeNull();
    expect(validateDraft({ target: 'prompt.md', title: 'T', content: 'x'.repeat(9000) })).toBeNull();
  });
});
