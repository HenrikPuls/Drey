import { describe, expect, it } from 'vitest';
import { composeInstruction, composeScoutInstruction } from './assignment';

/**
 * The instruction composer's persona memory seam (E3, ADR-0088): the
 * sliced `## Memory` section (sliced by `context-pack`'s
 * `personaMemorySection`) rides the variable tail — the stable prefix
 * must not move with a persona's lessons (the T-0048 rule).
 */

function base(over: Partial<Parameters<typeof composeInstruction>[0]> = {}): Parameters<typeof composeInstruction>[0] {
  return {
    ticketId: 'T-0001',
    title: 'Add the thing',
    repo: 'drey',
    branch: 't/T-0001',
    worktreePath: 'W:/wt/T-0001',
    phase: 'plan',
    description: 'It should work.',
    plan: null,
    prompt: null,
    acceptance: ['npm run verify:unit'],
    repoInstructions: null,
    diffStat: null,
    gateFailure: null,
    caps: { gateFailureLines: 40, gateFailureBytes: 4_096, diffStatLines: 50, diffStatBytes: 4_096 },
    ...over,
  };
}

describe('composeInstruction — the persona memory section (E3)', () => {
  it('splices the section into the variable tail and the continuation', () => {
    const composed = composeInstruction(base({ memorySection: '## Memory\n\n- one lesson' }));
    expect(composed.text).toContain('## Memory');
    expect(composed.text).toContain('- one lesson');
    expect(composed.continuation).toContain('## Memory');
    expect(composed.continuation).toContain('- one lesson');
  });

  it('the stable prefix stays byte-identical with and without a section', () => {
    const without = composeInstruction(base({}));
    const withMemory = composeInstruction(base({ memorySection: '## Memory\n\n- one lesson' }));
    expect(without.text).not.toContain('## Memory');
    const cutAt = (text: string): string => text.slice(0, text.indexOf('You are working ticket'));
    expect(cutAt(withMemory.text)).toBe(cutAt(without.text));
  });

  it('an empty or absent section is no section at all', () => {
    const empty = composeInstruction(base({ memorySection: '' }));
    expect(empty.text).not.toContain('## Memory');
    const absent = composeInstruction(base({}));
    expect(absent.text).not.toContain('## Memory');
  });
});

describe('composeScoutInstruction (E8, concept §5.6)', () => {
  function scoutBase(over: Partial<Parameters<typeof composeScoutInstruction>[0]> = {}): Parameters<typeof composeScoutInstruction>[0] {
    return {
      ticketId: 'T-0004',
      title: 'Which storage should back the index?',
      readGround: 'W:/drey',
      repoName: 'drey',
      ticketFile: 'V:/tickets/tickets/prioritized/T-0004.md',
      phase: 'prioritized',
      description: 'The repo carries two index implementations.',
      plan: null,
      prompt: null,
      repoInstructions: null,
      ...over,
    };
  }

  it('names the read ground read-only and the ticket file as the one writable place', () => {
    const composed = composeScoutInstruction(scoutBase());
    expect(composed.text).toContain('You are scouting ticket T-0004');
    expect(composed.text).toContain('Read ground: W:/drey (the "drey" checkout) — read-only; never write there.');
    expect(composed.text).toContain('V:/tickets/tickets/prioritized/T-0004.md — the ONE file you may edit');
    expect(composed.text).toContain('The ticket sits in the "prioritized" phase');
    expect(composed.text).toContain('The repo carries two index implementations.');
    // No ship furniture: no work checkout, no branch, no gate, no move.
    expect(composed.text).not.toContain('Work checkout');
    expect(composed.text).not.toContain('Completion discipline');
    expect(composed.text).not.toContain('machine gate runs exactly these');
  });

  it('the vault is the read ground when the ticket names no repo', () => {
    const composed = composeScoutInstruction(scoutBase({ readGround: 'V:/tickets', repoName: null }));
    expect(composed.text).toContain('Read ground: V:/tickets (the tickets vault) — read-only; never write there.');
  });

  it('spells the report shape out: headings verbatim, unchecked decisions with recommendations', () => {
    const composed = composeScoutInstruction(scoutBase());
    expect(composed.text).toContain('## Report');
    expect(composed.text).toContain('Written on <UTC stamp, YYYY-MM-DDTHH:mm:ssZ> by scout.');
    expect(composed.text).toContain('### Summary');
    expect(composed.text).toContain('### Decisions');
    expect(composed.text).toContain('- [ ] D1: <the question the owner must decide> — Recommendation: <your recommendation>');
    expect(composed.text).toContain('Scout discipline');
    expect(composed.text).toContain('QUESTION:'); // the asking protocol rides the scout too
  });

  it('a resolved persona signs the Written-on line and rides as the prompt and memory', () => {
    const composed = composeScoutInstruction(
      scoutBase({ personaId: 'pia', prompt: 'You are Pia.', memorySection: '## Memory\n\n- one lesson' }),
    );
    expect(composed.text).toContain('Written on <UTC stamp, YYYY-MM-DDTHH:mm:ssZ> by pia.');
    expect(composed.text.indexOf('You are Pia.')).toBeLessThan(composed.text.indexOf('You are scouting ticket'));
    expect(composed.text).toContain('## Memory');
    // The repo's agent instructions stay the verbatim head of the pack.
    const withRules = composeScoutInstruction(scoutBase({ repoInstructions: '# Repo rules' }));
    expect(withRules.text.startsWith('# Repo rules')).toBe(true);
  });

  it('names further repos as read-only grounds, never prepared worktrees', () => {
    const composed = composeScoutInstruction(
      scoutBase({ extraRepos: [{ name: 'lariscus', path: 'E:/code/lariscus' }] }),
    );
    expect(composed.text).toContain('- lariscus: E:/code/lariscus (read-only)');
    expect(composed.text).not.toContain('prepared as its own worktree');
  });

  it('the continuation reminds, never re-briefs: shape stands, full brief stays in history', () => {
    const composed = composeScoutInstruction(scoutBase({ repoInstructions: '# Repo rules' }));
    expect(composed.continuation).toContain('resuming the exploration of ticket T-0004');
    expect(composed.continuation).not.toContain('# Repo rules');
    expect(composed.continuation).toContain('The report\'s shape stands');
    expect(composed.continuation.length).toBeLessThan(composed.text.length);
  });

  it('the stable digest separates scout from ship and moves with prompt and plan', () => {
    const first = composeScoutInstruction(scoutBase());
    const same = composeScoutInstruction(scoutBase({ memorySection: '## Memory\n\n- lesson' }));
    expect(same.stable).toBe(first.stable); // memory is a variable part
    const otherPrompt = composeScoutInstruction(scoutBase({ prompt: 'Other.' }));
    expect(otherPrompt.stable).not.toBe(first.stable);
    const otherGround = composeScoutInstruction(scoutBase({ readGround: 'W:/other' }));
    expect(otherGround.stable).not.toBe(first.stable);
  });

  it('a dialog on a scout ticket swaps the discipline, keeps the exploration frame', () => {
    const composed = composeScoutInstruction(scoutBase({ interactive: 'plan' }));
    expect(composed.text).toContain('Dialog discipline');
    expect(composed.text).not.toContain('Scout discipline');
    expect(composed.text).toContain('You are scouting ticket T-0004');
  });
});
