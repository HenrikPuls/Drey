/**
 * The flow editor's pure half (E10-5): the grammar's `move` / `assign`
 * entries, and edits on the merged chain written back as the smallest
 * delta that merges to the same chain.
 */
import { describe, expect, it } from 'vitest';
import type { ChainEntry } from '../contracts/chain';
import { mergeChain, parseChainEntry, renderChainEntry, validateChain } from './chain-delta';
import { applyFlowOp, entriesFromSteps, type FlowOp } from './flow-edit';

const PHASES = [
  { id: 'inbox', title: 'Inbox' },
  { id: 'build', title: 'Build' },
  { id: 'review', title: 'Review' },
  { id: 'verify', title: 'Verify' },
  { id: 'approve', title: 'Approve' },
  { id: 'security', title: 'Security' },
  { id: 'done', title: 'Done' },
];

function entries(...raw: string[]): ChainEntry[] {
  return raw.map((r) => {
    const e = parseChainEntry(r);
    if (e === null) {
      throw new Error(`unreadable: ${r}`);
    }
    return e;
  });
}

function order(chain: readonly ChainEntry[], current = 'build'): string[] {
  return mergeChain(PHASES, current, chain).map((s) => `${s.phase}${s.inserted ? '+' : ''}${s.skipped ? '-' : ''}`);
}

function run(chain: readonly string[], edit: FlowOp, current = 'build'): { chain: string[]; entries: ChainEntry[] } {
  const result = applyFlowOp(PHASES, current, entries(...chain), edit);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { chain: [...result.chain], entries: [...result.entries] };
}

function refusal(chain: readonly string[], edit: FlowOp, current = 'build'): string {
  const result = applyFlowOp(PHASES, current, entries(...chain), edit);
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return result.error;
}

describe('move and assign entries', () => {
  it('round-trip through the grammar', () => {
    expect(parseChainEntry('move verify before review')).toEqual({ kind: 'move', phase: 'verify', anchor: 'review', position: 'before' });
    expect(parseChainEntry('assign review tessa')).toEqual({ kind: 'assign', phase: 'review', persona: 'tessa' });
    for (const raw of ['move verify after approve', 'assign review tessa']) {
      expect(renderChainEntry(parseChainEntry(raw)!)).toBe(raw);
    }
    expect(parseChainEntry('move verify review')).toBeNull();
    expect(parseChainEntry('assign review')).toBeNull();
  });

  it('merge: a moved gate lands at its anchor and is marked; an assign pins the persona', () => {
    const steps = mergeChain(PHASES, 'build', entries('move verify before review', 'assign approve ralf'));
    expect(steps.map((s) => s.phase)).toEqual(['inbox', 'build', 'verify', 'review', 'approve', 'security', 'done']);
    expect(steps.find((s) => s.phase === 'verify')!.moved).toBe(true);
    expect(steps.find((s) => s.phase === 'approve')!.persona).toBe('ralf');
  });

  it('the write guard refuses moves and assigns that do not reach the future', () => {
    expect(validateChain(PHASES, 'review', entries('move build after verify'))).toMatch(/future gates/);
    expect(validateChain(PHASES, 'review', entries('move verify before review'))).toMatch(/ahead of the current gate/);
    expect(validateChain(PHASES, 'build', entries('move verify after approve', 'move verify after review'))).toMatch(/moved twice/);
    expect(validateChain(PHASES, 'build', entries('move verify after verify'))).toMatch(/next to itself/);
    expect(validateChain(PHASES, 'build', entries('skip verify', 'move verify after approve'))).toMatch(/both skipped and moved/);
    expect(validateChain(PHASES, 'build', entries('insert verify after review', 'move verify after approve'))).toMatch(/inserted by this ticket/);
    expect(validateChain(PHASES, 'review', entries('assign build ben'))).toMatch(/future gates/);
    expect(validateChain(PHASES, 'build', entries('assign verify ralf', 'assign verify ben'))).toMatch(/two personas/);
    expect(validateChain(PHASES, 'build', entries('move verify after approve', 'assign review tessa'))).toBeNull();
  });
});

describe('applyFlowOp', () => {
  it('insert after a step is the security-pass delta', () => {
    const { chain } = run([], { op: 'insert', phase: 'security', after: 2 });
    expect(chain).toEqual(['insert security after review']);
    const withPins = run(chain, { op: 'persona', step: 3, persona: 'ralf' });
    expect(withPins.chain).toEqual(['insert security(ralf) after review']);
    expect(run(withPins.chain, { op: 'notify', step: 3, on: true }).chain).toEqual(['insert security(ralf, notify) after review']);
  });

  it('remove strikes a standard gate and drops an inserted one; restore undoes the strike', () => {
    const struck = run([], { op: 'remove', step: 3 });
    expect(struck.chain).toEqual(['skip verify']);
    expect(run(struck.chain, { op: 'restore', step: 3 }).chain).toEqual([]);
    const added = ['insert security(ralf, notify) after review'];
    expect(run(added, { op: 'remove', step: 3 }).chain).toEqual([]);
  });

  it('move later / earlier regenerates a minimal move and goes back to nothing', () => {
    const later = run([], { op: 'move', step: 2, dir: 1 }); // review after verify
    expect(order(later.entries)).toEqual(['inbox', 'build', 'verify', 'review', 'approve', 'security', 'done']);
    expect(later.chain).toHaveLength(1);
    const back = run(later.chain, { op: 'move', step: 3, dir: -1 });
    expect(back.chain).toEqual([]);
  });

  it('moves an inserted gate by changing its anchor, with dependants following', () => {
    const base = ['insert security after review', 'insert verify(tessa) after security'];
    const moved = run(base, { op: 'move', step: 3, dir: 1 }); // security below the verify revisit
    expect(order(moved.entries)).toEqual(['inbox', 'build', 'review', 'verify+', 'security+', 'verify', 'approve', 'security', 'done']);
  });

  it('refuses edits on the running gate, behind it and next to it', () => {
    expect(refusal([], { op: 'remove', step: 1 })).toMatch(/the current gate/);
    expect(refusal([], { op: 'move', step: 2, dir: -1 })).toMatch(/has begun/);
    expect(refusal([], { op: 'notify', step: 0, on: true })).toMatch(/done/);
    expect(refusal([], { op: 'insert', phase: 'security', after: 0 })).toMatch(/done/);
  });

  it('refuses a second insert of one phase, an insert of a struck one and an unknown phase', () => {
    expect(refusal(['insert security after review'], { op: 'insert', phase: 'security', after: 4 })).toMatch(/at most once/);
    expect(refusal(['skip verify'], { op: 'insert', phase: 'verify', after: 2 })).toMatch(/restore it instead/);
    expect(refusal([], { op: 'insert', phase: 'design', after: 2 })).toMatch(/no phase "design"/);
  });

  it('a struck gate that was moved goes back to its standard place (strike and move never combine)', () => {
    const moved = run([], { op: 'move', step: 3, dir: 1 }); // verify after approve
    const idx = mergeChain(PHASES, 'build', moved.entries).findIndex((s) => s.phase === 'verify');
    const struck = run(moved.chain, { op: 'remove', step: idx });
    expect(struck.chain).toEqual(['skip verify']);
  });

  it('reset and view', () => {
    expect(run(['skip verify'], { op: 'reset' }).chain).toEqual([]);
    expect(run(['notify review', 'skip verify'], { op: 'view' }).chain).toEqual(['skip verify', 'notify review']);
  });

  it('persona on a standard gate is an assign, and null removes it', () => {
    const pinned = run([], { op: 'persona', step: 2, persona: 'tessa' });
    expect(pinned.chain).toEqual(['assign review tessa']);
    expect(run(pinned.chain, { op: 'persona', step: 2, persona: null }).chain).toEqual([]);
  });

  it('every produced delta merges back to the edited chain (property over a walk of edits)', () => {
    let chain: string[] = [];
    const ops: FlowOp[] = [
      { op: 'insert', phase: 'security', after: 2 },
      { op: 'move', step: 2, dir: 1 },
      { op: 'notify', step: 4, on: true },
      { op: 'remove', step: 4 },
      { op: 'persona', step: 5, persona: 'ralf' },
      { op: 'move', step: 3, dir: 1 },
      { op: 'move', step: 4, dir: 1 },
    ];
    for (const op of ops) {
      const next = applyFlowOp(PHASES, 'build', entries(...chain), op);
      if (!next.ok) {
        continue; // refused edits leave the draft alone
      }
      expect(validateChain(PHASES, 'build', next.entries)).toBeNull();
      const again = applyFlowOp(PHASES, 'build', next.entries, { op: 'view' });
      expect(again.ok && again.chain).toEqual(next.chain);
      chain = [...next.chain];
    }
    expect(chain.length).toBeGreaterThan(0);
  });
});

describe('entriesFromSteps', () => {
  it('keeps the longest in-order run silent and moves the rest', () => {
    const steps = mergeChain(PHASES, 'build', entries('move inbox after done')); // an odd but valid arrangement
    const regenerated = entriesFromSteps(PHASES, steps).map(renderChainEntry);
    expect(regenerated).toEqual(['move inbox after done']);
  });
});
