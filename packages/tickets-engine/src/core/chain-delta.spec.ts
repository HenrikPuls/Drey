/**
 * The `chain:` delta's grammar, rendering, merge and write-guard
 * (E9, concept §5.7): strict parse with a clean round trip, tolerant
 * merge for renderers, and a semantic guard that only writes pass.
 */
import { describe, expect, it } from 'vitest';
import { mergeChain, parseChainEntry, renderChainEntry, renderChainEntries, validateChain } from './chain-delta';

const PHASES = [
  { id: 'inbox', title: 'Inbox' },
  { id: 'build', title: 'Build' },
  { id: 'review', title: 'Review' },
  { id: 'verify', title: 'Verify' },
  { id: 'needs-owner', title: 'Needs you' },
  { id: 'done', title: 'Done' },
];

// The same flow with a design gate — the realistic insert target.
const PHASES_WITH_DESIGN = [
  { id: 'inbox', title: 'Inbox' },
  { id: 'build', title: 'Build' },
  { id: 'review', title: 'Review' },
  { id: 'design', title: 'Design' },
  { id: 'verify', title: 'Verify' },
  { id: 'needs-owner', title: 'Needs you' },
  { id: 'done', title: 'Done' },
];

describe('parseChainEntry', () => {
  it('parses the three entry kinds', () => {
    expect(parseChainEntry('skip verify')).toEqual({ kind: 'skip', phase: 'verify' });
    expect(parseChainEntry('notify build')).toEqual({ kind: 'notify', phase: 'build' });
    expect(parseChainEntry('insert design after review')).toEqual({
      kind: 'insert',
      phase: 'design',
      anchor: 'review',
      position: 'after',
      persona: null,
      notify: false,
    });
  });

  it('parses the parenthesised options in any order', () => {
    expect(parseChainEntry('insert design(pia, notify) after review')).toEqual({
      kind: 'insert',
      phase: 'design',
      anchor: 'review',
      position: 'after',
      persona: 'pia',
      notify: true,
    });
    expect(parseChainEntry('insert design(notify, pia) before verify')).toEqual({
      kind: 'insert',
      phase: 'design',
      anchor: 'verify',
      position: 'before',
      persona: 'pia',
      notify: true,
    });
  });

  it('refuses everything outside the grammar', () => {
    expect(parseChainEntry('insert design after review extra')).toBeNull();
    expect(parseChainEntry('insert Design after review')).toBeNull();
    expect(parseChainEntry('insert design(PIA!) after review')).toBeNull();
    expect(parseChainEntry('insert design(pia, bogus) after review')).toBeNull();
    expect(parseChainEntry('skip')).toBeNull();
    expect(parseChainEntry('notify verify now')).toBeNull();
    expect(parseChainEntry('delete verify')).toBeNull();
    expect(parseChainEntry('')).toBeNull();
  });
});

describe('renderChainEntry', () => {
  it('round-trips every entry the parser accepts', () => {
    for (const text of [
      'skip verify',
      'notify build',
      'insert design after review',
      'insert design(pia, notify) after review',
      'insert design(notify) before verify',
    ]) {
      expect(renderChainEntry(parseChainEntry(text)!)).toBe(text);
    }
    expect(renderChainEntries(['skip verify'].map((t) => parseChainEntry(t)!))).toEqual(['skip verify']);
  });
});

describe('mergeChain', () => {
  it('marks past/current/future on the standard flow', () => {
    const steps = mergeChain(PHASES, 'review', []);
    expect(steps.map((s) => s.state)).toEqual(['past', 'past', 'current', 'future', 'future', 'future']);
    expect(steps.every((s) => !s.inserted && !s.skipped && !s.notify)).toBe(true);
  });

  it('inserts, skips and notifies in one merge', () => {
    const steps = mergeChain(PHASES, 'build', [
      parseChainEntry('insert design(pia, notify) after review')!,
      parseChainEntry('skip verify')!,
    ]);
    expect(steps.map((s) => s.phase)).toEqual(['inbox', 'build', 'review', 'design', 'verify', 'needs-owner', 'done']);
    const design = steps[3]!;
    expect(design.inserted).toBe(true);
    expect(design.persona).toBe('pia');
    expect(design.notify).toBe(true);
    expect(steps[4]!.skipped).toBe(true);
    expect(steps[1]!.state).toBe('current');
    expect(steps[2]!.state).toBe('future');
  });

  it('inserts before the anchor and tolerates an unknown anchor by appending', () => {
    const before = mergeChain(PHASES, 'inbox', [parseChainEntry('insert design before build')!]);
    expect(before.map((s) => s.phase).slice(0, 3)).toEqual(['inbox', 'design', 'build']);
    const floating = mergeChain(PHASES, 'inbox', [parseChainEntry('insert design after nowhere')!]);
    expect(floating[floating.length - 1]!.phase).toBe('design');
  });
});

describe('validateChain', () => {
  it('passes a sound delta', () => {
    expect(
      validateChain(PHASES_WITH_DESIGN, 'build', [
        parseChainEntry('insert design after review')!,
        parseChainEntry('notify verify')!,
      ]),
    ).toBeNull();
  });

  it('refuses unknown phases and anchors', () => {
    expect(validateChain(PHASES_WITH_DESIGN, 'build', [parseChainEntry('insert design after nowhere')!])).toBe(
      'the pipeline has no phase "nowhere"',
    );
    expect(validateChain(PHASES, 'build', [parseChainEntry('skip nowhere')!])).toBe('the pipeline has no phase "nowhere"');
    expect(validateChain(PHASES, 'build', [parseChainEntry('insert design after review')!])).toBe(
      'the pipeline has no phase "design"',
    );
  });

  it('refuses a doubled revisit and a self-anchored insert', () => {
    expect(
      validateChain(PHASES_WITH_DESIGN, 'inbox', [
        parseChainEntry('insert design after build')!,
        parseChainEntry('insert design after review')!,
      ]),
    ).toContain('inserted twice');
    expect(validateChain(PHASES_WITH_DESIGN, 'inbox', [parseChainEntry('insert design after design')!])).toContain(
      'cannot anchor its own insert',
    );
    expect(
      validateChain(PHASES_WITH_DESIGN, 'inbox', [
        parseChainEntry('insert design after build')!,
        parseChainEntry('skip design')!,
      ]),
    ).toContain('both skipped and inserted');
  });

  it('allows one revisit of a standard gate', () => {
    // design sits in the standard flow — inserting it again is a front-loaded
    // revisit, the honest reading of "insert design after review".
    expect(
      validateChain(PHASES_WITH_DESIGN, 'build', [parseChainEntry('insert design(notify) after review')!]),
    ).toBeNull();
  });

  it('refuses skips and anchors in the past', () => {
    expect(validateChain(PHASES_WITH_DESIGN, 'review', [parseChainEntry('skip build')!])).toContain('past gate');
    expect(validateChain(PHASES_WITH_DESIGN, 'review', [parseChainEntry('insert design after build')!])).toContain(
      'past gate',
    );
    expect(validateChain(PHASES_WITH_DESIGN, 'review', [parseChainEntry('notify build')!])).toContain(
      'already completed',
    );
  });

  it('allows the current gate as a notify and a skip of a future gate', () => {
    expect(validateChain(PHASES, 'build', [parseChainEntry('notify build')!])).toBeNull();
    expect(validateChain(PHASES, 'build', [parseChainEntry('skip verify')!])).toBeNull();
  });
});
