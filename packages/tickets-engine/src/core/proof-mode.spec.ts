import { describe, expect, it } from 'vitest';
import { parseProofDeclaration, parseProofMode, resolveProofMode } from './proof-mode';

const ticket = (handover: string): string => `---\nid: T-1\n---\n\n## Plan\n\nproof: tests — in the plan, ignored\n\n## Handover\n\n${handover}\n\n## Log\n`;

describe('parseProofMode', () => {
  it('reads only the two words', () => {
    expect(parseProofMode('ui')).toBe('ui');
    expect(parseProofMode(' Tests ')).toBe('tests');
    expect(parseProofMode('both')).toBeNull();
    expect(parseProofMode(3)).toBeNull();
  });
});

describe('parseProofDeclaration', () => {
  it('reads the mode and the reason from the Handover', () => {
    expect(parseProofDeclaration(ticket('proof: ui — the settings page changes'))).toEqual({
      mode: 'ui',
      reason: 'the settings page changes',
    });
  });

  it('tolerates a bullet, a hyphen and no reason', () => {
    expect(parseProofDeclaration(ticket('- proof: tests - only the parser changed'))?.mode).toBe('tests');
    expect(parseProofDeclaration(ticket('proof: tests'))).toEqual({ mode: 'tests', reason: null });
  });

  it('lets the last declaration win (the reviewer corrects)', () => {
    const text = ticket('proof: tests — pure logic\nproof: ui — review: the card renders it');
    expect(parseProofDeclaration(text)).toEqual({ mode: 'ui', reason: 'review: the card renders it' });
  });

  it('ignores an unknown word, a missing line and a missing section', () => {
    expect(parseProofDeclaration(ticket('proof: maybe — unsure'))).toBeNull();
    expect(parseProofDeclaration(ticket('nothing here'))).toBeNull();
    expect(parseProofDeclaration('## Plan\n\nproof: ui\n')).toBeNull();
  });
});

describe('resolveProofMode', () => {
  it('lets the pin beat the declaration', () => {
    expect(resolveProofMode('ui', ticket('proof: tests — x'))).toEqual({ mode: 'ui', source: 'pin', reason: 'x' });
  });

  it('uses the declaration without a pin', () => {
    expect(resolveProofMode(null, ticket('proof: tests — x'))).toEqual({ mode: 'tests', source: 'handover', reason: 'x' });
  });

  it('defaults to ui when nothing is readable', () => {
    expect(resolveProofMode(null, ticket('garbled'))).toEqual({ mode: 'ui', source: 'default', reason: null });
  });
});
