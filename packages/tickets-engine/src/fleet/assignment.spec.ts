import { describe, expect, it } from 'vitest';
import { composeInstruction } from './assignment';

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
